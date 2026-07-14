import { afterEach, describe, expect, it, vi } from "vitest";

import { terminateLocalService } from "../services/local-service-supervisor.js";

describe("local service termination identity fence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed before the first signal when target identity cannot be re-proven", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const verifyBeforeSignal = vi.fn(async () => {
      throw new Error("identity changed");
    });

    await expect(terminateLocalService(
      { pid: 42_424, processGroupId: null },
      { verifyBeforeSignal },
    )).rejects.toThrow("identity changed");

    expect(verifyBeforeSignal).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it("re-proves identity before SIGKILL and never force-signals a changed target", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      signals.push(signal);
      return true;
    });
    const verifyBeforeSignal = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("identity changed before force kill"));

    await expect(terminateLocalService(
      { pid: 42_425, processGroupId: null },
      { forceAfterMs: 0, verifyBeforeSignal },
    )).rejects.toThrow("identity changed before force kill");

    expect(verifyBeforeSignal).toHaveBeenCalledTimes(2);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain(0);
    expect(signals).not.toContain("SIGKILL");
  });

  it("sends SIGTERM and SIGKILL from inside a fresh caller-provided fence", async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      signals.push(signal);
      return true;
    });
    const fencedSignals: NodeJS.Signals[] = [];

    await terminateLocalService(
      { pid: 42_426, processGroupId: null },
      {
        forceAfterMs: 0,
        signalWithinFence: async (signal, sendSignal) => {
          fencedSignals.push(signal);
          sendSignal();
        },
      },
    );

    expect(fencedSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });
});
