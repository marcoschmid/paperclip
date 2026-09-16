import { describe, expect, it } from "vitest";
import { runPostgresDisconnectRegressionChild } from "./postgres-disconnect-regression-runner.js";

describe("postgres.js disconnect regressions", () => {
  it("rejects a queued null-socket write without an uncaught process error", async () => {
    const result = await runPostgresDisconnectRegressionChild(
      "queued-write-during-reconnect",
    );

    expect(result).toMatchObject({
      staleCode: "CONNECTION_CLOSED",
      reconnectOutcome: "CONNECTION_CLOSED",
      recovered: true,
    });
  });

  it("rejects an old transaction handle without sending on the reconnected socket", async () => {
    const result = await runPostgresDisconnectRegressionChild(
      "stale-transaction-after-reconnect",
    );

    expect(result).toMatchObject({
      transactionOutcome: "CONNECTION_CLOSED",
      staleCode: "CONNECTION_CLOSED",
    });
    expect(result.replacementQueryWrites).toBe(result.queryWritesBeforeStaleHandle);
  });
});
