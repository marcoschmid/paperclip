import { createDb } from "@paperclipai/db";
import { agentService } from "../../services/agents.js";

const databaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const agentId = process.env.PAPERCLIP_TEST_AGENT_ID;
const managerId = process.env.PAPERCLIP_TEST_MANAGER_ID;

if (!databaseUrl || !agentId || !managerId) {
  throw new Error("Agent reporting update worker requires its bounded test inputs");
}

const db = createDb(databaseUrl);
let result: { ok: true } | { ok: false; message: string };
try {
  if (typeof process.send !== "function") {
    throw new Error("Reporting update worker requires an IPC readiness channel");
  }
  process.send({ type: "ready" });
  await agentService(db).update(agentId, { reportsTo: managerId });
  result = { ok: true };
} catch (error) {
  result = {
    ok: false,
    message: error instanceof Error ? error.message : "unknown error",
  };
} finally {
  await db.$client.end();
}

process.stdout.write(JSON.stringify(result));
