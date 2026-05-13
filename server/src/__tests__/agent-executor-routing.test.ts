/**
 * Phase-4 4b-1 — Agent.executor validator coverage.
 *
 * Confirms the createAgentSchema accepts {executor: 'hermes' | 'mc-dispatch'},
 * defaults to 'mc-dispatch' when omitted, and rejects unknown values.
 *
 * Service-level filter routing tests (Hermes-Worker queries executor=hermes only,
 * Drain-Worker queries executor=mc-dispatch only) live in 4b-3 / 4b-5 once the
 * filtered list endpoint is added.
 */
import { describe, expect, it } from "vitest";
import { createAgentSchema } from "@paperclipai/shared";

const BASE_INPUT = {
  name: "test-agent",
  role: "engineer" as const,
  adapterType: "codex_local",
};

describe("agents.executor validator (Phase-4 4b-1)", () => {
  it("defaults to mc-dispatch when executor omitted", () => {
    const parsed = createAgentSchema.parse(BASE_INPUT);
    expect(parsed.executor).toBe("mc-dispatch");
  });

  it("accepts executor=hermes", () => {
    const parsed = createAgentSchema.parse({ ...BASE_INPUT, executor: "hermes" });
    expect(parsed.executor).toBe("hermes");
  });

  it("accepts executor=mc-dispatch", () => {
    const parsed = createAgentSchema.parse({ ...BASE_INPUT, executor: "mc-dispatch" });
    expect(parsed.executor).toBe("mc-dispatch");
  });

  it("rejects unknown executor values", () => {
    expect(() => createAgentSchema.parse({ ...BASE_INPUT, executor: "kubernetes" })).toThrow();
    expect(() => createAgentSchema.parse({ ...BASE_INPUT, executor: "" })).toThrow();
    expect(() => createAgentSchema.parse({ ...BASE_INPUT, executor: null })).toThrow();
  });

  it("preserves executor through full input round-trip", () => {
    const input = {
      ...BASE_INPUT,
      executor: "hermes" as const,
      title: "Phase-4 hermes worker",
      adapterConfig: {},
      runtimeConfig: { someKey: 1 },
    };
    const parsed = createAgentSchema.parse(input);
    expect(parsed).toMatchObject({
      executor: "hermes",
      title: "Phase-4 hermes worker",
      runtimeConfig: { someKey: 1 },
    });
  });
});
