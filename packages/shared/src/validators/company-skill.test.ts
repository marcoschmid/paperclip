import { describe, expect, it } from "vitest";
import {
  catalogSkillFileDetailSchema,
  catalogSkillListQuerySchema,
  companySkillAuditResultSchema,
  companySkillInstallCatalogResultSchema,
  companySkillInstallCatalogSchema,
  companySkillInstallUpdateSchema,
  companySkillResyncPreflightSchema,
  companySkillResyncRequestSchema,
  companySkillResetSchema,
  companySkillUpdateStatusSchema,
} from "./company-skill.js";

const catalogSkill = {
  id: "paperclipai:bundled:software-development:review",
  key: "paperclipai/bundled/software-development/review",
  kind: "bundled",
  category: "software-development",
  slug: "review",
  name: "review",
  description: "Review code",
  path: "catalog/bundled/software-development/review",
  entrypoint: "SKILL.md",
  trustLevel: "markdown_only",
  compatibility: "compatible",
  defaultInstall: false,
  recommendedForRoles: ["engineer"],
  requires: [],
  tags: ["review"],
  files: [{ path: "SKILL.md", kind: "skill", sizeBytes: 8, sha256: "abc" }],
  contentHash: "sha256:abc",
  source: {
    type: "github",
    hostname: "github.com",
    owner: "example",
    repo: "review-skill",
    ref: "v1.0.0",
    commit: "0123456789abcdef0123456789abcdef01234567",
    path: "skills/review",
    url: "https://github.com/example/review-skill/tree/v1.0.0/skills/review",
  },
};

const companySkill = {
  id: "00000000-0000-4000-8000-000000000001",
  companyId: "00000000-0000-4000-8000-000000000002",
  key: catalogSkill.key,
  slug: catalogSkill.slug,
  name: catalogSkill.name,
  description: catalogSkill.description,
  markdown: "# Review\n",
  sourceType: "catalog",
  sourceLocator: "/tmp/review",
  sourceRef: catalogSkill.contentHash,
  trustLevel: "markdown_only",
  compatibility: "compatible",
  fileInventory: [{ path: "SKILL.md", kind: "skill" }],
  iconUrl: null,
  color: null,
  tagline: null,
  authorName: null,
  homepageUrl: null,
  categories: [],
  sharingScope: "private",
  publicShareToken: null,
  forkedFromSkillId: null,
  forkedFromCompanyId: null,
  starCount: 0,
  installCount: 1,
  forkCount: 0,
  currentVersionId: null,
  metadata: {
    sourceKind: "catalog",
    catalogId: catalogSkill.id,
    originHash: catalogSkill.contentHash,
  },
  createdAt: "2026-05-26T00:00:00.000Z",
  updatedAt: "2026-05-26T00:00:00.000Z",
};

describe("company skill catalog validators", () => {
  it("accepts catalog list and install request shapes", () => {
    expect(catalogSkillListQuerySchema.parse({
      kind: "bundled",
      category: "software-development",
      q: "review",
    })).toEqual({
      kind: "bundled",
      category: "software-development",
      q: "review",
    });

    expect(companySkillInstallCatalogSchema.parse({
      catalogSkillId: catalogSkill.id,
      slug: "team-review",
      force: true,
    })).toEqual({
      catalogSkillId: catalogSkill.id,
      slug: "team-review",
      force: true,
    });
  });

  it("rejects invalid catalog filter and install payloads", () => {
    expect(() => catalogSkillListQuerySchema.parse({ kind: "external" })).toThrow();
    expect(() => companySkillInstallCatalogSchema.parse({ force: true })).toThrow();
  });

  it("accepts catalog file and install result responses", () => {
    expect(catalogSkillFileDetailSchema.parse({
      catalogSkillId: catalogSkill.id,
      path: "SKILL.md",
      kind: "skill",
      content: "# Review\n",
      language: "markdown",
      markdown: true,
    })).toMatchObject({
      catalogSkillId: catalogSkill.id,
      path: "SKILL.md",
    });

    expect(companySkillInstallCatalogResultSchema.parse({
      action: "created",
      skill: companySkill,
      catalogSkill,
      warnings: [],
    })).toMatchObject({
      action: "created",
      skill: {
        key: catalogSkill.key,
        sourceType: "catalog",
      },
      catalogSkill: {
        id: catalogSkill.id,
        source: catalogSkill.source,
      },
    });
  });

  it("accepts update status, audit, update, and reset contract shapes", () => {
    expect(companySkillUpdateStatusSchema.parse({
      supported: true,
      reason: null,
      trackingRef: catalogSkill.id,
      currentRef: "sha256:old",
      latestRef: catalogSkill.contentHash,
      hasUpdate: true,
      installedHash: "sha256:installed",
      originHash: catalogSkill.contentHash,
      userModifiedAt: "2026-05-26T00:00:00.000Z",
      updateHoldReason: "local_modifications",
      auditVerdict: "warning",
      auditCodes: ["local_modifications"],
    })).toMatchObject({
      supported: true,
      updateHoldReason: "local_modifications",
      auditVerdict: "warning",
    });

    expect(companySkillAuditResultSchema.parse({
      skillId: companySkill.id,
      installedHash: "sha256:installed",
      originHash: catalogSkill.contentHash,
      verdict: "fail",
      codes: ["remote_fetch_exec"],
      findings: [{
        code: "remote_fetch_exec",
        severity: "error",
        message: "Remote-fetch or dynamic execution pattern is not allowed.",
        path: "SKILL.md",
      }],
      scannedAt: "2026-05-26T00:00:00.000Z",
      scanVersion: "skills-audit-v1",
    })).toMatchObject({
      verdict: "fail",
      codes: ["remote_fetch_exec"],
    });

    expect(companySkillInstallUpdateSchema.parse(undefined)).toEqual({});
    expect(companySkillInstallUpdateSchema.parse({ force: true })).toEqual({ force: true });
    expect(companySkillResetSchema.parse(undefined)).toEqual({});
    expect(companySkillResetSchema.parse({ force: true })).toEqual({ force: true });
  });
});

