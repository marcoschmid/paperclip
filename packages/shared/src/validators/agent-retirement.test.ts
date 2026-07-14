import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as retirementContract from "./agent-retirement.js";

const SOURCE_ID = "007bcd1f-0462-4c9e-b58a-c6c546393f41";
const COMPANY_ID = "51eb52b7-49ed-461a-bd67-7384158374e6";
const REPLACEMENT_ID = "c41d7f42-d424-4615-ad71-0f4c5b9762fa";
const ISSUE_ID = "50d6efd7-85c7-4ce0-aceb-ff6a94127200";
const COMMENT_ID = "44444444-4444-4444-8444-444444444444";
const APPROVAL_NONCE = "1".repeat(64);
const MANIFEST_SHA256 = "2".repeat(64);

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function approvalBinding() {
  return {
    approvalNonce: APPROVAL_NONCE,
    manifestSha256: MANIFEST_SHA256,
    backupSha256: "b".repeat(64),
    restoreReceiptSha256: "e".repeat(64),
  };
}

function approvalText() {
  return [
    "PAPERCLIP_RETIREMENT_APPROVAL_V1",
    "issue=TEC-355",
    "scope=26_allowlisted_sources_tombstone_only",
    `approvalNonce=${APPROVAL_NONCE}`,
    `manifestSha256=${MANIFEST_SHA256}`,
    `backupSha256=${"b".repeat(64)}`,
    `restoreReceiptSha256=${"e".repeat(64)}`,
  ].join("\n");
}

function validEvidence() {
  const replacement: {
    replacementAgentId: string | null;
    replacementSystemRef: string | null;
    canaryAgentId: string;
    canaryIssueId: string;
    canaryRunId: string;
    configFingerprint: string;
  } = {
    replacementAgentId: REPLACEMENT_ID,
    replacementSystemRef: null,
    canaryAgentId: REPLACEMENT_ID,
    canaryIssueId: "33333333-3333-4333-8333-333333333333",
    canaryRunId: "22222222-2222-4222-8222-222222222222",
    configFingerprint: `v1:sha256:${"d".repeat(64)}`,
  };
  return {
    schemaVersion: "1.0.0",
    source: {
      sourceAgentId: SOURCE_ID,
      companyId: COMPANY_ID,
      decision: "terminate",
      physicalDelete: false,
    },
    expectedUpdatedAt: "2026-07-13T10:00:00.000Z",
    sourceExport: {
      sourceAgentId: SOURCE_ID,
      path: "/tmp/retirement/source-export.json",
      sha256: "a".repeat(64),
      sizeBytes: 128,
      capturedAt: "2026-07-13T10:01:00.000Z",
    },
    backupRestore: {
      dumpPath: "/tmp/retirement/paperclip.sql.gz",
      dumpSha256: "b".repeat(64),
      dumpSizeBytes: 1024,
      dumpCapturedAt: "2026-07-13T10:02:00.000Z",
      masterKeyBackupPath: "/tmp/retirement/master.key",
      masterKeyBackupSha256: "c".repeat(64),
      masterKeyBackupSizeBytes: 65,
      masterKeyFingerprintSha256: "d".repeat(64),
      masterKeyCapturedAt: "2026-07-13T10:01:30.000Z",
      restoreEvidencePath: "/tmp/retirement/restore-evidence.json",
      restoreEvidenceSha256: "e".repeat(64),
      restoreEvidenceSizeBytes: 2048,
      restoreVerifiedAt: "2026-07-13T10:03:00.000Z",
      restoreStateSha256: "f".repeat(64),
    },
    replacement,
    humanGate: {
      issueIdentifier: "TEC-355",
      issueId: ISSUE_ID,
      commentId: COMMENT_ID,
      approvedAt: "2026-07-13T10:04:00.000Z",
      ...approvalBinding(),
      approvedTextSha256: sha256(approvalText()),
    },
  };
}

