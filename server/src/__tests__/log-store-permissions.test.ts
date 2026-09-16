import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createDurableRunLogStore } from "../services/run-log-store.js";
import { createLocalFileWorkspaceOperationLogStore } from "../services/workspace-operation-log-store.js";

function permissionBits(mode: number) {
  return mode & 0o777;
}

describe("local log-store permissions", () => {
  it("creates heartbeat run-log directories as 0700 and files as 0600", async () => {
    const basePath = await mkdtemp(path.join(tmpdir(), "paperclip-run-log-"));
    const store = createDurableRunLogStore({ basePath });

    const handle = await store.begin({ companyId: "company", agentId: "agent", runId: "run" });
    const secret = "pcp_run_log_store_secret";
    await store.append(handle, { stream: "stdout", chunk: secret, ts: new Date().toISOString() });

    expect(permissionBits((await stat(path.join(basePath, "company"))).mode)).toBe(0o700);
    expect(permissionBits((await stat(path.join(basePath, "company", "agent"))).mode)).toBe(0o700);
    expect(permissionBits((await stat(path.join(basePath, handle.logRef))).mode)).toBe(0o600);
    expect((await store.read(handle)).content).not.toContain(secret);
  });

  it("creates workspace-operation log directories as 0700 and files as 0600", async () => {
    const basePath = await mkdtemp(path.join(tmpdir(), "paperclip-workspace-log-"));
    const store = createLocalFileWorkspaceOperationLogStore(basePath);

    const handle = await store.begin({ companyId: "company", operationId: "operation" });
    const secret = "pcp_workspace_operation_log_secret";
    await store.append(handle, { stream: "stderr", chunk: secret, ts: new Date().toISOString() });

    expect(permissionBits((await stat(path.join(basePath, "company"))).mode)).toBe(0o700);
    expect(permissionBits((await stat(path.join(basePath, handle.logRef))).mode)).toBe(0o600);
    expect((await store.read(handle)).content).not.toContain(secret);
  });
});