describe("company skill resync validators", () => {
  const agentIds = Array.from({ length: 101 }, (_, index) =>
    `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`);
  const inventorySha256 = `v1:sha256:${"a".repeat(64)}`;
  const otherInventorySha256 = `v1:sha256:${"b".repeat(64)}`;
  const fingerprint = `v1:sha256:${"c".repeat(64)}`;
  const request = {
    schemaVersion: "1.0.0",
    approvalIssue: "TEC-355",
    maintenanceOperationId: "10000000-0000-4000-8000-000000000001",
    maintenanceAgentIds: [agentIds[0]],
    maintenanceReceiptId: fingerprint,
    maintenanceExpectedSnapshotFingerprint: fingerprint,
    label: "TEC-355 skill-resync test",
    expectedSkillKey: "local/example/review",
    expectedSourceType: "local_path",
    expectedSourceInventoryMode: "full",
    expectedSourceLocatorSha256: fingerprint,
    expectedSkillUpdatedAt: "2026-07-13T08:00:00.000Z",
    expectedCurrentVersionId: "20000000-0000-4000-8000-000000000001",
    expectedBaseMarkdownSha256: fingerprint,
    expectedCurrentVersionInventorySha256: inventorySha256,
    expectedSourceSkillMarkdownSha256: fingerprint,
    expectedSourceInventorySha256: otherInventorySha256,
    expectedBaseFileInventorySha256: fingerprint,
    expectedSourceFileInventorySha256: fingerprint,
    expectedBaseTrustLevel: "markdown_only",
    expectedSourceTrustLevel: "markdown_only",
  } as const;

  it("allows an exact sorted unique 0..100 GET scope", () => {
    expect(companySkillResyncPreflightSchema.shape.affectedAgentIds.parse([])).toEqual([]);
    expect(companySkillResyncPreflightSchema.shape.affectedAgentIds.parse(agentIds.slice(0, 100)))
      .toEqual(agentIds.slice(0, 100));
    expect(companySkillResyncPreflightSchema.shape.affectedAgentIds.safeParse(agentIds).success).toBe(false);
    expect(companySkillResyncPreflightSchema.shape.affectedAgentIds.safeParse([agentIds[1], agentIds[0]]).success)
      .toBe(false);
    expect(companySkillResyncPreflightSchema.shape.affectedAgentIds.safeParse([agentIds[0], agentIds[0]]).success)
      .toBe(false);
  });

  it("accepts an empty maintenance scope only for an exact base-only inventory claim", () => {
    expect(companySkillResyncRequestSchema.parse({
      ...request,
      maintenanceAgentIds: [],
      maintenanceReceiptId: null,
      maintenanceExpectedSnapshotFingerprint: null,
      expectedSourceInventorySha256: inventorySha256,
    })).toMatchObject({
      maintenanceAgentIds: [],
      maintenanceReceiptId: null,
      maintenanceExpectedSnapshotFingerprint: null,
      expectedCurrentVersionInventorySha256: inventorySha256,
      expectedSourceInventorySha256: inventorySha256,
    });
  });

  it("rejects forged empty-scope inventory drift and receipt/fingerprint hybrids", () => {
    expect(companySkillResyncRequestSchema.safeParse({
      ...request,
      maintenanceAgentIds: [],
      maintenanceReceiptId: null,
      maintenanceExpectedSnapshotFingerprint: null,
    }).success).toBe(false);
    expect(companySkillResyncRequestSchema.safeParse({
      ...request,
      maintenanceAgentIds: [],
      maintenanceExpectedSnapshotFingerprint: null,
      expectedSourceInventorySha256: inventorySha256,
    }).success).toBe(false);
    expect(companySkillResyncRequestSchema.safeParse({
      ...request,
      maintenanceAgentIds: [],
      maintenanceReceiptId: null,
      expectedSourceInventorySha256: inventorySha256,
    }).success).toBe(false);
    expect(companySkillResyncRequestSchema.safeParse({
      ...request,
      maintenanceAgentIds: [],
      maintenanceReceiptId: null,
      maintenanceExpectedSnapshotFingerprint: null,
      expectedSourceInventoryMode: "project_root",
      expectedSourceInventorySha256: inventorySha256,
    }).success).toBe(false);
  });

  it("keeps the non-empty maintenance request contract and exact gate evidence unchanged", () => {
    expect(companySkillResyncRequestSchema.parse(request)).toEqual(request);
    expect(companySkillResyncRequestSchema.safeParse({
      ...request,
      maintenanceReceiptId: null,
      maintenanceExpectedSnapshotFingerprint: null,
    }).success).toBe(false);
    expect(companySkillResyncRequestSchema.safeParse({
      ...request,
      maintenanceAgentIds: [agentIds[1], agentIds[0]],
    }).success).toBe(false);
  });
});
