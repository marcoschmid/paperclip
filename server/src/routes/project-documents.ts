import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { projectDocumentService, projectService, logActivity } from "../services/index.js";
import { notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

// Inline request schema (server-only route; not yet shared with the UI).
const upsertProjectDocumentSchema = z
  .object({
    body: z.string(),
    title: z.string().nullish(),
    format: z.string().min(1).optional(),
    changeSummary: z.string().nullish(),
    tags: z.array(z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdByAgentId: z.string().uuid().nullish(),
    createdByUserId: z.string().nullish(),
    createdByRunId: z.string().uuid().nullish(),
  })
  .strict();

export function projectDocumentRoutes(db: Db) {
  const router = Router();
  const svc = projectDocumentService(db);
  const projects = projectService(db);

  async function assertProjectInCompany(companyId: string, projectId: string) {
    const project = await projects.getById(projectId);
    if (!project || project.companyId !== companyId) {
      throw notFound("Project not found");
    }
  }

  router.get("/companies/:companyId/projects/:projectId/documents", async (req, res) => {
    const { companyId, projectId } = req.params as { companyId: string; projectId: string };
    assertCompanyAccess(req, companyId);
    await assertProjectInCompany(companyId, projectId);
    res.json(await svc.list(companyId, projectId));
  });

  router.get(
    "/companies/:companyId/projects/:projectId/documents/:key",
    async (req, res) => {
      const { companyId, projectId, key } = req.params as {
        companyId: string;
        projectId: string;
        key: string;
      };
      assertCompanyAccess(req, companyId);
      const document = await svc.getByKey(companyId, projectId, key);
      if (!document) {
        res.status(404).json({ error: "Project document not found" });
        return;
      }
      res.json(document);
    },
  );

  router.put(
    "/companies/:companyId/projects/:projectId/documents/:key",
    validate(upsertProjectDocumentSchema),
    async (req, res) => {
      const { companyId, projectId, key } = req.params as {
        companyId: string;
        projectId: string;
        key: string;
      };
      assertCompanyAccess(req, companyId);
      await assertProjectInCompany(companyId, projectId);

      const result = await svc.upsert(companyId, { projectId, key, ...req.body });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: result.created ? "project_document.created" : "project_document.updated",
        entityType: "project_document",
        entityId: result.projectDocument.id,
        details: { key, projectId, revisionNumber: result.document.latestRevisionNumber },
      });

      res.status(result.created ? 201 : 200).json({
        key,
        projectId,
        documentId: result.document.id,
        latestRevisionNumber: result.document.latestRevisionNumber,
        body: result.document.latestBody,
      });
    },
  );

  return router;
}
