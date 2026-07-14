import { describe, expect, it } from "vitest";

import {
  assertHistoricalAgentTombstoneAccessMutable,
  assertHistoricalAgentTombstoneActiveReference,
  assertHistoricalAgentTombstoneMutable,
  assertHistoricalTombstoneWorkInertness,
  isHistoricalAgentTombstoneId,
} from "../services/agent-retirement-historical-tombstones.js";

const TOMBSTONES = [
  "8d403783-c4e2-4746-adad-7689cd95ae33",
  "dcd3cadb-8203-4048-be1e-77701a3a43a0",
] as const;

function inertState() {
  return {
    tombstoneIds: [...TOMBSTONES],
    issues: [
      { id: "10000000-0000-4000-8000-000000000001", assigneeAgentId: TOMBSTONES[0], status: "done" },
      { id: "10000000-0000-4000-8000-000000000002", assigneeAgentId: TOMBSTONES[1], status: "cancelled" },
    ],
    routines: [
      { id: "20000000-0000-4000-8000-000000000001", assigneeAgentId: TOMBSTONES[0], status: "archived" },
    ],
    routineTriggers: [
      { id: "30000000-0000-4000-8000-000000000001", routineId: "20000000-0000-4000-8000-000000000001", enabled: false },
    ],
    heartbeatRuns: [
      { id: "40000000-0000-4000-8000-000000000001", agentId: TOMBSTONES[0], status: "succeeded" },
      { id: "40000000-0000-4000-8000-000000000002", agentId: TOMBSTONES[1], status: "failed" },
    ],
    wakeRequests: [
      { id: "50000000-0000-4000-8000-000000000001", agentId: TOMBSTONES[0], status: "timed_out" },
    ],
    projects: [
      {
        id: "60000000-0000-4000-8000-000000000001",
        leadAgentId: TOMBSTONES[0],
        archivedAt: new Date("2026-07-13T10:00:00.000Z"),
      },
    ],
    goals: [
      { id: "70000000-0000-4000-8000-000000000001", ownerAgentId: TOMBSTONES[0], status: "achieved" },
      { id: "70000000-0000-4000-8000-000000000002", ownerAgentId: TOMBSTONES[1], status: "cancelled" },
    ],
    runtimeServices: [
      { id: "80000000-0000-4000-8000-000000000001", ownerAgentId: TOMBSTONES[0], status: "stopped" },
      { id: "80000000-0000-4000-8000-000000000002", ownerAgentId: TOMBSTONES[1], status: "failed" },
    ],
    approvals: [
      { id: "a0000000-0000-4000-8000-000000000001", requestedByAgentId: TOMBSTONES[0], status: "approved" },
      { id: "a0000000-0000-4000-8000-000000000002", requestedByAgentId: TOMBSTONES[1], status: "cancelled" },
    ],
    taskSessions: [
      {
        id: "b0000000-0000-4000-8000-000000000001",
        agentId: TOMBSTONES[0],
        lastRunId: "40000000-0000-4000-8000-000000000001",
      },
      {
        id: "b0000000-0000-4000-8000-000000000002",
        agentId: TOMBSTONES[1],
        lastRunId: null,
      },
    ],
    activeIssueWatchdogs: [] as Array<{ id: string; watchdogAgentId: string; status: string }>,
    activeRecoveryActions: [] as Array<{ id: string; ownerAgentId: string; status: string }>,
    pipelineAgentLeaseRows: [] as Array<{
      id: string;
      leaseOwnerType: string | null;
      leaseAgentId: string | null;
      leaseUserId: string | null;
      leaseToken: string | null;
      leaseExpiresAt: Date | string | null;
    }>,
  };
}

