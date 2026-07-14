import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  createAgentConfigurationFingerprint,
} from "../services/effective-run-config-fingerprints.js";
import {
  createAgentLifecycleValidationReceipt,
  hashAgentLifecycleContent,
} from "../services/agent-lifecycle.js";
import * as heartbeatModule from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const INSTRUCTIONS = "bounded lifecycle canary instructions";

function lifecycle() {
  return {
    schemaVersion: "1.0.0" as const,
    owner: { ownerType: "board_user" as const, ownerUserId: "better-auth:user-marco" },
    purpose: "Own bounded lifecycle-gated work.",
    acceptedTaskTypes: ["bounded issue work"],
    rejectedTaskTypes: ["unscoped external writes"],
    taskSources: ["paperclip:company:company-1:issues"],
    operatingMode: "issue_routed" as const,
    serviceLevel: {
      availabilityClass: "business_hours" as const,
      triageTargetMinutes: 120,
      completionTargetMinutes: 1_440,
      targetExceptionReason: null,
    },
    canaryIssueId: "44444444-4444-4444-8444-444444444444",
    lastCanaryAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
    lastCanaryResult: "passed" as const,
    canaryFreshnessDays: 30,
    reviewAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1_000).toISOString(),
    retirementCriterion: "Retire only after a reviewed replacement canary.",
    decisionIssueId: "22222222-2222-4222-8222-222222222222",
  };
}

describeEmbeddedPostgres("heartbeat lifecycle fresh-session reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-lifecycle-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: { name: string; includeReceipt?: boolean }) {
    companyId = companyId || randomUUID();
    const existingCompany = await db.select().from(companies).where(eq(companies.id, companyId)).then((rows) => rows[0]);
    if (!existingCompany) {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    const agentId = randomUUID();
    const lifecycleValue = lifecycle();
    const permissions = {
      canCreateAgents: false,
      canCreateSkills: true,
      bypass: { claudePermissionMode: false, codexApprovalsAndSandbox: false },
      exception: { kind: "none" },
    };
    const baseInput = {
      agentId,
      companyId,
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.6-terra", promptTemplate: INSTRUCTIONS },
      runtimeConfig: {},
      permissions,
      grants: [],
      desiredSkills: [],
      lifecycle: lifecycleValue,
      contextPackSha256: hashAgentLifecycleContent(INSTRUCTIONS),
      managedInstructionsSha256: hashAgentLifecycleContent({ "AGENTS.md": INSTRUCTIONS }),
      companyProfileSha256: null,
    };
    const initial = createAgentLifecycleValidationReceipt({ fingerprintInput: baseInput });
    const currentAdapterConfig = { model: "gpt-5.6-luna", promptTemplate: INSTRUCTIONS };
    const currentInput = { ...baseInput, adapterConfig: currentAdapterConfig };
    const required = createAgentLifecycleValidationReceipt({
      fingerprintInput: currentInput,
      previousGate: initial,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: input.name,
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: currentAdapterConfig,
      runtimeConfig: {},
      permissions,
      metadata: input.includeReceipt === false
        ? { lifecycle: lifecycleValue }
        : { lifecycle: lifecycleValue, lifecycleGate: required },
    });
    return {
      agentId,
      required,
      runFingerprint: createAgentConfigurationFingerprint({
        adapterType: "codex_local",
        adapterConfig: currentAdapterConfig,
        runtimeConfig: {},
      }),
    };
  }

  it("clears only a successful exact fresh-session run", async () => {
    const seeded = await seedAgent({ name: "Matching fresh run" });
    const reconcile = (heartbeatModule as Record<string, any>).satisfyLifecycleFreshSessionAfterSuccessfulRun;

    const result = await reconcile(db, {
      id: "55555555-5555-4555-8555-555555555555",
      companyId,
      agentId: seeded.agentId,
      status: "succeeded",
      freshSession: true,
      agentConfigurationFingerprint: seeded.runFingerprint,
    });

    expect(result).toMatchObject({ updated: true });
    const persisted = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
    expect((persisted?.metadata as Record<string, any>).lifecycleGate).toMatchObject({
      freshSessionRequired: false,
      lastSatisfiedRunId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("leaves failed, reused, stale, mismatched, and receipt-free agents unchanged", async () => {
    const reconcile = (heartbeatModule as Record<string, any>).satisfyLifecycleFreshSessionAfterSuccessfulRun;
    const cases = [
      { name: "failed", status: "failed", freshSession: true, fingerprint: "matching" },
      { name: "reused", status: "succeeded", freshSession: false, fingerprint: "matching" },
      { name: "mismatch", status: "succeeded", freshSession: true, fingerprint: "mismatch" },
      { name: "receipt-free", status: "succeeded", freshSession: true, fingerprint: "matching", receipt: false },
    ];

    for (const item of cases) {
      const seeded = await seedAgent({ name: item.name, includeReceipt: item.receipt });
      const result = await reconcile(db, {
        id: randomUUID(),
        companyId,
        agentId: seeded.agentId,
        status: item.status,
        freshSession: item.freshSession,
        agentConfigurationFingerprint: item.fingerprint === "matching"
          ? seeded.runFingerprint
          : `v1:sha256:${"f".repeat(64)}`,
      });
      expect(result).toMatchObject({ updated: false });
      const persisted = await db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]);
      const gate = (persisted?.metadata as Record<string, any>).lifecycleGate;
      expect(gate?.freshSessionRequired ?? null).toBe(item.receipt === false ? null : true);
    }

    const stale = await seedAgent({ name: "stale" });
    await db.update(agents).set({ adapterConfig: { model: "changed-after-run", promptTemplate: INSTRUCTIONS } }).where(eq(agents.id, stale.agentId));
    const staleResult = await reconcile(db, {
      id: randomUUID(),
      companyId,
      agentId: stale.agentId,
      status: "succeeded",
      freshSession: true,
      agentConfigurationFingerprint: createAgentConfigurationFingerprint({
        adapterType: "codex_local",
        adapterConfig: { model: "changed-after-run", promptTemplate: INSTRUCTIONS },
        runtimeConfig: {},
      }),
    });
    expect(staleResult).toMatchObject({ updated: false });
  });

  it("rejects a malformed lifecycle receipt before fresh-session reconciliation", async () => {
    const seeded = await seedAgent({ name: "Malformed receipt" });
    const persisted = await db
      .select()
      .from(agents)
      .where(eq(agents.id, seeded.agentId))
      .then((rows) => rows[0]);
    const metadata = persisted?.metadata as Record<string, unknown>;
    await db
      .update(agents)
      .set({
        metadata: {
          ...metadata,
          lifecycleGate: {
            configFingerprint: seeded.required.configFingerprint,
            receiptHash: seeded.required.receiptHash,
          },
        },
      })
      .where(eq(agents.id, seeded.agentId));

    const result = await heartbeatModule.satisfyLifecycleFreshSessionAfterSuccessfulRun(db, {
      id: randomUUID(),
      companyId,
      agentId: seeded.agentId,
      status: "succeeded",
      freshSession: true,
      agentConfigurationFingerprint: seeded.runFingerprint,
    });

    expect(result).toEqual({ updated: false, reason: "receipt_invalid" });
  });
});
