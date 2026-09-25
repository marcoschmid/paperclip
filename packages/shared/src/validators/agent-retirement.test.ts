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
    "scope=wave2_1_allowlisted_sources_tombstone_only",
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
    expect(retainedAgents?.filter((row) => (
      retirementContract.AGENT_RETIREMENT_ALLOWLIST.has(row.agentId as string)
    ))).toEqual([]);
    expect(retainedAgents?.every((row) => (
      typeof row.agentId === "string"
      && typeof row.companyId === "string"
      && typeof row.name === "string"
      && Object.keys(row).sort().join(",") === "agentId,companyId,name"
    ))).toBe(true);
  });

  it("publishes the exact 27-source termination allowlist and strict evidence schemas", async () => {
    expect(retirementContract.AGENT_RETIREMENT_ALLOWLIST).toBeInstanceOf(Map);
    expect(retirementContract.AGENT_RETIREMENT_ALLOWLIST.size).toBe(27);
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
    expect(retirementContract.AGENT_RETIREMENT_ALLOWLIST.get(
      "04c5ffc3-7eb8-428f-8225-0c50063667e9",
    )).toEqual({
      sourceAgentId: "04c5ffc3-7eb8-428f-8225-0c50063667e9",
      companyId: "f5ba56a6-afcd-43ad-8db7-fe6219139c4a",
      sourceName: "Authentik IAM Admin",
      replacementAgentId: "96c36604-fa6b-4a15-9027-2f0b50e32cea",
      replacementSystemRef: null,
      canaryAgentId: "96c36604-fa6b-4a15-9027-2f0b50e32cea",
      decisionIssueId: "50d6efd7-85c7-4ce0-aceb-ff6a94127200",
      retirementWave: 2,
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

  it("publishes contiguous retirement waves with July as wave 1 and Authentik as the current wave", () => {
    const waves = retirementContract.AGENT_RETIREMENT_WAVES;
    expect(waves.map((wave) => [wave.wave, wave.sourceIds.length])).toEqual([[1, 26], [2, 1]]);
    expect(retirementContract.AGENT_RETIREMENT_CURRENT_WAVE).toEqual({
      wave: 2,
      sourceIds: ["04c5ffc3-7eb8-428f-8225-0c50063667e9"],
    });
    expect(waves[0]!.sourceIds).not.toContain("04c5ffc3-7eb8-428f-8225-0c50063667e9");
    expect(waves[0]!.sourceIds).toEqual([...waves[0]!.sourceIds].sort());
    expect(waves.flatMap((wave) => wave.sourceIds).sort())
      .toEqual([...retirementContract.AGENT_RETIREMENT_ALLOWLIST.keys()].sort());
    expect(retirementContract.AGENT_RETIREMENT_ALLOWLIST_ENTRIES.every((entry) => (
      waves[entry.retirementWave - 1]!.sourceIds.includes(entry.sourceAgentId)
    ))).toBe(true);
    expect(retirementContract.agentRetirementApprovalScope(retirementContract.AGENT_RETIREMENT_CURRENT_WAVE))
      .toBe("wave2_1_allowlisted_sources_tombstone_only");
    expect(retirementContract.AGENT_RETIREMENT_APPROVAL_SCOPE).toBe("wave2_1_allowlisted_sources_tombstone_only");
  });

  it("rejects retirement waves that are missing, fractional, zero, or not contiguous", () => {
    const entry = (sourceAgentId: string, retirementWave: unknown) => ({
      sourceAgentId,
      retirementWave: retirementWave as number,
    });
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect(retirementContract.buildAgentRetirementWaves([entry(second, 1), entry(first, 1)]))
      .toEqual([{ wave: 1, sourceIds: [first, second] }]);
    for (const invalid of [
      [entry(first, undefined)],
      [entry(first, 1.5)],
      [entry(first, 0)],
      [entry(first, "1")],
      [entry(first, 1), entry(second, 3)],
      [entry(first, 2)],
      [entry(first, 1), entry(first, 2)],
      [],
    ]) {
      expect(() => retirementContract.buildAgentRetirementWaves(invalid), JSON.stringify(invalid)).toThrow();
    }
  });

  it("validates plan and evidence bundle shape while the service binds the exact wave scope", () => {
    const evidence = validEvidence();
    expect(retirementContract.agentRetirementEvidenceBySourceIdSchema.safeParse({
      [SOURCE_ID]: evidence,
    }).success).toBe(true);
    expect(retirementContract.agentRetirementEvidenceBySourceIdSchema.safeParse({}).success).toBe(false);
    expect(retirementContract.agentRetirementEvidenceBySourceIdSchema.safeParse({
      [REPLACEMENT_ID]: evidence,
    }).success).toBe(false);
    const plan = {
      schemaVersion: "1.0.0",
      kind: "paperclip_retirement_plan",
      manifestFingerprint: `v1:sha256:${"1".repeat(64)}`,
      sourceIds: [SOURCE_ID],
      evidenceSha256: "2".repeat(64),
      approvalCommentId: COMMENT_ID,
      approvalFingerprint: `v1:sha256:${"3".repeat(64)}`,
      validatedAt: "2026-07-13T10:05:00.000Z",
      expiresAt: "2026-07-13T16:05:00.000Z",
      commonArtifactFingerprint: `v1:sha256:${"4".repeat(64)}`,
      receiptId: `v1:sha256:${"5".repeat(64)}`,
    };
    expect(retirementContract.agentRetirementPlanSchema.safeParse(plan).success).toBe(true);
    expect(retirementContract.agentRetirementPlanSchema.safeParse({ ...plan, sourceIds: [] }).success).toBe(false);
    expect(retirementContract.agentRetirementPlanSchema.safeParse({
      ...plan,
      sourceIds: [SOURCE_ID, SOURCE_ID],
    }).success).toBe(false);
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
    for (const olderScope of ["26_allowlisted_sources_tombstone_only", "27_allowlisted_sources_tombstone_only"]) {
      expect(retirementContract.parseAgentRetirementApprovalComment(
        approvalText().replace("wave2_1_allowlisted_sources_tombstone_only", olderScope),
      )).toBeNull();
    }
    const waveOneScope = retirementContract.agentRetirementApprovalScope({ wave: 1, sourceIds: [SOURCE_ID] });
    const waveOneText = retirementContract.formatAgentRetirementApprovalComment(approvalBinding(), waveOneScope);
    expect(waveOneText).toBe(approvalText().replace(
      "wave2_1_allowlisted_sources_tombstone_only",
      "wave1_1_allowlisted_sources_tombstone_only",
    ));
    expect(retirementContract.parseAgentRetirementApprovalComment(waveOneText, waveOneScope)).toEqual(approvalBinding());
    expect(retirementContract.parseAgentRetirementApprovalComment(waveOneText)).toBeNull();
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
