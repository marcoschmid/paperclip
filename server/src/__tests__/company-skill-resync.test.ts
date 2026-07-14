import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentPortfolioMaintenanceGates,
  agents,
  companies,
  companySkills,
  companySkillVersions,
  createDb,
} from "@paperclipai/db";

import { companySkillService } from "../services/company-skills.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const MAINTENANCE_OPERATION_ID = "40000000-0000-4000-8000-000000000001";
const MAINTENANCE_RECEIPT_ID = `v1:sha256:${"6".repeat(64)}`;
const MAINTENANCE_SNAPSHOT_FINGERPRINT = `v1:sha256:${"7".repeat(64)}`;
const HISTORICAL_TOMBSTONE_ID = "8d403783-c4e2-4746-adad-7689cd95ae33";
const FRESH_SKILL_MARKDOWN = "---\nname: Fresh Skill\n---\n\n# Fresh Skill\n";
const FRESH_GUIDE_MARKDOWN = "# Guide\n";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company skill resync tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company skill source resync CAS", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-skill-resync-");
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(agentPortfolioMaintenanceGates);
    await db.delete(companySkillVersions);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
    await Promise.all([...cleanupDirs].map((target) => fs.rm(target, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedSkill() {
    const companyId = randomUUID();
    const skillId = randomUUID();
    const oldVersionId = randomUUID();
    const agentId = randomUUID();
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-resync-source-"));
    cleanupDirs.add(sourceDir);
    await fs.mkdir(path.join(sourceDir, "references"), { recursive: true });
    await fs.mkdir(path.join(sourceDir, "__pycache__"), { recursive: true });
    await fs.mkdir(path.join(sourceDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(sourceDir, "node_modules", "ignored"), { recursive: true });
    await fs.writeFile(path.join(sourceDir, "SKILL.md"), FRESH_SKILL_MARKDOWN, "utf8");
    await fs.writeFile(path.join(sourceDir, "references", "guide.md"), FRESH_GUIDE_MARKDOWN, "utf8");
    await fs.writeFile(path.join(sourceDir, "__pycache__", "cache.pyc"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(sourceDir, "ignored.pyo"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(sourceDir, ".DS_Store"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(sourceDir, ".git", "config"), "ignored", "utf8");
    await fs.writeFile(path.join(sourceDir, "node_modules", "ignored", "index.js"), "ignored", "utf8");

    await db.insert(companies).values({
      id: companyId,
      name: "Resync Company",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: "local/1234567890/fresh-skill",
      slug: "fresh-skill",
      name: "Stale Skill",
      description: null,
      markdown: "# Stale Skill\n",
      sourceType: "local_path",
      sourceLocator: sourceDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });
    await db.insert(companySkillVersions).values({
      id: oldVersionId,
      companyId,
      companySkillId: skillId,
      revisionNumber: 1,
      label: "old",
      fileInventory: [{ path: "SKILL.md", kind: "skill", content: "# Stale Skill\n" }],
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Skill Consumer",
      adapterType: "codex_local",
      adapterConfig: {
        paperclipSkillSync: {
          desiredSkills: ["local/1234567890/fresh-skill"],
        },
      },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentPortfolioMaintenanceGates).values({
      companyId,
      agentId,
      operationId: MAINTENANCE_OPERATION_ID,
      expectedSnapshotFingerprint: MAINTENANCE_SNAPSHOT_FINGERPRINT,
      recoveryFingerprint: `v1:sha256:${"8".repeat(64)}`,
      receiptId: MAINTENANCE_RECEIPT_ID,
      stage: "quiesced",
      issuedByUserId: "board",
    });
    await db.update(companySkills).set({ currentVersionId: oldVersionId }).where(eq(companySkills.id, skillId));
    return { companyId, skillId, oldVersionId, agentId, sourceDir };
  }

  function requestFromPreflight(preflight: any, agentId: string) {
    return {
      schemaVersion: "1.0.0",
      approvalIssue: "TEC-355",
      maintenanceOperationId: MAINTENANCE_OPERATION_ID,
      maintenanceAgentIds: [agentId],
      maintenanceReceiptId: MAINTENANCE_RECEIPT_ID,
      maintenanceExpectedSnapshotFingerprint: MAINTENANCE_SNAPSHOT_FINGERPRINT,
      label: `TEC-355 skill-resync ${MAINTENANCE_OPERATION_ID} ${preflight.skillId} ` +
        `${preflight.currentVersionId} ${preflight.sourceInventorySha256}`,
      expectedSkillKey: preflight.skillKey,
      expectedSourceType: "local_path",
      expectedSourceInventoryMode: preflight.sourceInventoryMode,
      expectedSourceLocatorSha256: preflight.sourceLocatorSha256,
      expectedSkillUpdatedAt: preflight.skillUpdatedAt,
      expectedCurrentVersionId: preflight.currentVersionId,
      expectedBaseMarkdownSha256: preflight.baseMarkdownSha256,
      expectedCurrentVersionInventorySha256: preflight.currentVersionInventorySha256,
      expectedSourceSkillMarkdownSha256: preflight.sourceSkillMarkdownSha256,
      expectedSourceInventorySha256: preflight.sourceInventorySha256,
      expectedBaseFileInventorySha256: preflight.baseFileInventorySha256,
      expectedSourceFileInventorySha256: preflight.sourceFileInventorySha256,
      expectedBaseTrustLevel: preflight.baseTrustLevel,
      expectedSourceTrustLevel: preflight.sourceTrustLevel,
    };
  }

  function baseOnlyRequestFromPreflight(preflight: any) {
    return {
      ...requestFromPreflight(preflight, randomUUID()),
      maintenanceAgentIds: [],
      maintenanceReceiptId: null,
      maintenanceExpectedSnapshotFingerprint: null,
    };
  }

  async function alignPinnedVersionWithSource(versionId: string) {
    await db.update(companySkillVersions).set({
      fileInventory: [
        { path: "SKILL.md", kind: "skill", content: FRESH_SKILL_MARKDOWN },
        { path: "references/guide.md", kind: "reference", content: FRESH_GUIDE_MARKDOWN },
      ],
    }).where(eq(companySkillVersions.id, versionId));
  }

  it("ignores governed cache paths and snapshots only bounded regular UTF-8 text files", async () => {
    const seeded = await seedSkill();
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);

    expect(preflight).toMatchObject({
      schemaVersion: "1.0.0",
      companyId: seeded.companyId,
      skillId: seeded.skillId,
      sourceType: "local_path",
      sourceFileCount: 2,
    });
    const version = await svc.createVersion(
      seeded.companyId,
      seeded.skillId,
      { label: "governed" },
      { type: "user", userId: "board" },
    );
    expect(version.fileInventory.map((entry) => entry.path)).toEqual(["SKILL.md", "references/guide.md"]);
  });

  it("returns the exact sorted current agent consumers in resync preflight", async () => {
    const seeded = await seedSkill();
    const additionalConsumerIds = [
      "f0000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000001",
    ];
    await db.insert(agents).values([
      ...additionalConsumerIds.map((id) => ({
        id,
        companyId: seeded.companyId,
        name: `Skill Consumer ${id}`,
        adapterType: "codex_local",
        adapterConfig: {
          paperclipSkillSync: {
            desiredSkills: ["local/1234567890/fresh-skill"],
          },
        },
        runtimeConfig: {},
        permissions: {},
      })),
      {
        id: "90000000-0000-4000-8000-000000000001",
        companyId: seeded.companyId,
        name: "Unrelated Agent",
        adapterType: "codex_local",
        adapterConfig: {
          paperclipSkillSync: {
            desiredSkills: ["local/1234567890/unrelated-skill"],
          },
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);

    expect(preflight.affectedAgentIds).toEqual(
      [seeded.agentId, ...additionalConsumerIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    );
  });

  it("excludes terminated and fixed historical agents from resync preflight and apply coverage", async () => {
    const seeded = await seedSkill();
    const terminatedAgentId = "70000000-0000-4000-8000-000000000001";
    const desiredAdapterConfig = {
      paperclipSkillSync: {
        desiredSkills: ["local/1234567890/fresh-skill"],
      },
    };
    await db.insert(agents).values([
      {
        id: terminatedAgentId,
        companyId: seeded.companyId,
        name: "Terminated Archive",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: desiredAdapterConfig,
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: HISTORICAL_TOMBSTONE_ID,
        companyId: seeded.companyId,
        name: "Historical Tombstone",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: desiredAdapterConfig,
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const beforeArchivedConfigs = await db.select({ id: agents.id, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(sql`${agents.id} in (${terminatedAgentId}, ${HISTORICAL_TOMBSTONE_ID})`);

    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);

    expect(preflight.affectedAgentIds).toEqual([seeded.agentId]);
    await expect(svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      requestFromPreflight(preflight, seeded.agentId),
      { type: "user", userId: "board" },
    )).resolves.toMatchObject({ versionCreated: true });
    await expect(db.select({ id: agents.id, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(sql`${agents.id} in (${terminatedAgentId}, ${HISTORICAL_TOMBSTONE_ID})`))
      .resolves.toEqual(beforeArchivedConfigs);
  });

  it("returns an empty resync preflight scope when no current agent consumes the skill", async () => {
    const seeded = await seedSkill();
    await db.update(agents).set({
      adapterConfig: {
        paperclipSkillSync: {
          desiredSkills: ["local/1234567890/unrelated-skill"],
        },
      },
    }).where(eq(agents.id, seeded.agentId));

    await expect(svc.resyncPreflight(seeded.companyId, seeded.skillId)).resolves.toMatchObject({
      affectedAgentIds: [],
    });
  });

  it("rejects resync preflight when more than one hundred current agents consume the skill", async () => {
    const seeded = await seedSkill();
    await db.insert(agents).values(Array.from({ length: 100 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      companyId: seeded.companyId,
      name: `Bounded Skill Consumer ${index + 1}`,
      adapterType: "codex_local",
      adapterConfig: {
        paperclipSkillSync: {
          desiredSkills: ["local/1234567890/fresh-skill"],
        },
      },
      runtimeConfig: {},
      permissions: {},
    })));

    await expect(svc.resyncPreflight(seeded.companyId, seeded.skillId)).rejects.toMatchObject({
      status: 422,
      details: { code: "skill_resync_affected_agent_scope_out_of_bounds", affectedAgentCount: 101 },
    });
  });

  it("fails closed on a non-ignored symlink or binary source file", async () => {
    const seeded = await seedSkill();
    await fs.writeFile(path.join(seeded.sourceDir, "payload.bin"), Buffer.from([0, 1, 2, 3]));
    await expect(svc.resyncPreflight(seeded.companyId, seeded.skillId)).rejects.toMatchObject({ status: 422 });
    await fs.rm(path.join(seeded.sourceDir, "payload.bin"));
    await fs.symlink(path.join(seeded.sourceDir, "SKILL.md"), path.join(seeded.sourceDir, "linked.md"));
    await expect(svc.resyncPreflight(seeded.companyId, seeded.skillId)).rejects.toMatchObject({ status: 422 });
  });

  it("classifies executable extensions under references and assets as executable trust", async () => {
    const seeded = await seedSkill();
    await fs.writeFile(path.join(seeded.sourceDir, "references", "review.sh"), "#!/bin/sh\nexit 0\n", "utf8");
    await fs.mkdir(path.join(seeded.sourceDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(seeded.sourceDir, "assets", "build.py"), "raise SystemExit(0)\n", "utf8");

    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    const version = await svc.createVersion(
      seeded.companyId,
      seeded.skillId,
      { label: "executable-kind-proof" },
      { type: "user", userId: "board" },
    );

    expect(preflight).toMatchObject({ sourceTrustLevel: "scripts_executables" });
    expect(version.fileInventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "references/review.sh", kind: "reference" }),
      expect.objectContaining({ path: "assets/build.py", kind: "asset" }),
    ]));
  });

  it("fails closed when the bound source root inode changes during traversal", async () => {
    const seeded = await seedSkill();
    const parked = `${seeded.sourceDir}-parked`;
    cleanupDirs.add(parked);
    const originalLstat = fs.lstat.bind(fs);
    let rootLstatCount = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === seeded.sourceDir && ++rootLstatCount === 2) {
        await fs.rename(seeded.sourceDir, parked);
        await fs.mkdir(seeded.sourceDir, { mode: 0o700 });
        await fs.writeFile(path.join(seeded.sourceDir, "SKILL.md"), FRESH_SKILL_MARKDOWN, "utf8");
      }
      return originalLstat(target, options as never);
    });

    await expect(svc.resyncPreflight(seeded.companyId, seeded.skillId)).rejects.toMatchObject({ status: 422 });
  });

  it("fails closed when a bound nested directory inode changes during traversal", async () => {
    const seeded = await seedSkill();
    const referencesDir = path.join(seeded.sourceDir, "references");
    const parked = `${referencesDir}-parked`;
    const originalLstat = fs.lstat.bind(fs);
    let referencesLstatCount = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === referencesDir && ++referencesLstatCount === 2) {
        await fs.rename(referencesDir, parked);
        await fs.mkdir(referencesDir, { mode: 0o700 });
        await fs.writeFile(path.join(referencesDir, "guide.md"), FRESH_GUIDE_MARKDOWN, "utf8");
      }
      return originalLstat(target, options as never);
    });

    await expect(svc.resyncPreflight(seeded.companyId, seeded.skillId)).rejects.toMatchObject({ status: 422 });
  });

  it("CAS-syncs stale base markdown and creates exactly one clean source version", async () => {
    const seeded = await seedSkill();
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    const request = requestFromPreflight(preflight, seeded.agentId);

    const result = await svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    );
    expect(result).toMatchObject({
      schemaVersion: "1.0.0",
      previousVersionId: seeded.oldVersionId,
      previousBaseMarkdownSha256: preflight.baseMarkdownSha256,
      previousBaseFileInventorySha256: preflight.baseFileInventorySha256,
      baseFileInventorySha256: preflight.sourceFileInventorySha256,
      previousTrustLevel: preflight.baseTrustLevel,
      trustLevel: preflight.sourceTrustLevel,
      baseMarkdownChanged: true,
      baseFileInventoryChanged: true,
      trustLevelChanged: false,
      versionCreated: true,
      idempotentReplay: false,
      auditReceiptId: expect.any(String),
      sourceInventorySha256: preflight.sourceInventorySha256,
      currentVersionInventorySha256: preflight.sourceInventorySha256,
    });
    expect(result.currentVersionId).not.toBe(seeded.oldVersionId);

    const stored = await db.select().from(companySkills).where(eq(companySkills.id, seeded.skillId)).then((rows) => rows[0]);
    expect(stored.markdown).toContain("# Fresh Skill");
    expect(stored.currentVersionId).toBe(result.currentVersionId);
    const versions = await svc.listVersions(seeded.companyId, seeded.skillId);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.fileInventory.map((entry) => entry.path)).toEqual(["SKILL.md", "references/guide.md"]);
    const committedReceipt = await db.select().from(activityLog)
      .where(eq(activityLog.id, result.auditReceiptId)).then((rows) => rows[0]);
    expect(committedReceipt).toMatchObject({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board",
      action: "company.skill_source_resync_committed",
      entityType: "company_skill",
      entityId: seeded.skillId,
      details: {
        request: {
          approvalIssue: "TEC-355",
          maintenanceOperationId: MAINTENANCE_OPERATION_ID,
          expectedCurrentVersionId: seeded.oldVersionId,
          expectedSourceInventorySha256: preflight.sourceInventorySha256,
        },
        result: {
          previousVersionId: seeded.oldVersionId,
          currentVersionId: result.currentVersionId,
          baseFileInventoryChanged: true,
          trustLevelChanged: false,
          previousBaseFileInventorySha256: preflight.baseFileInventorySha256,
          baseFileInventorySha256: preflight.sourceFileInventorySha256,
          previousTrustLevel: preflight.baseTrustLevel,
          trustLevel: preflight.sourceTrustLevel,
        },
      },
    });

    const replay = await svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    );
    expect(replay).toMatchObject({
      currentVersionId: result.currentVersionId,
      versionCreated: false,
      idempotentReplay: true,
      auditReceiptId: expect.any(String),
    });
    expect(replay.auditReceiptId).not.toBe(result.auditReceiptId);
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toHaveLength(2);
  });

  it("rejects stale structural expectations before any base or version mutation", async () => {
    const seeded = await seedSkill();
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    const request = requestFromPreflight(preflight, seeded.agentId);
    request.expectedCurrentVersionInventorySha256 = `v1:sha256:${"0".repeat(64)}`;

    await expect(svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    )).rejects.toMatchObject({ status: 409 });
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toHaveLength(1);
    const stored = await db.select().from(companySkills).where(eq(companySkills.id, seeded.skillId)).then((rows) => rows[0]);
    expect(stored.markdown).toBe("# Stale Skill\n");
    expect(stored.currentVersionId).toBe(seeded.oldVersionId);
  });

  it("rolls back skill and version changes when the committed audit receipt cannot be written", async () => {
    const seeded = await seedSkill();
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    const request = requestFromPreflight(preflight, seeded.agentId);
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION reject_skill_resync_commit_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'company.skill_source_resync_committed' THEN
          RAISE EXCEPTION 'audit unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_skill_resync_commit_audit_insert
      BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION reject_skill_resync_commit_audit();
    `));
    try {
      await expect(svc.resyncFromSource(
        seeded.companyId,
        seeded.skillId,
        request,
        { type: "user", userId: "board" },
      )).rejects.toBeDefined();
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS reject_skill_resync_commit_audit_insert ON activity_log;
        DROP FUNCTION IF EXISTS reject_skill_resync_commit_audit();
      `));
    }

    const stored = await db.select().from(companySkills)
      .where(eq(companySkills.id, seeded.skillId)).then((rows) => rows[0]!);
    expect(stored).toMatchObject({
      markdown: "# Stale Skill\n",
      currentVersionId: seeded.oldVersionId,
      trustLevel: "markdown_only",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toHaveLength(1);
    expect(await db.select().from(activityLog)
      .where(eq(activityLog.action, "company.skill_source_resync_committed"))).toHaveLength(0);
  });

  it("rejects a gated replay after base inventory or trust metadata is tampered", async () => {
    const seeded = await seedSkill();
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    const request = requestFromPreflight(preflight, seeded.agentId);
    const first = await svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    );
    await db.update(companySkills).set({
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      trustLevel: "assets",
      updatedAt: new Date(),
    }).where(eq(companySkills.id, seeded.skillId));

    await expect(svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    )).rejects.toMatchObject({
      status: 409,
      details: { code: "skill_resync_state_cas_mismatch" },
    });
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toHaveLength(2);
    const stored = await db.select().from(companySkills)
      .where(eq(companySkills.id, seeded.skillId)).then((rows) => rows[0]!);
    expect(stored).toMatchObject({
      currentVersionId: first.currentVersionId,
      trustLevel: "assets",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });
  });

  it("rejects a recovery label that is not exactly bound to the operation, skill, old version, and source", async () => {
    const seeded = await seedSkill();
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    const request = requestFromPreflight(preflight, seeded.agentId);
    request.label = `TEC-355 skill-resync ${request.maintenanceOperationId}`;

    await expect(svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    )).rejects.toMatchObject({ status: 422 });
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toHaveLength(1);
    const stored = await db.select().from(companySkills).where(eq(companySkills.id, seeded.skillId)).then((rows) => rows[0]);
    expect(stored.markdown).toBe("# Stale Skill\n");
    expect(stored.currentVersionId).toBe(seeded.oldVersionId);
  });

  it("fails closed on malformed pinned-version inventory instead of coercing it into recovery evidence", async () => {
    const seeded = await seedSkill();
    await db.update(companySkillVersions).set({
      fileInventory: [{ path: "SKILL.md", kind: "skill", content: 42 }] as any,
    }).where(eq(companySkillVersions.id, seeded.oldVersionId));

    await expect(svc.resyncPreflight(seeded.companyId, seeded.skillId)).rejects.toMatchObject({ status: 422 });
    const stored = await db.select().from(companySkills).where(eq(companySkills.id, seeded.skillId)).then((rows) => rows[0]);
    expect(stored.markdown).toBe("# Stale Skill\n");
    expect(stored.currentVersionId).toBe(seeded.oldVersionId);
  });

  it("rejects resync when the exact affected-agent maintenance gate is not quiesced", async () => {
    const seeded = await seedSkill();
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    const request = requestFromPreflight(preflight, seeded.agentId);
    await db.update(agentPortfolioMaintenanceGates).set({ stage: "fenced" })
      .where(eq(agentPortfolioMaintenanceGates.agentId, seeded.agentId));

    await expect(svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    )).rejects.toMatchObject({
      status: 409,
      details: { code: "skill_resync_maintenance_gate_mismatch" },
    });
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toHaveLength(1);
  });

  it("rejects forged or incomplete affected-agent maintenance coverage", async () => {
    const seeded = await seedSkill();
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    const request = requestFromPreflight(preflight, randomUUID());

    await expect(svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    )).rejects.toMatchObject({
      status: 409,
      details: { code: "skill_resync_maintenance_scope_mismatch" },
    });
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toHaveLength(1);
  });

  it("rejects a forged empty maintenance scope when pinned and source inventories differ", async () => {
    const seeded = await seedSkill();
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    const request = baseOnlyRequestFromPreflight(preflight);

    await expect(svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    )).rejects.toMatchObject({ status: 422 });
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toHaveLength(1);
  });

  it("base-only resyncs only bounded base fields with a quiesced maintenance proof and no version change", async () => {
    const seeded = await seedSkill();
    await alignPinnedVersionWithSource(seeded.oldVersionId);
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    expect(preflight).toMatchObject({
      affectedAgentIds: [seeded.agentId],
      currentVersionId: seeded.oldVersionId,
      currentVersionInventorySha256: preflight.sourceInventorySha256,
    });
    const request = baseOnlyRequestFromPreflight(preflight);
    const beforeAgentConfig = await db.select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, seeded.agentId))
      .then((rows) => rows[0]!.adapterConfig);
    const beforeVersions = await svc.listVersions(seeded.companyId, seeded.skillId);

    const result = await svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    );

    expect(result).toMatchObject({
      previousVersionId: seeded.oldVersionId,
      currentVersionId: seeded.oldVersionId,
      baseMarkdownChanged: true,
      versionCreated: false,
      idempotentReplay: false,
      currentVersionInventorySha256: preflight.sourceInventorySha256,
    });
    const stored = await db.select().from(companySkills)
      .where(eq(companySkills.id, seeded.skillId))
      .then((rows) => rows[0]!);
    expect(stored).toMatchObject({
      name: "Stale Skill",
      description: null,
      markdown: FRESH_SKILL_MARKDOWN,
      currentVersionId: seeded.oldVersionId,
    });
    expect(stored.fileInventory).toEqual([
      { path: "SKILL.md", kind: "skill" },
      { path: "references/guide.md", kind: "reference" },
    ]);
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toEqual(beforeVersions);
    await expect(db.select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, seeded.agentId))
      .then((rows) => rows[0]!.adapterConfig)).resolves.toEqual(beforeAgentConfig);

    await expect(svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    )).rejects.toMatchObject({
      status: 409,
      details: { code: "skill_resync_base_only_cas_mismatch" },
    });
  });

  it.each([
    ["released", async (seeded: Awaited<ReturnType<typeof seedSkill>>) => {
      await db.delete(agentPortfolioMaintenanceGates)
        .where(eq(agentPortfolioMaintenanceGates.agentId, seeded.agentId));
    }],
    ["stale", async (seeded: Awaited<ReturnType<typeof seedSkill>>) => {
      await db.update(agentPortfolioMaintenanceGates).set({ stage: "fenced" })
        .where(eq(agentPortfolioMaintenanceGates.agentId, seeded.agentId));
    }],
    ["other-company", async (seeded: Awaited<ReturnType<typeof seedSkill>>) => {
      await db.delete(agentPortfolioMaintenanceGates)
        .where(eq(agentPortfolioMaintenanceGates.agentId, seeded.agentId));
      const otherCompanyId = randomUUID();
      const otherAgentId = randomUUID();
      await db.insert(companies).values({
        id: otherCompanyId,
        name: "Other Maintenance Company",
        issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Foreign Maintenance Agent",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(agentPortfolioMaintenanceGates).values({
        companyId: otherCompanyId,
        agentId: otherAgentId,
        operationId: MAINTENANCE_OPERATION_ID,
        expectedSnapshotFingerprint: MAINTENANCE_SNAPSHOT_FINGERPRINT,
        recoveryFingerprint: `v1:sha256:${"8".repeat(64)}`,
        receiptId: MAINTENANCE_RECEIPT_ID,
        stage: "quiesced",
        issuedByUserId: "board",
      });
    }],
  ])("rejects base-only resync with a %s maintenance proof", async (_caseName, arrange) => {
    const seeded = await seedSkill();
    await alignPinnedVersionWithSource(seeded.oldVersionId);
    await arrange(seeded);
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);

    await expect(svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      baseOnlyRequestFromPreflight(preflight),
      { type: "user", userId: "board" },
    )).rejects.toMatchObject({
      status: 409,
      details: { code: "skill_resync_base_only_maintenance_gate_mismatch" },
    });
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toHaveLength(1);
  });

  it("repairs trust-only base drift without changing the pinned version or store metadata", async () => {
    const seeded = await seedSkill();
    await alignPinnedVersionWithSource(seeded.oldVersionId);
    await db.update(companySkills).set({
      markdown: FRESH_SKILL_MARKDOWN,
      fileInventory: [
        { path: "SKILL.md", kind: "skill" },
        { path: "references/guide.md", kind: "reference" },
      ],
      trustLevel: "assets",
    }).where(eq(companySkills.id, seeded.skillId));
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    expect(preflight).toMatchObject({
      baseTrustLevel: "assets",
      sourceTrustLevel: "markdown_only",
      baseMarkdownSha256: preflight.sourceSkillMarkdownSha256,
    });

    const result = await svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      baseOnlyRequestFromPreflight(preflight),
      { type: "user", userId: "board" },
    );

    expect(result).toMatchObject({
      currentVersionId: seeded.oldVersionId,
      baseMarkdownChanged: false,
      baseFileInventoryChanged: false,
      trustLevelChanged: true,
      previousTrustLevel: "assets",
      trustLevel: "markdown_only",
      versionCreated: false,
      auditReceiptId: expect.any(String),
    });
    const stored = await db.select().from(companySkills)
      .where(eq(companySkills.id, seeded.skillId)).then((rows) => rows[0]!);
    expect(stored).toMatchObject({ name: "Stale Skill", trustLevel: "markdown_only" });
  });

  it("repairs base-file-inventory-only drift without changing the pinned version", async () => {
    const seeded = await seedSkill();
    await alignPinnedVersionWithSource(seeded.oldVersionId);
    await db.update(companySkills).set({
      markdown: FRESH_SKILL_MARKDOWN,
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      trustLevel: "markdown_only",
    }).where(eq(companySkills.id, seeded.skillId));
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    expect(preflight.baseFileInventorySha256).not.toBe(preflight.sourceFileInventorySha256);

    const result = await svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      baseOnlyRequestFromPreflight(preflight),
      { type: "user", userId: "board" },
    );

    expect(result).toMatchObject({
      baseMarkdownChanged: false,
      baseFileInventoryChanged: true,
      trustLevelChanged: false,
      previousBaseFileInventorySha256: preflight.baseFileInventorySha256,
      baseFileInventorySha256: preflight.sourceFileInventorySha256,
      auditReceiptId: expect.any(String),
    });

    const stored = await db.select().from(companySkills)
      .where(eq(companySkills.id, seeded.skillId)).then((rows) => rows[0]!);
    expect(stored.currentVersionId).toBe(seeded.oldVersionId);
    expect(stored.fileInventory).toEqual([
      { path: "SKILL.md", kind: "skill" },
      { path: "references/guide.md", kind: "reference" },
    ]);
  });

  it("fails base-only resync on a locked pinned-inventory CAS race without mutating skill or agents", async () => {
    const seeded = await seedSkill();
    await alignPinnedVersionWithSource(seeded.oldVersionId);
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    const request = baseOnlyRequestFromPreflight(preflight);
    const beforeAgentConfig = await db.select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, seeded.agentId))
      .then((rows) => rows[0]!.adapterConfig);
    await db.update(companySkillVersions).set({
      fileInventory: [
        { path: "SKILL.md", kind: "skill", content: FRESH_SKILL_MARKDOWN },
        { path: "references/guide.md", kind: "reference", content: "# Raced Guide\n" },
      ],
    }).where(eq(companySkillVersions.id, seeded.oldVersionId));

    await expect(svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    )).rejects.toMatchObject({
      status: 409,
      details: { code: "skill_resync_base_only_inventory_mismatch" },
    });

    const stored = await db.select().from(companySkills)
      .where(eq(companySkills.id, seeded.skillId))
      .then((rows) => rows[0]!);
    expect(stored).toMatchObject({
      name: "Stale Skill",
      markdown: "# Stale Skill\n",
      currentVersionId: seeded.oldVersionId,
    });
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toHaveLength(1);
    await expect(db.select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, seeded.agentId))
      .then((rows) => rows[0]!.adapterConfig)).resolves.toEqual(beforeAgentConfig);
  });

  it("fails closed when an ambiguous retry has two exact label-and-inventory versions", async () => {
    const seeded = await seedSkill();
    const preflight = await svc.resyncPreflight(seeded.companyId, seeded.skillId);
    const request = requestFromPreflight(preflight, seeded.agentId);
    const first = await svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    );
    const created = await svc.getVersion(seeded.companyId, seeded.skillId, first.currentVersionId);
    expect(created).not.toBeNull();
    await db.insert(companySkillVersions).values({
      companyId: seeded.companyId,
      companySkillId: seeded.skillId,
      revisionNumber: 3,
      label: request.label,
      fileInventory: created!.fileInventory,
      authorUserId: "board",
    });

    await expect(svc.resyncFromSource(
      seeded.companyId,
      seeded.skillId,
      request,
      { type: "user", userId: "board" },
    )).rejects.toMatchObject({ status: 409 });
    const stored = await db.select().from(companySkills).where(eq(companySkills.id, seeded.skillId)).then((rows) => rows[0]);
    expect(stored.currentVersionId).toBe(first.currentVersionId);
    expect(await svc.listVersions(seeded.companyId, seeded.skillId)).toHaveLength(3);
  });
});