describe("historical retirement tombstone work inertness", () => {
  it("recognizes historical UUIDs independently of input casing", () => {
    expect(isHistoricalAgentTombstoneId(TOMBSTONES[0].toUpperCase())).toBe(true);
    expect(isHistoricalAgentTombstoneId("not-a-uuid")).toBe(false);
  });

  it("returns stable fail-closed codes for direct, access, and active-reference mutations", () => {
    expect(() => assertHistoricalAgentTombstoneMutable(TOMBSTONES[0])).toThrowError(
      expect.objectContaining({
        status: 409,
        details: expect.objectContaining({
          code: "historical_agent_tombstone_immutable",
          agentId: TOMBSTONES[0],
        }),
      }),
    );
    expect(() => assertHistoricalAgentTombstoneAccessMutable(TOMBSTONES[0])).toThrowError(
      expect.objectContaining({
        status: 403,
        details: expect.objectContaining({
          code: "historical_agent_tombstone_access_forbidden",
          agentId: TOMBSTONES[0],
        }),
      }),
    );
    expect(() => assertHistoricalAgentTombstoneActiveReference(TOMBSTONES[0])).toThrowError(
      expect.objectContaining({
        status: 409,
        details: expect.objectContaining({
          code: "historical_agent_tombstone_active_reference_forbidden",
          agentId: TOMBSTONES[0],
        }),
      }),
    );

    const ordinaryAgentId = "90000000-0000-4000-8000-000000000001";
    expect(() => assertHistoricalAgentTombstoneMutable(ordinaryAgentId)).not.toThrow();
    expect(() => assertHistoricalAgentTombstoneAccessMutable(ordinaryAgentId)).not.toThrow();
    expect(() => assertHistoricalAgentTombstoneActiveReference(ordinaryAgentId)).not.toThrow();
  });

  it("accepts only terminal historical work and disabled routine triggers", () => {
    const proof = assertHistoricalTombstoneWorkInertness(inertState());

    expect(proof).toEqual({
      tombstoneCount: 2,
      terminalIssueCount: 2,
      inactiveRoutineCount: 1,
      disabledTriggerCount: 1,
      terminalRunCount: 2,
      terminalWakeCount: 1,
      archivedProjectLeadCount: 1,
      terminalGoalOwnershipCount: 2,
      terminalRuntimeServiceCount: 2,
      terminalApprovalCount: 2,
      boundedTaskSessionCount: 2,
      activeIssueWatchdogCount: 0,
      activeRecoveryActionCount: 0,
      unclearedPipelineAgentLeaseCount: 0,
    });
  });

  it("accepts a timed-out tombstone wake as terminal history", () => {
    expect(() => assertHistoricalTombstoneWorkInertness(inertState())).not.toThrow();
  });

  it.each([
    ["open issue", (state: ReturnType<typeof inertState>) => { state.issues[0]!.status = "todo"; }],
    ["active routine", (state: ReturnType<typeof inertState>) => { state.routines[0]!.status = "active"; }],
    ["enabled trigger", (state: ReturnType<typeof inertState>) => { state.routineTriggers[0]!.enabled = true; }],
    ["active run", (state: ReturnType<typeof inertState>) => { state.heartbeatRuns[0]!.status = "running"; }],
    ["active wake", (state: ReturnType<typeof inertState>) => { state.wakeRequests[0]!.status = "queued"; }],
    ["active project lead", (state: ReturnType<typeof inertState>) => { state.projects[0]!.archivedAt = null; }],
    ["planned goal owner", (state: ReturnType<typeof inertState>) => { state.goals[0]!.status = "planned"; }],
    ["active goal owner", (state: ReturnType<typeof inertState>) => { state.goals[0]!.status = "active"; }],
    ["starting runtime service", (state: ReturnType<typeof inertState>) => { state.runtimeServices[0]!.status = "starting"; }],
    ["running runtime service", (state: ReturnType<typeof inertState>) => { state.runtimeServices[0]!.status = "running"; }],
    ["pending approval", (state: ReturnType<typeof inertState>) => { state.approvals[0]!.status = "pending"; }],
    ["revision-requested approval", (state: ReturnType<typeof inertState>) => { state.approvals[0]!.status = "revision_requested"; }],
    ["dangling task-session run", (state: ReturnType<typeof inertState>) => {
      state.taskSessions[0]!.lastRunId = "c0000000-0000-4000-8000-000000000001";
    }],
    ["cross-agent task-session run", (state: ReturnType<typeof inertState>) => {
      state.taskSessions[0]!.lastRunId = "40000000-0000-4000-8000-000000000002";
    }],
    ["active issue watchdog", (state: ReturnType<typeof inertState>) => {
      state.activeIssueWatchdogs.push({
        id: "c0000000-0000-4000-8000-000000000001",
        watchdogAgentId: TOMBSTONES[0],
        status: "active",
      });
    }],
    ["active recovery action", (state: ReturnType<typeof inertState>) => {
      state.activeRecoveryActions.push({
        id: "d0000000-0000-4000-8000-000000000001",
        ownerAgentId: TOMBSTONES[0],
        status: "escalated",
      });
    }],
    ["uncleared pipeline agent lease", (state: ReturnType<typeof inertState>) => {
      state.pipelineAgentLeaseRows.push({
        id: "e0000000-0000-4000-8000-000000000001",
        leaseOwnerType: "agent",
        leaseAgentId: TOMBSTONES[0],
        leaseUserId: null,
        leaseToken: "f0000000-0000-4000-8000-000000000001",
        leaseExpiresAt: "2026-07-14T12:00:00.000Z",
      });
    }],
    ["partial pipeline agent lease", (state: ReturnType<typeof inertState>) => {
      state.pipelineAgentLeaseRows.push({
        id: "e0000000-0000-4000-8000-000000000002",
        leaseOwnerType: "agent",
        leaseAgentId: null,
        leaseUserId: null,
        leaseToken: "f0000000-0000-4000-8000-000000000002",
        leaseExpiresAt: null,
      });
    }],
  ])("rejects %s", (_label, mutate) => {
    const state = inertState();
    mutate(state);
    expect(() => assertHistoricalTombstoneWorkInertness(state)).toThrow(/not inert/i);
  });

  it("rejects unknown or duplicate tombstone identities and out-of-scope rows", () => {
    const duplicate = inertState();
    duplicate.tombstoneIds[1] = duplicate.tombstoneIds[0]!;
    expect(() => assertHistoricalTombstoneWorkInertness(duplicate)).toThrow(/tombstone identity/i);

    const outOfScope = inertState();
    outOfScope.issues.push({
      id: "10000000-0000-4000-8000-000000000003",
      assigneeAgentId: "90000000-0000-4000-8000-000000000001",
      status: "done",
    });
    expect(() => assertHistoricalTombstoneWorkInertness(outOfScope)).toThrow(/outside.*tombstone/i);
  });
});
