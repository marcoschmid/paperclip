import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { and, count as countFn, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable } from "@paperclipai/db";
import {
  DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
  companyArtifactsQuerySchema,
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  AGENT_MAINTENANCE_LEASE_HEADER,
  AGENT_MAINTENANCE_LEASE_SCOPE,
  agentMaintenanceLeaseService,
} from "../services/agent-maintenance-leases.js";
import { portfolioMaintenanceService } from "../services/portfolio-maintenance.js";
import {
  accessService,
  agentService,
  budgetService,
  companyArtifactsService,
  companyPortabilityService,
  companyService,
  feedbackService,
  logActivity,
  workTimelineService,
} from "../services/index.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { COMPANY_IMPORT_ROUTE_PATH } from "./company-import-paths.js";

export function companyRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = companyService(db);
  const agents = agentService(db);
  const portability = companyPortabilityService(db, storage);
  const access = accessService(db);
  const budgets = budgetService(db);
  const artifacts = companyArtifactsService(db, storage);
  const feedback = feedbackService(db);
  const maintenanceLeases = agentMaintenanceLeaseService(db);
  const portfolioMaintenance = portfolioMaintenanceService(db);
  const importJobs = new Map<string, ImportJobRecord>();
  const importJobTerminalRetentionMs = 5 * 60 * 1000;

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw badRequest(`Invalid ${field} query value`);
    }
    return parsed;
  }

  function parseIntegerQuery(value: unknown, field: string) {
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) {
      throw badRequest(`Invalid ${field} query value`);
    }
    return Math.floor(parsed);
  }

  const timelineQuerySchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    userId: z.string().min(1).optional(),
    goalId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    issueId: z.string().uuid().optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
  }).passthrough();

  const acquireMaintenanceLeaseSchema = z.object({
    scope: z.literal(AGENT_MAINTENANCE_LEASE_SCOPE),
    agentIds: z.array(z.string().uuid()).min(1).max(100),
  }).strict().superRefine((body, ctx) => {
    if (new Set(body.agentIds).size !== body.agentIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agentIds"], message: "agentIds must be unique" });
    }
  });
  const maintenanceLeaseIdSchema = z.string().uuid();
  const maintenanceLeaseTokenSchema = z.string().min(1).max(256);
  const portfolioAgentIdsSchema = z.array(z.string().uuid()).min(1).max(100).superRefine((agentIds, ctx) => {
    if (new Set(agentIds).size !== agentIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agentIds must be unique" });
    }
    if (agentIds.some((agentId, index) => index > 0 && agentIds[index - 1]! >= agentId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agentIds must be sorted" });
    }
  });
  const portfolioQuiesceSchema = z.object({
    agentIds: portfolioAgentIdsSchema,
    operationId: z.string().uuid(),
    expectedSnapshotFingerprint: z.string().regex(/^v1:sha256:[a-f0-9]{64}$/),
  }).strict();
  const portfolioGateReleaseSchema = z.object({
    agentIds: portfolioAgentIdsSchema,
    receiptIds: z.array(z.string().regex(/^v1:sha256:[a-f0-9]{64}$/)).min(1).max(100),
    expectedSnapshotFingerprint: z.string().regex(/^v1:sha256:[a-f0-9]{64}$/),
  }).strict().superRefine((body, ctx) => {
    if (new Set(body.receiptIds).size !== body.receiptIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptIds"], message: "receiptIds must be unique" });
    }
    if (body.receiptIds.some((receiptId, index) => index > 0 && body.receiptIds[index - 1]! >= receiptId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptIds"], message: "receiptIds must be sorted" });
    }
  });

  function parsePortfolioAgentIdsQuery(value: unknown) {
    if (typeof value !== "string" || value.length === 0) {
      throw badRequest("agentIds query parameter is required");
    }
    return portfolioAgentIdsSchema.parse(value.split(","));
  }

  function readMaintenanceLeaseToken(req: Request) {
    const token = req.get(AGENT_MAINTENANCE_LEASE_HEADER);
    if (!token) throw forbidden("Maintenance lease token required");
    const parsed = maintenanceLeaseTokenSchema.safeParse(token);
    if (!parsed.success) throw forbidden("Invalid maintenance lease token");
    return parsed.data;
  }

  function assertImportTargetAccess(
    req: Request,
    target: { mode: "new_company" } | { mode: "existing_company"; companyId: string },
  ) {
    if (target.mode === "new_company") {
      assertInstanceAdmin(req);
      return;
    }
    assertCompanyAccess(req, target.companyId);
  }

  async function assertSameCompanyCeoAgentOrBoard(req: Request, companyId: string, capability: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      return;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden(`Only CEO agents can manage ${capability}`);
    }
  }

  router.get("/", async (req, res) => {
    assertBoard(req);
    const result = await svc.list();
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      res.json(result);
      return;
    }
    const allowed = new Set(req.actor.companyIds ?? []);
    res.json(result.filter((company) => allowed.has(company.id)));
  });

  router.get("/stats", async (req, res) => {
    assertBoard(req);
    const allowed = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin
      ? null
      : new Set(req.actor.companyIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([companyId]) => allowed.has(companyId)));
    res.json(filtered);
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.post(
    "/:companyId/maintenance-leases/acquire",
    async (req, res) => {
      assertBoard(req);
      const companyId = z.string().uuid().parse(req.params.companyId);
      assertCompanyAccess(req, companyId);
      const body = acquireMaintenanceLeaseSchema.parse(req.body);
      const targetAgents = await Promise.all(body.agentIds.map((agentId) => agents.getById(agentId)));
      if (targetAgents.some((agent) => !agent || agent.companyId !== companyId || agent.adapterType !== "codex_local")) {
        throw badRequest("All maintenance lease agents must be codex_local agents in the target company");
      }
      const actor = getActorInfo(req);
      res.json(await maintenanceLeases.acquire({
        companyId,
        agentIds: body.agentIds,
        scope: body.scope,
        ownerUserId: actor.actorId,
      }));
    },
  );

  router.get("/:companyId/portfolio-maintenance-preflight", async (req, res) => {
    assertBoard(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const agentIds = parsePortfolioAgentIdsQuery(req.query.agentIds);
    res.json(await portfolioMaintenance.preflight({ companyId, agentIds }));
  });

  router.post("/:companyId/portfolio-maintenance-wakes/quiesce", async (req, res) => {
    assertBoard(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const body = portfolioQuiesceSchema.parse(req.body);
    res.json(await portfolioMaintenance.quiesce({
      companyId,
      agentIds: body.agentIds,
      operationId: body.operationId,
      expectedSnapshotFingerprint: body.expectedSnapshotFingerprint,
      actorUserId: req.actor.type === "board" ? req.actor.userId ?? "board" : "board",
    }));
  });

  router.post("/:companyId/portfolio-maintenance-gates/release", async (req, res) => {
    assertBoard(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const body = portfolioGateReleaseSchema.parse(req.body);
    res.json(await portfolioMaintenance.releaseGate({
      companyId,
      agentIds: body.agentIds,
      receiptIds: body.receiptIds,
      expectedSnapshotFingerprint: body.expectedSnapshotFingerprint,
      actorUserId: req.actor.type === "board" ? req.actor.userId ?? "board" : "board",
    }));
  });

  router.get("/:companyId/maintenance-leases/:leaseId/drain-receipt", async (req, res) => {
    assertBoard(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    const leaseId = maintenanceLeaseIdSchema.parse(req.params.leaseId);
    assertCompanyAccess(req, companyId);
    const leaseToken = readMaintenanceLeaseToken(req);
    res.json(await maintenanceLeases.drainReceipt(companyId, leaseId, leaseToken));
  });

  router.post("/:companyId/maintenance-leases/:leaseId/release", async (req, res) => {
    assertBoard(req);
    const companyId = z.string().uuid().parse(req.params.companyId);
    const leaseId = maintenanceLeaseIdSchema.parse(req.params.leaseId);
    assertCompanyAccess(req, companyId);
    const leaseToken = readMaintenanceLeaseToken(req);
    res.json(await maintenanceLeases.release(companyId, leaseId, leaseToken));
  });

  router.get("/:companyId/artifacts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = companyArtifactsQuerySchema.parse(req.query);
    res.json(await artifacts.list(companyId, query));
  });

  router.get("/:companyId/timeline", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const companyScopeDecision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!companyScopeDecision.allowed) {
      res.status(403).json({ error: "Timeline is outside this actor's authorization boundary" });
      return;
    }

    const query = timelineQuerySchema.parse(req.query);
    const timeline = workTimelineService(db);
    const result = await timeline.getTimeline({
      companyId,
      from: parseDateQuery(query.from, "from"),
      to: parseDateQuery(query.to, "to"),
      userId: query.userId,
      goalId: query.goalId,
      projectId: query.projectId,
      issueId: query.issueId,
      limit: parseIntegerQuery(query.limit, "limit"),
      offset: parseIntegerQuery(query.offset, "offset"),
      canReadIssue: async (issue) => {
        const decision = await access.decide({
          actor: req.actor,
          action: "issue:read",
          resource: {
            type: "issue",
            companyId: issue.companyId,
            issueId: issue.id,
            projectId: issue.projectId,
            parentIssueId: issue.parentId,
            assigneeAgentId: issue.assigneeAgentId,
            assigneeUserId: issue.assigneeUserId,
            status: issue.status,
          },
          scope: {
            issueId: issue.id,
            projectId: issue.projectId,
            parentIssueId: issue.parentId,
            assigneeAgentId: issue.assigneeAgentId,
            assigneeUserId: issue.assigneeUserId,
          },
        });
        return decision.allowed;
      },
    });
    res.json(result);
  });

  router.get("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // Allow agents (CEO) to read their own company; board always allowed
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const company = await svc.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.get("/:companyId/feedback-traces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const issueId = typeof req.query.issueId === "string" && req.query.issueId.trim().length > 0 ? req.query.issueId : undefined;
    const projectId = typeof req.query.projectId === "string" && req.query.projectId.trim().length > 0
      ? req.query.projectId
      : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId,
      issueId,
      projectId,
      targetType: targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined,
      vote: voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined,
      status: statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.post("/:companyId/export", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company exports");
    const body = companyPortabilityExportSchema.parse(req.body);
    const result = await portability.exportBundle(companyId, body);
    res.json(result);
  });

  router.post("/import/preview", async (req, res) => {
    assertBoard(req);
    const body = companyPortabilityPreviewSchema.parse(req.body);
    assertImportTargetAccess(req, body.target);
    const preview = await portability.previewImport(body);
    res.json(preview);
  });

  router.get("/import/jobs/:jobId", async (req, res) => {
    assertCloudTenantCaller(req);
    cleanupTerminalImportJobs(importJobs, importJobTerminalRetentionMs);
    const job = importJobs.get(req.params.jobId as string);
    if (!job || job.cloudTenantKey !== cloudTenantRequestKey(req)) {
      res.status(404).json({ error: "Import job not found" });
      return;
    }
    res.json(importJobResponse(job));
  });

  router.post(COMPANY_IMPORT_ROUTE_PATH, async (req, res) => {
    assertBoard(req);
    const rawImportBody: unknown = req.body;
    const actor = getActorInfo(req);
    const boardUserId = req.actor.type === "board" ? req.actor.userId : null;
    if (req.header("x-paperclip-cloud-async-import") === "1") {
      assertCloudTenantCaller(req);
      cleanupTerminalImportJobs(importJobs, importJobTerminalRetentionMs);
      const job = createImportJob(cloudTenantRequestKey(req));
      importJobs.set(job.id, job);
      const operation = async () => {
        const importBody = companyPortabilityImportSchema.parse(rawImportBody);
        assertImportTargetAccess(req, importBody.target);
        const activity = importedCompanyActivityContext(actor, importBody.include ?? null);
        const result = await portability.importBundle(importBody, boardUserId);
        await logImportedCompanyActivity(db, activity, result);
        return result;
      };
      res.status(202).json(importJobAcceptedResponse(job));
      setImmediate(() => {
        void runImportJob(job, operation);
      });
      return;
    }

    const importBody = companyPortabilityImportSchema.parse(rawImportBody);
    assertImportTargetAccess(req, importBody.target);
    const activity = importedCompanyActivityContext(actor, importBody.include ?? null);
    const result = await portability.importBundle(importBody, boardUserId);
    await logImportedCompanyActivity(db, activity, result);
    res.json(result);
  });

  router.post("/:companyId/exports/preview", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company exports");
    const body = companyPortabilityExportSchema.parse(req.body);
    const preview = await portability.previewExport(companyId, body);
    res.json(preview);
  });

  router.post("/:companyId/exports", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company exports");
    const body = companyPortabilityExportSchema.parse(req.body);
    const result = await portability.exportBundle(companyId, body);
    res.json(result);
  });

  router.post("/:companyId/imports/preview", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company imports");
    const body = companyPortabilityPreviewSchema.parse(req.body);
    if (body.target.mode === "existing_company" && body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const preview = await portability.previewImport(body, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    res.json(preview);
  });

  router.post("/:companyId/imports/apply", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company imports");
    const body = companyPortabilityImportSchema.parse(req.body);
    if (body.target.mode === "existing_company" && body.target.companyId !== companyId) {
      throw forbidden("Safe import route can only target the route company");
    }
    if (body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(body, req.actor.type === "board" ? req.actor.userId : null, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      entityType: "company",
      entityId: result.company.id,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.imported",
      details: {
        include: body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        companyAction: result.company.action,
        importMode: "agent_safe",
      },
    });
    res.json(result);
  });

  router.post("/", validate(createCompanySchema), async (req, res) => {
    assertBoard(req);
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      throw forbidden("Instance admin required");
    }
    const ownerPrincipalId = req.actor.userId ?? "local-board";
    const company = await svc.create({
      ...req.body,
      defaultResponsibleUserId: req.body.defaultResponsibleUserId ?? ownerPrincipalId,
    });
    await access.ensureMembership(company.id, "user", ownerPrincipalId, "owner", "active");
    await access.ensureRoleDefaultGrants(
      company.id,
      ownerPrincipalId,
      "owner",
      req.actor.userId ?? null,
    );
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "company.created",
      entityType: "company",
      entityId: company.id,
      details: { name: company.name },
    });
    if (company.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        company.id,
        {
          scopeType: "company",
          scopeId: company.id,
          amount: company.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.userId ?? "board",
      );
    }
    res.status(201).json(company);
  });

  router.patch("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company settings");

    const actor = getActorInfo(req);
    let body: Record<string, unknown>;

    if (req.actor.type === "agent") {
      body = updateCompanyBrandingSchema.parse(req.body);
    } else {
      body = updateCompanySchema.parse(req.body);
    }

    const existingCompany = await svc.getById(companyId);
    if (!existingCompany) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    if (req.actor.type !== "agent") {
      if (body.feedbackDataSharingEnabled === true && !existingCompany.feedbackDataSharingEnabled) {
        body = {
          ...body,
          feedbackDataSharingConsentAt: new Date(),
          feedbackDataSharingConsentByUserId: req.actor.userId ?? "local-board",
          feedbackDataSharingTermsVersion:
            typeof body.feedbackDataSharingTermsVersion === "string" && body.feedbackDataSharingTermsVersion.length > 0
              ? body.feedbackDataSharingTermsVersion
              : DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
        };
      }
    }

    const transitionsToArchived =
      body.status === "archived" && existingCompany.status !== "archived";
    const transitionsArchivedToActive =
      body.status === "active" && existingCompany.status === "archived";
    let transitionsPausedToActiveWithArchivePausedAgents = false;
    if (body.status === "active" && existingCompany.status === "paused") {
      const [archivedPausedCount] = await db
        .select({ value: countFn() })
        .from(agentsTable)
        .where(and(
          eq(agentsTable.companyId, companyId),
          eq(agentsTable.status, "paused"),
          eq(agentsTable.pauseReason, "company_archived"),
        ));
      transitionsPausedToActiveWithArchivePausedAgents =
        Number(archivedPausedCount?.value ?? 0) > 0;
    }
    const lifecycleEventEmittedByService =
      transitionsToArchived ||
      transitionsArchivedToActive ||
      transitionsPausedToActiveWithArchivePausedAgents;

    const company = await svc.update(companyId, body, actor);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    if (!lifecycleEventEmittedByService) {
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.updated",
        entityType: "company",
        entityId: companyId,
        details: body,
      });
    }
    res.json(company);
  });

  router.patch("/:companyId/branding", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertSameCompanyCeoAgentOrBoard(req, companyId, "company branding");
    const body = updateCompanyBrandingSchema.parse(req.body);
    const company = await svc.update(companyId, body);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.branding_updated",
      entityType: "company",
      entityId: companyId,
      details: body,
    });
    res.json(company);
  });

  router.post("/:companyId/archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await svc.archive(companyId, getActorInfo(req));
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(company);
  });

  router.delete("/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await svc.remove(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}

type CompanyImportResult = {
  company: { id: string; action: unknown };
  agents: unknown[];
  warnings: unknown[];
};

interface ImportJobRecord {
  id: string;
  cloudTenantKey: string;
  status: "running" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: { message: string };
  result?: {
    companyId: string;
    agentCount: number;
    warningCount: number;
    companyAction: unknown;
  };
}

interface ImportedCompanyActivityContext {
  actorType: "user" | "agent";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  include: unknown;
}

function assertCloudTenantCaller(req: Request) {
  if (req.actor.source !== "cloud_tenant") {
    throw forbidden("Trusted Cloud tenant access required");
  }
}

function cloudTenantRequestKey(req: Request) {
  return [
    req.actor.userId ?? "",
    req.header("x-paperclip-cloud-stack-id")?.trim() ?? "",
    req.header("x-paperclip-cloud-paperclip-company-id")?.trim() ?? "",
  ].join(":");
}

function createImportJob(cloudTenantKey: string): ImportJobRecord {
  const now = new Date().toISOString();
  return {
    id: `tenant-import-${randomUUID()}`,
    cloudTenantKey,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
}

async function runImportJob(
  job: ImportJobRecord,
  operation: () => Promise<CompanyImportResult>,
) {
  try {
    const result = await operation();
    const now = new Date().toISOString();
    job.status = "succeeded";
    job.updatedAt = now;
    job.completedAt = now;
    job.result = {
      companyId: result.company.id,
      agentCount: result.agents.length,
      warningCount: result.warnings.length,
      companyAction: result.company.action,
    };
  } catch (error) {
    const now = new Date().toISOString();
    job.status = "failed";
    job.updatedAt = now;
    job.completedAt = now;
    job.error = { message: errorMessage(error) };
  }
}

function importedCompanyActivityContext(
  actor: ReturnType<typeof getActorInfo>,
  include: unknown,
): ImportedCompanyActivityContext {
  return {
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    include,
  };
}

async function logImportedCompanyActivity(
  db: Db,
  activity: ImportedCompanyActivityContext,
  result: CompanyImportResult,
) {
  await logActivity(db, {
    companyId: result.company.id,
    actorType: activity.actorType,
    actorId: activity.actorId,
    action: "company.imported",
    entityType: "company",
    entityId: result.company.id,
    agentId: activity.agentId,
    runId: activity.runId,
    details: {
      include: activity.include,
      agentCount: result.agents.length,
      warningCount: result.warnings.length,
      companyAction: result.company.action,
    },
  });
}

function importJobAcceptedResponse(job: ImportJobRecord) {
  return {
    job: {
      id: job.id,
      status: job.status,
    },
    statusUrl: `/api/companies/import/jobs/${encodeURIComponent(job.id)}`,
    retryAfterMs: 1000,
  };
}

function importJobResponse(job: ImportJobRecord) {
  const isTerminal = job.status === "succeeded" || job.status === "failed";
  const response: Record<string, unknown> = {
    job: {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.result ? { result: job.result } : {}),
    },
    ...(isTerminal ? {} : { retryAfterMs: 1000 }),
  };
  if (job.error?.message) {
    response.error = job.error.message;
    response.message = job.error.message;
    response.reason = job.error.message;
  }
  return response;
}

function cleanupTerminalImportJobs(importJobs: Map<string, ImportJobRecord>, terminalRetentionMs: number) {
  const now = Date.now();
  for (const [jobId, job] of importJobs) {
    if (job.status === "running" || !job.completedAt) continue;
    if (now - Date.parse(job.completedAt) > terminalRetentionMs) {
      importJobs.delete(jobId);
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