describe("agent retirement validators", () => {
  it("publishes an external exact 33-agent retained identity contract", () => {
    const retainedAgents = (retirementContract as unknown as Record<string, unknown>)
      .AGENT_RETIREMENT_RETAINED_AGENTS as Array<Record<string, unknown>> | undefined;
    expect(retainedAgents).toHaveLength(33);
    expect(new Set(retainedAgents?.map((row) => row.agentId))).toHaveProperty("size", 33);
    expect(retainedAgents?.every((row) => (
      typeof row.agentId === "string"
      && typeof row.companyId === "string"
      && typeof row.name === "string"
      && Object.keys(row).sort().join(",") === "agentId,companyId,name"
    ))).toBe(true);
  });

  it("publishes the exact 26-source termination allowlist and strict evidence schemas", async () => {
    expect(retirementContract.AGENT_RETIREMENT_ALLOWLIST).toBeInstanceOf(Map);
    expect(retirementContract.AGENT_RETIREMENT_ALLOWLIST.size).toBe(26);
    expect(retirementContract.AGENT_RETIREMENT_HISTORICAL_TOMBSTONES).toHaveLength(2);
    expect([...retirementContract.AGENT_RETIREMENT_HISTORICAL_TOMBSTONE_IDS]).toEqual([
      "8d403783-c4e2-4746-adad-7689cd95ae33",
      "dcd3cadb-8203-4048-be1e-77701a3a43a0",
    ]);
    expect(retirementContract.AGENT_RETIREMENT_HISTORICAL_TOMBSTONES.every((row) => (
      row.expectedStatus === "terminated"
      && row.disposition === "preserve_tombstone"
      && row.physicalDelete === false
    ))).toBe(true);
    expect(retirementContract.AGENT_RETIREMENT_ALLOWLIST.get(
      "3f406d3a-9b98-4687-9a89-61a3f927cbf5",
    )).toMatchObject({
      replacementAgentId: "7f84a9d1-5751-4427-853f-b85851f945d1",
      canaryAgentId: "7f84a9d1-5751-4427-853f-b85851f945d1",
    });
    expect(retirementContract.AGENT_RETIREMENT_ALLOWLIST.get(
      "0e989281-9933-47b9-87e5-b6da87d4d0a9",
    )).toMatchObject({
      replacementSystemRef: "workspace:projects/kaffee",
      canaryAgentId: "2f430983-3c02-4e58-90e3-821ae00f80c2",
    });
    expect(retirementContract.normalizeAgentRetirementId(
      "3F406D3A-9B98-4687-9A89-61A3F927CBF5",
    )).toBe("3f406d3a-9b98-4687-9a89-61a3f927cbf5");
    expect(retirementContract.normalizeAgentRetirementId("not-a-uuid")).toBeNull();
    expect(retirementContract.getAgentRetirementSource(
      "3F406D3A-9B98-4687-9A89-61A3F927CBF5",
    )).toMatchObject({ sourceAgentId: "3f406d3a-9b98-4687-9a89-61a3f927cbf5" });
    expect(retirementContract.isAgentRetirementSource(
      "3F406D3A-9B98-4687-9A89-61A3F927CBF5",
    )).toBe(true);
    expect(retirementContract.isAgentRetirementSource("not-a-uuid")).toBe(false);
    expect(retirementContract.agentRetirementEvidenceSchema).toBeDefined();
    expect(retirementContract.agentRetirementPlanSchema).toBeDefined();
    expect(retirementContract.agentRetirementPreflightRequestSchema).toBeDefined();
    expect(retirementContract.agentRetirementExecutionRecoveryRequestSchema).toBeDefined();
    expect(retirementContract.agentRetirementCleanupSchema).toBeDefined();
    expect(retirementContract.agentRetirementCleanupRequestSchema).toBeDefined();
    expect(retirementContract.agentRetirementTerminationSchema).toBeDefined();
    expect(retirementContract.agentRetirementTerminationReceiptSchema).toBeDefined();
  });

  it("requires an exact durable request receipt for recovery and an exact execution receipt for resume", () => {
    const request = {
      evidence: validEvidence(),
      planClaimReceiptId: `v1:sha256:${"3".repeat(64)}`,
      executionClaimReceiptId: `v1:sha256:${"4".repeat(64)}`,
      recoveryRequestReceiptId: `v1:sha256:${"5".repeat(64)}`,
      recoverExecution: true,
    };
    expect(retirementContract.agentRetirementExecutionRecoveryRequestSchema.safeParse(request).success)
      .toBe(true);
    expect(retirementContract.agentRetirementExecutionRecoveryRequestSchema.safeParse({
      ...request,
      recoveryRequestReceiptId: null,
    }).success).toBe(false);
    expect(retirementContract.agentRetirementExecutionRecoveryRequestSchema.safeParse({
      ...request,
      recoverExecution: false,
      recoveryRequestReceiptId: null,
    }).success).toBe(true);
    expect(retirementContract.agentRetirementExecutionRecoveryRequestSchema.safeParse({
      ...request,
      recoverExecution: false,
      executionClaimReceiptId: null,
      recoveryRequestReceiptId: null,
    }).success).toBe(false);
  });

  it("accepts only strict terminate evidence with exactly one allowlisted replacement kind", async () => {
    const schema = retirementContract.agentRetirementEvidenceSchema;
    expect(schema.safeParse(validEvidence()).success).toBe(true);

    const both = validEvidence();
    both.replacement.replacementSystemRef = "workspace:projects/kaffee";
    expect(schema.safeParse(both).success).toBe(false);

    const deletion = validEvidence();
    (deletion.source as Record<string, unknown>).physicalDelete = true;
    expect(schema.safeParse(deletion).success).toBe(false);

    const extra = { ...validEvidence(), hardDelete: true };
    expect(schema.safeParse(extra).success).toBe(false);

    const hashOnly = validEvidence();
    delete (hashOnly.sourceExport as Partial<typeof hashOnly.sourceExport>).path;
    expect(schema.safeParse(hashOnly).success).toBe(false);

    const zeroLength = validEvidence();
    zeroLength.backupRestore.dumpSizeBytes = 0;
    expect(schema.safeParse(zeroLength).success).toBe(false);
  });

  it("binds cleanup and termination to versioned fingerprints, current updatedAt, and the TEC-355 comment", async () => {
    const evidence = validEvidence();
    const cleanup = {
      ...evidence,
      preflightFingerprint: `v1:sha256:${"f".repeat(64)}`,
    };
    expect(retirementContract.agentRetirementCleanupSchema.safeParse(cleanup).success).toBe(true);
    const termination = {
      cleanupReceiptId: `v1:sha256:${"1".repeat(64)}`,
      preflightFingerprint: `v1:sha256:${"2".repeat(64)}`,
      expectedUpdatedAt: evidence.expectedUpdatedAt,
      humanGate: evidence.humanGate,
      planClaimReceiptId: `v1:sha256:${"3".repeat(64)}`,
      executionClaimReceiptId: `v1:sha256:${"4".repeat(64)}`,
    };
    expect(retirementContract.agentRetirementTerminationSchema.safeParse(termination).success).toBe(true);
    const { executionClaimReceiptId: _missing, ...incomplete } = termination;
    expect(retirementContract.agentRetirementTerminationSchema.safeParse(incomplete).success).toBe(false);
  });

  it("accepts only the exact structured one-time retirement approval comment", () => {
    expect(retirementContract.formatAgentRetirementApprovalComment(approvalBinding())).toBe(approvalText());
    expect(retirementContract.parseAgentRetirementApprovalComment(approvalText())).toEqual(approvalBinding());
    expect(retirementContract.parseAgentRetirementApprovalComment("Erledige alles")).toBeNull();
    expect(retirementContract.parseAgentRetirementApprovalComment(`${approvalText()}\n`)).toBeNull();
    for (const invalidLength of [32, 63, 65, 128]) {
      const invalidBinding = {
        ...approvalBinding(),
        approvalNonce: "a".repeat(invalidLength),
      };
      expect(
        retirementContract.agentRetirementApprovalBindingSchema.safeParse(invalidBinding).success,
        `approval nonce length ${invalidLength}`,
      ).toBe(false);
      expect(retirementContract.parseAgentRetirementApprovalComment(
        approvalText().replace(APPROVAL_NONCE, invalidBinding.approvalNonce),
      )).toBeNull();
    }

    const legacy = validEvidence();
    legacy.humanGate = {
      issueIdentifier: "TEC-355",
      issueId: ISSUE_ID,
      commentId: COMMENT_ID,
      approvedTextSha256: sha256("Erledige alles"),
    } as typeof legacy.humanGate;
    expect(retirementContract.agentRetirementEvidenceSchema.safeParse(legacy).success).toBe(false);
  });

  it("rejects approval bindings that do not match the exact backup and restore receipt", () => {
    const wrongBackup = validEvidence();
    wrongBackup.humanGate.backupSha256 = "3".repeat(64);
    expect(retirementContract.agentRetirementEvidenceSchema.safeParse(wrongBackup).success).toBe(false);

    const wrongRestore = validEvidence();
    wrongRestore.humanGate.restoreReceiptSha256 = "4".repeat(64);
    expect(retirementContract.agentRetirementEvidenceSchema.safeParse(wrongRestore).success).toBe(false);

    const staleApproval = validEvidence();
    staleApproval.humanGate.approvedAt = staleApproval.backupRestore.restoreVerifiedAt;
    expect(retirementContract.agentRetirementEvidenceSchema.safeParse(staleApproval).success).toBe(false);
  });
});
