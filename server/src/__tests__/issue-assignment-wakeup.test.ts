import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

describe("queueIssueAssignmentWakeup", () => {
  it("returns an explicit skip receipt before calling heartbeat", async () => {
    const wakeup = vi.fn();

    await expect(queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: null, status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
    })).resolves.toEqual({ kind: "skipped", reason: "unassigned" });

    await expect(queueIssueAssignmentWakeup({
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "backlog" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
    })).resolves.toEqual({ kind: "skipped", reason: "backlog" });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("distinguishes a heartbeat noop from a durable queued receipt", async () => {
    const wakeup = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "heartbeat-run-1" });
    const input = {
      heartbeat: { wakeup },
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "routine.dispatch",
      idempotencyKey: "routine-delivery:delivery-1",
    } as const;

    await expect(queueIssueAssignmentWakeup(input)).resolves.toEqual({
      kind: "skipped",
      reason: "heartbeat_noop",
    });
    await expect(queueIssueAssignmentWakeup(input)).resolves.toEqual({
      kind: "queued",
      wake: { id: "heartbeat-run-1" },
    });
    expect(wakeup).toHaveBeenLastCalledWith("agent-1", expect.objectContaining({
      idempotencyKey: "routine-delivery:delivery-1",
      payload: { issueId: "issue-1", mutation: "create" },
      contextSnapshot: { issueId: "issue-1", source: "routine.dispatch" },
    }));
  });
});
