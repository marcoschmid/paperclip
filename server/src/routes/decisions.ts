import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { decisionService, projectService, logActivity } from "../services/index.js";
import { notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// Inline request schema (server-only route; not yet shared with the UI).
const upsertDecisionSchema = z
  .object({
    sourceProjectSlug: z.string().min(1),
    sourceKey: z.string().min(1).max(200),
    sourceHash: z.string().min(1),
    title: z.string().min(1),
    decision: z.string().min(1),
    context: z.string().nullish(),
    consequences: z.string().nullish(),
    status: z.enum(["proposed", "accepted", "deprecated", "superseded"]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    supersededBy: z.string().uuid().nullish(),
    decidedAt: z.coerce.date().nullish(),
    createdByAgentId: z.string().uuid().nullish(),
    createdByUserId: z.string().nullish(),
  })
  .strict();

export function decisionRoutes(db: Db) {
  const router = Router();
  const svc = decisionService(db);
  const projects = projectService(db);

  async function assertProjectInCompany(companyId: string, projectId: string) {
    const project = await projects.getById(projectId);
    if (!project || project.companyId !== companyId) {
      throw notFound("Project not found");
    }
  }

  router.get("/companies/:companyId/projects/:projectId/decisions", async (req, res) => {
    const { companyId, projectId } = req.params as { companyId: string; projectId: string };
    assertCompanyAccess(req, companyId);
    await assertProjectInCompany(companyId, projectId);
    res.json(await svc.listByProject(companyId, projectId));
  });

  router.get(
    "/companies/:companyId/projects/:projectId/decisions/:sourceKey",
    async (req, res) => {
      const { companyId, projectId, sourceKey } = req.params as {
        companyId: string;
        projectId: string;
        sourceKey: string;
      };
      assertCompanyAccess(req, companyId);
      const decision = await svc.getByKey(companyId, sourceKey);
      if (!decision || decision.projectId !== projectId) {
        res.status(404).json({ error: "Decision not found" });
        return;
      }
      res.json(decision);
    },
  );

  router.post(
    "/companies/:companyId/projects/:projectId/decisions",
    validate(upsertDecisionSchema),
    async (req, res) => {
      const { companyId, projectId } = req.params as { companyId: string; projectId: string };
      assertCompanyAccess(req, companyId);
      await assertProjectInCompany(companyId, projectId);

      const { created, decision } = await svc.upsert(companyId, { projectId, ...req.body });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: created ? "decision.created" : "decision.updated",
        entityType: "decision",
        entityId: decision.id,
        details: { sourceKey: decision.sourceKey, projectId, status: decision.status },
      });

      res.status(created ? 201 : 200).json(decision);
    },
  );

  return router;
}
