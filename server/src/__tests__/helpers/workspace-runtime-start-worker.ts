import fs from "node:fs";
import { createDb } from "@paperclipai/db";
import { startRuntimeServicesForWorkspaceControl } from "../../services/workspace-runtime.js";

const databaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const companyId = process.env.PAPERCLIP_TEST_COMPANY_ID;
const agentId = process.env.PAPERCLIP_TEST_AGENT_ID;
const workspaceCwd = process.env.PAPERCLIP_TEST_WORKSPACE_CWD;
const goFile = process.env.PAPERCLIP_TEST_GO_FILE;

if (!databaseUrl || !companyId || !agentId || !workspaceCwd || !goFile) {
  throw new Error("Workspace runtime start worker requires its bounded test inputs");
}

while (!fs.existsSync(goFile)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const db = createDb(databaseUrl);
let result: { ok: true; id: string; reused: boolean } | { ok: false; message: string };
try {
  const refs = await startRuntimeServicesForWorkspaceControl({
    db,
    invocationId: process.env.PAPERCLIP_TEST_INVOCATION_ID,
    actor: { id: agentId, name: `Worker ${agentId}`, companyId },
    issue: null,
    workspace: {
      baseCwd: workspaceCwd,
      source: "project_primary",
      projectId: null,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      strategy: "project_primary",
      cwd: workspaceCwd,
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
    },
    config: {
      workspaceRuntime: {
        services: [{
          name: "cross-process-web",
          command: "node runtime-service.cjs",
          lifecycle: "shared",
          reuseScope: "project_workspace",
          port: { type: "auto" },
          expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
          readiness: {
            type: "http",
            urlTemplate: "http://127.0.0.1:{{port}}",
            timeoutSec: 8,
            intervalMs: 50,
          },
          stopPolicy: { type: "manual" },
        }],
      },
    },
    adapterEnv: {},
  });
  result = { ok: true, id: refs[0]!.id, reused: refs[0]!.reused };
} catch (error) {
  result = {
    ok: false,
    message: error instanceof Error ? error.message : "unknown error",
  };
} finally {
  await db.$client.end();
}

process.stdout.write(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
