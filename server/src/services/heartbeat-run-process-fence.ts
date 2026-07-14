import { and, eq } from "drizzle-orm";
import {
  agents,
  approvalExecutionClaims,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import {
  isPidAlive,
  isProcessGroupAlive,
  terminateLocalService,
} from "./local-service-supervisor.js";
import {
  type LocalProcessIdentity,
  verifyStoredLocalProcessIdentity,
} from "./local-process-identity.js";
import { lockAgentLifecycleReference } from "./agent-lifecycle-fence.js";

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

export type HeartbeatRunProcessFenceContext = {
  db: Db;
  agent: AgentRow;
  run: HeartbeatRunRow;
};

export type HeartbeatRunProcessFenceHooks<T> = {
  validateLocked?: (context: HeartbeatRunProcessFenceContext) => Promise<void>;
  terminalize?: (
    context: HeartbeatRunProcessFenceContext & { now: Date },
  ) => Promise<T>;
};

export type HeartbeatRunProcessFenceResult<T> = {
  exited: boolean;
  signalCount: number;
  terminalized: T | null;
};

class ProcessExitedBeforeSignal extends Error {
  constructor() {
    super("Heartbeat process exited before its authorized signal");
  }
}

function sameDate(left: Date | null, right: Date | null) {
  return left?.toISOString() === right?.toISOString();
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function assertExactRunFenceBinding(current: HeartbeatRunRow, expected: HeartbeatRunRow) {
  if (
    current.id !== expected.id
    || current.companyId !== expected.companyId
    || current.agentId !== expected.agentId
    || current.status !== expected.status
    || current.invocationSource !== expected.invocationSource
    || current.triggerDetail !== expected.triggerDetail
    || current.wakeupRequestId !== expected.wakeupRequestId
    || current.processPid !== expected.processPid
    || current.processGroupId !== expected.processGroupId
    || !sameDate(current.processStartedAt, expected.processStartedAt)
    || current.processExecutable !== expected.processExecutable
    || current.processCommandSha256 !== expected.processCommandSha256
    || !sameDate(current.startedAt, expected.startedAt)
    || !sameDate(current.finishedAt, expected.finishedAt)
    || !sameDate(current.updatedAt, expected.updatedAt)
    || stableJson(current.contextSnapshot) !== stableJson(expected.contextSnapshot)
  ) {
    throw conflict("Heartbeat run changed before process signal", {
      code: "heartbeat_run_signal_fence_drift",
      runId: expected.id,
    });
  }
}

function assertExactProcessIdentity(
  run: HeartbeatRunRow,
  expected: LocalProcessIdentity,
) {
  if (
    run.processPid !== expected.pid
    || run.processGroupId !== expected.processGroupId
    || run.processStartedAt?.toISOString() !== expected.processStartedAt
    || run.processExecutable !== expected.processExecutable
    || run.processCommandSha256 !== expected.processCommandSha256
  ) {
    throw conflict("Heartbeat process identity changed before signal", {
      code: "heartbeat_process_identity_drift",
      runId: run.id,
      manualInterventionRequired: true,
    });
  }
}

function processTargetAlive(identity: LocalProcessIdentity) {
  if (process.platform !== "win32" && identity.processGroupId > 0) {
    return isProcessGroupAlive(identity.processGroupId);
  }
  return isPidAlive(identity.pid);
}

async function waitForProcessExit(identity: LocalProcessIdentity, waitMs: number) {
  const deadline = Date.now() + Math.max(0, waitMs);
  while (processTargetAlive(identity) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processTargetAlive(identity);
}

async function lockFenceContext(
  db: Db,
  input: {
    expectedRun: HeartbeatRunRow;
    expectedAgentStatus?: string | null;
  },
) {
  const lockedAgentReference = await lockAgentLifecycleReference(db, {
    companyId: input.expectedRun.companyId,
    agentId: input.expectedRun.agentId,
    mode: "cleanup",
    allowMissingCleanup: false,
  });
  if (!lockedAgentReference) {
    throw conflict("Heartbeat agent disappeared before process signal", {
      code: "heartbeat_agent_signal_fence_drift",
      runId: input.expectedRun.id,
    });
  }
  const agent = await db
    .select()
    .from(agents)
    .where(and(
      eq(agents.id, input.expectedRun.agentId),
      eq(agents.companyId, input.expectedRun.companyId),
    ))
    .then((rows) => rows[0] ?? null);
  if (
    !agent
    || (
      input.expectedAgentStatus !== undefined
      && agent.status !== input.expectedAgentStatus
    )
  ) {
    throw conflict("Heartbeat agent lifecycle changed before process signal", {
      code: "heartbeat_agent_signal_fence_drift",
      runId: input.expectedRun.id,
    });
  }

  const run = await db
    .select()
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, input.expectedRun.id),
      eq(heartbeatRuns.companyId, input.expectedRun.companyId),
      eq(heartbeatRuns.agentId, input.expectedRun.agentId),
    ))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!run) {
    throw conflict("Heartbeat run disappeared before process signal", {
      code: "heartbeat_run_signal_fence_drift",
      runId: input.expectedRun.id,
    });
  }
  assertExactRunFenceBinding(run, input.expectedRun);

  const claims = await db
    .select()
    .from(approvalExecutionClaims)
    .where(and(
      eq(approvalExecutionClaims.companyId, run.companyId),
      eq(approvalExecutionClaims.agentId, run.agentId),
      eq(approvalExecutionClaims.executorRunId, run.id),
    ))
    .for("update");
  const executingClaim = claims.find((claim) => claim.status === "executing");
  if (executingClaim) {
    throw conflict("Heartbeat run owns an executing approval claim", {
      code: "heartbeat_approval_execution_claim_active",
      runId: run.id,
      approvalId: executingClaim.approvalId,
    });
  }

  return { db, agent, run };
}

