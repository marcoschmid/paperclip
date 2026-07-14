import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentPortfolioMaintenanceGates,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent maintenance pause", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-maintenance-pause-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentPortfolioMaintenanceGates);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Maintenance company",
        issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other company",
        issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Maintenance worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, otherCompanyId, agentId };
  }

  async function insertGate(input: {
    companyId: string;
    agentId: string;
    operationId: string;
    stage?: "fenced" | "quiesced";
  }) {
    await db.insert(agentPortfolioMaintenanceGates).values({
      companyId: input.companyId,
      agentId: input.agentId,
      operationId: input.operationId,
      expectedSnapshotFingerprint: `v1:sha256:${"a".repeat(64)}`,
      recoveryFingerprint: `v1:sha256:${"b".repeat(64)}`,
      receiptId: `v1:sha256:${"c".repeat(64)}`,
      stage: input.stage ?? "quiesced",
      issuedByUserId: "board-user",
    });
  }

  const invalidGate = {
    status: 409,
    details: { code: "agent_maintenance_pause_gate_invalid" },
  };

  it("persists maintenance only for the exact same-company quiesced operation", async () => {
    const seeded = await seed();
    const operationId = randomUUID();
    await insertGate({ ...seeded, operationId });

    const paused = await agentService(db).pause(
      seeded.agentId,
      "maintenance",
      { maintenanceOperationId: operationId },
    );

    expect(paused).toMatchObject({
      id: seeded.agentId,
      companyId: seeded.companyId,
      status: "paused",
      pauseReason: "maintenance",
    });
  });

  it.each([
    ["missing gate", null, null],
    ["wrong operation", "quiesced", randomUUID()],
    ["non-quiesced gate", "fenced", null],
    ["cross-company gate", "quiesced", null],
  ] as const)("fails closed for %s", async (_label, stage, requestedOperationId) => {
    const seeded = await seed();
    const gateOperationId = randomUUID();
    if (stage !== null) {
      await insertGate({
        companyId: _label === "cross-company gate" ? seeded.otherCompanyId : seeded.companyId,
        agentId: seeded.agentId,
        operationId: gateOperationId,
        stage,
      });
    }

    await expect(agentService(db).pause(
      seeded.agentId,
      "maintenance",
      { maintenanceOperationId: requestedOperationId ?? gateOperationId },
    )).rejects.toMatchObject(invalidGate);

    await expect(db.select().from(agents).where(eq(agents.id, seeded.agentId)).then((rows) => rows[0]))
      .resolves.toMatchObject({ status: "idle", pauseReason: null });
  });

  it("keeps the legacy no-body/manual service path independent of maintenance gates", async () => {
    const seeded = await seed();
    const paused = await agentService(db).pause(seeded.agentId);
    expect(paused).toMatchObject({ status: "paused", pauseReason: "manual" });
  });
});
