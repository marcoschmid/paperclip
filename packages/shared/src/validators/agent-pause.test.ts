import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as shared from "../index.js";
import { pauseAgentSchema } from "./agent.js";

describe("agent pause request", () => {
  it("keeps the legacy empty request as a strict manual pause", () => {
    expect(pauseAgentSchema.parse({})).toEqual({ reason: "manual" });
    expect(pauseAgentSchema.parse({ reason: "manual" })).toEqual({ reason: "manual" });
    expect(pauseAgentSchema.safeParse({ reason: "manual", operationId: randomUUID() }).success)
      .toBe(false);
  });

  it("requires an exact UUID-bound maintenance request and rejects free-form details", () => {
    const operationId = randomUUID();
    expect(pauseAgentSchema.parse({ reason: "maintenance", operationId })).toEqual({
      reason: "maintenance",
      operationId,
    });
    expect(pauseAgentSchema.safeParse({ reason: "maintenance" }).success).toBe(false);
    expect(pauseAgentSchema.safeParse({ reason: "maintenance", operationId: "TEC-355" }).success)
      .toBe(false);
    expect(pauseAgentSchema.safeParse({
      reason: "maintenance",
      operationId,
      reasonDetail: "secret or PII",
    }).success).toBe(false);
    expect(pauseAgentSchema.safeParse({ reason: "budget" }).success).toBe(false);
    expect((shared as Record<string, unknown>).pauseAgentSchema).toBe(pauseAgentSchema);
  });

  it("adds maintenance only to the agent-specific pause-reason contract", () => {
    expect(shared.PAUSE_REASONS).toEqual(["manual", "budget", "system", "company_archived"]);
    expect(shared.AGENT_PAUSE_REASONS).toEqual([
      "manual",
      "budget",
      "system",
      "company_archived",
      "maintenance",
    ]);
  });
});