async function finalizeExitedProcessWithinFence<T>(input: {
  db: Db;
  expectedRun: HeartbeatRunRow;
  expectedAgentStatus?: string | null;
  identity: LocalProcessIdentity;
  hooks: HeartbeatRunProcessFenceHooks<T>;
}) {
  return input.db.transaction(async (tx) => {
    const context = await lockFenceContext(tx as unknown as Db, input);
    assertExactProcessIdentity(context.run, input.identity);
    await input.hooks.validateLocked?.(context);
    if (processTargetAlive(input.identity)) {
      throw conflict("Heartbeat process is still live after termination", {
        code: "heartbeat_process_exit_unproven",
        runId: input.expectedRun.id,
        manualInterventionRequired: true,
      });
    }
    return input.hooks.terminalize
      ? input.hooks.terminalize({ ...context, now: new Date() })
      : null;
  });
}

/**
 * Signals a heartbeat-owned local process only while its Agent -> Run ->
 * Approval-Claim database fence is held. SIGTERM and SIGKILL each enter a new
 * transaction and repeat the complete binding and strong OS identity proof.
 * If the signal achieves a zero-live state, terminalization runs before that
 * same transaction releases its locks.
 */
export async function terminateHeartbeatRunProcessWithinFence<T>(input: {
  db: Db;
  expectedRun: HeartbeatRunRow;
  expectedAgentStatus?: string | null;
  identity: LocalProcessIdentity;
  graceMs?: number;
  hooks?: HeartbeatRunProcessFenceHooks<T>;
}): Promise<HeartbeatRunProcessFenceResult<T>> {
  const hooks = input.hooks ?? {};
  let signalCount = 0;
  let terminalized: T | null = null;

  try {
    await terminateLocalService(
      {
        pid: input.identity.pid,
        processGroupId: input.identity.processGroupId,
      },
      {
        forceAfterMs: 0,
        signalWithinFence: async (signal, sendSignal) => {
          const result = await input.db.transaction(async (tx) => {
            const context = await lockFenceContext(tx as unknown as Db, input);
            assertExactProcessIdentity(context.run, input.identity);
            await hooks.validateLocked?.(context);
            const verification = await verifyStoredLocalProcessIdentity(context.run);
            if (verification.kind === "not_running") throw new ProcessExitedBeforeSignal();
            if (verification.kind !== "verified") {
              throw conflict("Heartbeat process identity could not be proven inside signal fence", {
                code: "heartbeat_process_identity_unproven",
                runId: context.run.id,
                reason: verification.reason,
                manualInterventionRequired: true,
              });
            }
            assertExactProcessIdentity(context.run, verification.identity);
            sendSignal();
            const exited = await waitForProcessExit(
              input.identity,
              signal === "SIGTERM" ? (input.graceMs ?? 2_000) : 1_000,
            );
            const finalized = exited && hooks.terminalize
              ? await hooks.terminalize({ ...context, now: new Date() })
              : null;
            return { exited, finalized };
          });
          signalCount += 1;
          if (result.finalized !== null) terminalized = result.finalized;
        },
      },
    );
  } catch (error) {
    if (!(error instanceof ProcessExitedBeforeSignal)) throw error;
  }

  if (terminalized === null && !processTargetAlive(input.identity)) {
    terminalized = await finalizeExitedProcessWithinFence({ ...input, hooks });
  }
  const exited = !processTargetAlive(input.identity);
  if (!exited) {
    throw conflict("Heartbeat process termination did not reach a zero-live state", {
      code: "heartbeat_process_exit_unproven",
      runId: input.expectedRun.id,
      manualInterventionRequired: true,
    });
  }
  return { exited, signalCount, terminalized };
}

export async function finalizeHeartbeatRunWithoutSignalWithinFence<T>(input: {
  db: Db;
  expectedRun: HeartbeatRunRow;
  expectedAgentStatus?: string | null;
  allowManualReconcileUnprovenTarget?: boolean;
  hooks: HeartbeatRunProcessFenceHooks<T>;
}) {
  return input.db.transaction(async (tx) => {
    const context = await lockFenceContext(tx as unknown as Db, input);
    await input.hooks.validateLocked?.(context);
    if (context.run.processPid || context.run.processGroupId) {
      const verification = await verifyStoredLocalProcessIdentity(context.run);
      const processGroupAlive = Boolean(
        context.run.processGroupId
        && isProcessGroupAlive(context.run.processGroupId),
      );
      if (verification.kind === "verified") {
        throw conflict("Heartbeat process requires a fenced signal before terminalization", {
          code: "heartbeat_process_signal_required",
          runId: context.run.id,
        });
      }
      if (
        (verification.kind === "unproven" || processGroupAlive)
        && !input.allowManualReconcileUnprovenTarget
      ) {
        throw conflict("Heartbeat process identity is unproven", {
          code: "heartbeat_process_identity_unproven",
          runId: context.run.id,
          reason: verification.kind === "unproven"
            ? verification.reason
            : "owner_pid_not_running_group_alive",
          manualInterventionRequired: true,
        });
      }
    }
    return input.hooks.terminalize
      ? input.hooks.terminalize({ ...context, now: new Date() })
      : null;
  });
}
