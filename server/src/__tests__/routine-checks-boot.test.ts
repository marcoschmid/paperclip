import { describe, it, expect } from "vitest";
import { buildRegistry } from "../services/routine-checks/boot.js";

describe("buildRegistry", () => {
  it("registers exactly 5 checks with expected names", () => {
    const r = buildRegistry();
    const names = r.list().map((c) => c.name).sort();
    expect(names).toEqual([
      "approved-freshness",
      "creative-lint-nightly",
      "drive-marker-ttl",
      "subscription-shadow-sync",
      "workspace-drift-guard",
    ]);
  });

  it("registers checks with valid cron expressions (registry validates)", () => {
    expect(() => buildRegistry()).not.toThrow();
  });
});
