import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  approvalExecutionClaimConsumeRequestSchema,
  approvalExecutionClaimFinalizeRequestSchema,
  approvalExecutionClaimRecoveryRequestSchema,
  approvalExecutionClaimRequestSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import {
  approvalExecutionClaimService,
  type ApprovalExecutionClaimServiceOptions,
} from "../services/approval-execution-claims.js";
import { accessService } from "../services/access.js";
import { assertCompanyAccess } from "./authz.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A deliberately narrow agent-only route. Authentication and run binding are
 * checked before the public body schema is parsed, so board/anonymous/scoped
 * bridge callers cannot use validation behavior as an approval oracle.
 */
export function approvalExecutionClaimRoutes(
  db: Db,
  options: ApprovalExecutionClaimServiceOptions = {},
) {
  const router = Router();
  const service = approvalExecutionClaimService(db, options);
  const access = accessService(db);

  function boundActor(req: Request) {
    if (
      req.actor.type !== "agent"
      || !req.actor.agentId
      || !req.actor.companyId
      || !req.actor.runId
      || !UUID_RE.test(req.actor.agentId)
      || !UUID_RE.test(req.actor.companyId)
      || !UUID_RE.test(req.actor.runId)
      || (req.actor.source === "agent_key" && req.actor.keyScope?.kind === "task_bridge")
    ) {
      throw forbidden("A bound standard agent execution run is required");
    }

    const approvalId = req.params.id as string;
    if (!UUID_RE.test(approvalId)) {
      throw forbidden("A bound standard agent execution run is required");
    }
    return {
      approvalId,
      companyId: req.actor.companyId,
      agentId: req.actor.agentId,
      executorRunId: req.actor.runId,
    };
  }

  async function boundRecoveryActor(req: Request) {
    const companyId = req.params.companyId as string;
    const approvalId = req.params.id as string;
    if (
      req.actor.type !== "board"
      || !req.actor.userId
      || !UUID_RE.test(companyId)
      || !UUID_RE.test(approvalId)
    ) {
      throw forbidden("A company-authorized board manager is required");
    }
    assertCompanyAccess(req, companyId);
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
      const allowed = await access.canUser(
        companyId,
        req.actor.userId,
        "environments:manage",
      );
      if (!allowed) throw forbidden("Missing permission: environments:manage");
    }
    return {
      approvalId,
      companyId,
      actorUserId: req.actor.userId,
    };
  }

  router.post("/approvals/:id/execution-claim", async (req, res) => {
    const actor = boundActor(req);
    const body = approvalExecutionClaimRequestSchema.parse(req.body);
    const receipt = await service.claim({
      ...actor,
      request: body,
    });
    res.status(receipt.replayed ? 200 : 201).json(receipt);
  });

  router.post("/approvals/:id/execution-claim/consume", async (req, res) => {
    const actor = boundActor(req);
    const body = approvalExecutionClaimConsumeRequestSchema.parse(req.body);
    const receipt = await service.consume({ ...actor, request: body });
    res.status(200).json(receipt);
  });

  router.post("/approvals/:id/execution-claim/finalize", async (req, res) => {
    const actor = boundActor(req);
    const body = approvalExecutionClaimFinalizeRequestSchema.parse(req.body);
    const receipt = await service.finalize({ ...actor, request: body });
    res.status(200).json(receipt);
  });

  router.post(
    "/companies/:companyId/approvals/:id/execution-claim/recover-expired",
    async (req, res) => {
      const actor = await boundRecoveryActor(req);
      const body = approvalExecutionClaimRecoveryRequestSchema.parse(req.body);
      const receipt = await service.recoverExpired({ ...actor, request: body });
      res.status(200).json(receipt);
    },
  );

  return router;
}
