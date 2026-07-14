import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { buildOpenApiSpec, openApiRoutes } from "../routes/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, "../routes");

const apiPrefixes: Record<string, string> = {
  "access.ts": "/api",
  "activity.ts": "/api",
  "adapters.ts": "/api",
  "agents.ts": "/api",
  "approvals.ts": "/api",
  "approval-execution-claims.ts": "/api",
  "assets.ts": "/api",
  "auth.ts": "/api/auth",
  "board-chat.ts": "/api",
  "cloud-upstreams.ts": "/api",
  "companies.ts": "/api/companies",
  "company-skills.ts": "/api",
  "costs.ts": "/api",
  "dashboard.ts": "/api",
  "decisions.ts": "/api",
  "environments.ts": "/api",
  "execution-workspaces.ts": "/api",
  "file-resources.ts": "/api",
  "goals.ts": "/api",
  "health.ts": "/api/health",
  "inbox-dismissals.ts": "/api",
  "instance-database-backups.ts": "/api",
  "instance-settings.ts": "/api",
  "issues.ts": "/api",
  "issue-tree-control.ts": "/api",
  "llms.ts": "/api",
  "openapi.ts": "/api",
  "plugin-ui-static.ts": "/api",
  "plugins.ts": "/api",
  "projects.ts": "/api",
  "project-documents.ts": "/api",
  "resource-memberships.ts": "/api",
  "routines.ts": "/api",
  "secrets.ts": "/api",
  "sidebar-badges.ts": "/api",
  "sidebar-preferences.ts": "/api",
  "teams-catalog.ts": "/api",
  "user-profiles.ts": "/api",
};

const ROUTE_LITERAL_PATTERN = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const ROUTER_METHOD_PATTERN = /router\.(get|post|put|patch|delete)\(/;
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const explicitOpenApiCoverageExclusions = new Set([
  // Pipeline routes are experimental and not yet represented in the public OpenAPI document.
  "pipelines.ts",
]);

function createApp() {
  const app = express();
  app.use("/api", openApiRoutes());
  app.use(errorHandler);
  return app;
}

function normalizeExpressPath(routePath: string) {
  return routePath
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
}

function resolveMountedPath(file: string, prefix: string, routePath: string) {
  if ((file === "companies.ts" || file === "health.ts") && routePath === "/") {
    return prefix;
  }
  if (file === "companies.ts" || file === "health.ts") {
    return `${prefix}${routePath}`;
  }
  if (file === "auth.ts") {
    return `${prefix}${routePath === "/" ? "" : routePath}`;
  }
  return `${prefix}${routePath}`;
}

function loadActualRoutes() {
  const routes = new Set<string>();
  const unknownRouteFiles: string[] = [];

  for (const file of fs.readdirSync(ROUTES_DIR).filter((entry) => entry.endsWith(".ts"))) {
    if (explicitOpenApiCoverageExclusions.has(file)) continue;
    const prefix = apiPrefixes[file];
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    if (!prefix) {
      if (ROUTER_METHOD_PATTERN.test(source)) {
        unknownRouteFiles.push(file);
      }
      continue;
    }

    for (const match of source.matchAll(ROUTE_LITERAL_PATTERN)) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      routes.add(`${method} ${normalizeExpressPath(resolveMountedPath(file, prefix, routePath))}`);
    }

    if (file === "companies.ts" && source.includes("router.post(COMPANY_IMPORT_ROUTE_PATH")) {
      routes.add("POST /api/companies/import");
    }
  }

  return { routes, unknownRouteFiles: unknownRouteFiles.sort() };
}

function loadSpecRoutes() {
  const spec = buildOpenApiSpec();
  const routes = new Set<string>();

  for (const [routePath, pathItem] of Object.entries<Record<string, Record<string, unknown>>>(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) {
        routes.add(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }

  return { spec, routes };
}

describe("openapi routes", () => {
  it("serves the generated OpenAPI document", async () => {
    const res = await request(createApp()).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.0");
    expect(res.body.info.title).toBe("Paperclip API");
    expect(res.body.paths["/api/openapi.json"].get.summary).toBe("Get the generated OpenAPI document");
    expect(res.body.paths["/api/companies/{companyId}/agents"].get.summary).toBe("List agents in a company");
    expect(res.body.paths["/api/agents/{id}/keys"].post.summary).toBe("Create an agent API key");
    expect(res.body.components.securitySchemes).toMatchObject({
      BoardSessionAuth: { type: "apiKey", in: "cookie" },
      BoardApiKeyAuth: { type: "http", scheme: "bearer" },
      AgentBearerAuth: { type: "http", scheme: "bearer" },
    });
    expect(res.body.paths["/api/health"].get.security).toEqual([]);
    expect(res.body.paths["/api/companies"].post.responses["201"]).toBeDefined();
    expect(res.body.paths["/api/companies"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    expect(res.body.paths["/api/agents/{id}/keys"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
    expect(
      res.body.paths["/api/companies/{companyId}/skills/{skillId}/resync-preflight"]
        .get.responses["200"].content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        baseFileInventorySha256: { type: "string", pattern: expect.any(String) },
        sourceFileInventorySha256: { type: "string", pattern: expect.any(String) },
        baseTrustLevel: {
          type: "string",
          enum: ["markdown_only", "assets", "scripts_executables"],
        },
        sourceTrustLevel: {
          type: "string",
          enum: ["markdown_only", "assets", "scripts_executables"],
        },
        affectedAgentIds: {
          type: "array",
          minItems: 0,
          maxItems: 100,
          items: { type: "string", format: "uuid" },
        },
      },
      required: expect.arrayContaining([
        "baseFileInventorySha256",
        "sourceFileInventorySha256",
        "baseTrustLevel",
        "sourceTrustLevel",
        "affectedAgentIds",
      ]),
    });
    const skillResyncRequestSchema =
      res.body.paths["/api/companies/{companyId}/skills/{skillId}/resync"]
        .post.requestBody.content["application/json"].schema;
    expect(skillResyncRequestSchema.oneOf).toHaveLength(2);
    const [gatedSkillResyncRequest, baseOnlySkillResyncRequest] = skillResyncRequestSchema.oneOf;
    expect(gatedSkillResyncRequest).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        expectedSourceInventoryMode: { type: "string", enum: ["full", "project_root"] },
        expectedBaseFileInventorySha256: { type: "string", pattern: expect.any(String) },
        expectedSourceFileInventorySha256: { type: "string", pattern: expect.any(String) },
        expectedBaseTrustLevel: {
          type: "string",
          enum: ["markdown_only", "assets", "scripts_executables"],
        },
        expectedSourceTrustLevel: {
          type: "string",
          enum: ["markdown_only", "assets", "scripts_executables"],
        },
        maintenanceAgentIds: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: { type: "string", format: "uuid" },
        },
        maintenanceReceiptId: { type: "string", pattern: expect.any(String) },
        maintenanceExpectedSnapshotFingerprint: { type: "string", pattern: expect.any(String) },
      },
      required: expect.arrayContaining([
        "expectedSourceInventoryMode",
        "expectedBaseFileInventorySha256",
        "expectedSourceFileInventorySha256",
        "expectedBaseTrustLevel",
        "expectedSourceTrustLevel",
        "maintenanceAgentIds",
        "maintenanceReceiptId",
        "maintenanceExpectedSnapshotFingerprint",
      ]),
    });
    expect(baseOnlySkillResyncRequest).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        expectedSourceInventoryMode: { type: "string", enum: ["full"] },
        expectedBaseFileInventorySha256: { type: "string", pattern: expect.any(String) },
        expectedSourceFileInventorySha256: { type: "string", pattern: expect.any(String) },
        expectedBaseTrustLevel: {
          type: "string",
          enum: ["markdown_only", "assets", "scripts_executables"],
        },
        expectedSourceTrustLevel: {
          type: "string",
          enum: ["markdown_only", "assets", "scripts_executables"],
        },
        maintenanceAgentIds: {
          type: "array",
          minItems: 0,
          maxItems: 0,
          items: { type: "string", format: "uuid" },
        },
        maintenanceReceiptId: { nullable: true, enum: [null] },
        maintenanceExpectedSnapshotFingerprint: { nullable: true, enum: [null] },
      },
      required: expect.arrayContaining([
        "expectedSourceInventoryMode",
        "expectedBaseFileInventorySha256",
        "expectedSourceFileInventorySha256",
        "expectedBaseTrustLevel",
        "expectedSourceTrustLevel",
        "maintenanceAgentIds",
        "maintenanceReceiptId",
        "maintenanceExpectedSnapshotFingerprint",
      ]),
    });
    const retirementPreflightSchema =
      res.body.paths["/api/agents/{id}/retirement-preflight"].post.requestBody.content["application/json"].schema;
    expect(retirementPreflightSchema.oneOf).toHaveLength(3);
    expect(retirementPreflightSchema.oneOf[0]).toMatchObject({
      type: "object",
      properties: {
        claimExecution: { type: "boolean" },
        executionClaimReceiptId: { type: "string", nullable: true, pattern: expect.any(String) },
        evidenceBySourceId: { nullable: true },
        plan: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["paperclip_retirement_plan"] },
            receiptId: { type: "string", pattern: expect.any(String) },
          },
        },
        evidence: {
          type: "object",
          properties: {
            source: {
              properties: {
                decision: { type: "string", enum: ["terminate"] },
                physicalDelete: { type: "boolean", enum: [false] },
              },
            },
            humanGate: {
              properties: { issueIdentifier: { type: "string", enum: ["TEC-355"] } },
            },
          },
        },
      },
      required: expect.arrayContaining([
        "evidence", "plan", "evidenceBySourceId", "claimExecution", "executionClaimReceiptId",
      ]),
    });
    expect(retirementPreflightSchema.oneOf[1]).toMatchObject({
      type: "object",
      properties: {
        evidence: { type: "object" },
        planClaimReceiptId: { type: "string", pattern: expect.any(String) },
        executionClaimReceiptId: { type: "string", nullable: true, pattern: expect.any(String) },
        recoveryRequestReceiptId: { type: "string", nullable: true, pattern: expect.any(String) },
        recoverExecution: { type: "boolean" },
      },
      required: expect.arrayContaining([
        "evidence", "planClaimReceiptId", "executionClaimReceiptId",
        "recoveryRequestReceiptId", "recoverExecution",
      ]),
    });
    expect(
      res.body.paths["/api/agents/{id}/retirement-cleanup"].post.requestBody.content["application/json"].schema,
    ).toMatchObject({
      properties: {
        evidence: { type: "object" },
        planClaimReceiptId: { type: "string", pattern: expect.any(String) },
        executionClaimReceiptId: { type: "string", pattern: expect.any(String) },
        preflightFingerprint: { type: "string", pattern: expect.any(String) },
      },
      required: expect.arrayContaining([
        "evidence", "planClaimReceiptId", "executionClaimReceiptId", "preflightFingerprint",
      ]),
    });
    expect(
      res.body.paths["/api/agents/{id}/terminate"].post.requestBody.content["application/json"].schema,
    ).toMatchObject({
      properties: {
        cleanupReceiptId: { type: "string", pattern: expect.any(String) },
        preflightFingerprint: { type: "string", pattern: expect.any(String) },
      },
      required: expect.arrayContaining([
        "cleanupReceiptId", "preflightFingerprint", "expectedUpdatedAt", "humanGate",
        "planClaimReceiptId", "executionClaimReceiptId",
      ]),
    });
    expect(
      res.body.paths["/api/agents/{id}/retirement-postcheck"].post.requestBody.content["application/json"].schema,
    ).toMatchObject({
      properties: {
        cleanupReceiptId: { type: "string", pattern: expect.any(String) },
        preflightFingerprint: { type: "string", pattern: expect.any(String) },
      },
      required: expect.arrayContaining([
        "cleanupReceiptId", "preflightFingerprint", "expectedUpdatedAt", "humanGate",
        "planClaimReceiptId", "executionClaimReceiptId",
      ]),
    });
    expect(
      res.body.paths["/api/instance/maintenance/stale-wakeups/preview"].post.requestBody.content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        requestIds: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: { type: "string", format: "uuid" },
        },
        staleBefore: { type: "string", format: "date-time" },
      },
      required: ["requestIds", "staleBefore"],
    });
    expect(
      res.body.paths["/api/instance/maintenance/stale-wakeups/run"].post.requestBody.content["application/json"].schema,
    ).toMatchObject({
      properties: {
        reason: { type: "string", minLength: 1, maxLength: 1000 },
      },
      required: ["requestIds", "staleBefore", "reason"],
    });
    expect(
      res.body.paths["/api/instance/maintenance/stale-wakeups/run"].post.responses["200"].content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        cancelledRequestIds: {
          type: "array",
          items: { type: "string", format: "uuid" },
        },
      },
    });
    expect(
      res.body.paths["/api/companies/{companyId}/maintenance-leases/{leaseId}/drain-receipt"]
        .get.parameters.find((parameter: { in: string }) => parameter.in === "header"),
    ).toMatchObject({
      name: "X-Paperclip-Maintenance-Lease",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 256 },
    });
    expect(
      res.body.paths["/api/companies/{companyId}/portfolio-maintenance-preflight"]
        .get.parameters.find((parameter: { name: string }) => parameter.name === "agentIds"),
    ).toMatchObject({
      in: "query",
      required: true,
      schema: { type: "string", pattern: expect.any(String) },
    });
    expect(
      res.body.paths["/api/companies/{companyId}/portfolio-maintenance-wakes/quiesce"]
        .post.requestBody.content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        agentIds: { type: "array", minItems: 1, maxItems: 100 },
        operationId: { type: "string", format: "uuid" },
        expectedSnapshotFingerprint: { type: "string", pattern: expect.any(String) },
      },
      required: ["agentIds", "operationId", "expectedSnapshotFingerprint"],
    });
    expect(
      res.body.paths["/api/companies/{companyId}/portfolio-maintenance-gates/release"]
        .post.responses["200"].content["application/json"].schema,
    ).toMatchObject({
      properties: {
        receiptId: { type: "string", pattern: expect.any(String) },
        expectedSnapshotFingerprint: { type: "string", pattern: expect.any(String) },
        releasedAt: { type: "string", format: "date-time" },
      },
    });
    const pauseOperation = res.body.paths["/api/agents/{id}/pause"].post;
    expect(pauseOperation.requestBody.content["application/json"].schema).toEqual({
      oneOf: [
        {
          type: "object",
          properties: {
            reason: { type: "string", enum: ["manual"] },
          },
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            reason: { type: "string", enum: ["maintenance"] },
            operationId: { type: "string", format: "uuid" },
          },
          required: ["reason", "operationId"],
          additionalProperties: false,
        },
      ],
    });
    expect(pauseOperation.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(pauseOperation["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(Object.keys(pauseOperation.responses).sort()).toEqual([
      "200", "400", "401", "403", "404", "409",
    ]);
    const resumeOperation = res.body.paths["/api/agents/{id}/resume"].post;
    expect(resumeOperation.requestBody.required).toBe(true);
    const resumeRequestSchema = resumeOperation.requestBody.content["application/json"].schema;
    expect(resumeRequestSchema.oneOf).toHaveLength(2);
    expect(resumeRequestSchema.oneOf[0]).toEqual({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["normal"] },
      },
      additionalProperties: false,
    });
    expect(resumeRequestSchema.oneOf[1]).toMatchObject({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["pending_canary"] },
        canaryIssueId: { type: "string", format: "uuid" },
        expectedConfigFingerprint: { type: "string", pattern: expect.any(String) },
        expectedAgentUpdatedAt: { type: "string", format: "date-time" },
        systemReplacementProof: { type: "object" },
      },
      required: [
        "mode",
        "canaryIssueId",
        "expectedConfigFingerprint",
        "expectedAgentUpdatedAt",
      ],
      additionalProperties: false,
    });
    expect(resumeOperation.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(resumeOperation["x-paperclip-authorization"]).toEqual({ actor: "board" });
    expect(Object.keys(resumeOperation.responses).sort()).toEqual([
      "200", "202", "400", "401", "403", "404", "409",
    ]);
    expect(
      res.body.paths["/api/agents/{id}/adapter-secrets/externalize"]
        .post.requestBody.content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        schemaVersion: { type: "string", enum: ["1.0.0"] },
        expectedCompanyId: { type: "string", format: "uuid" },
        expectedAdapterType: { type: "string", enum: ["openclaw_gateway"] },
        expectedConfigFingerprint: { type: "string", pattern: expect.any(String) },
        expectedPreflightReceipt: { type: "string", pattern: expect.any(String) },
      },
      required: [
        "schemaVersion",
        "expectedCompanyId",
        "expectedAdapterType",
        "expectedConfigFingerprint",
        "expectedPreflightReceipt",
      ],
    });
    expect(
      res.body.paths["/api/agents/{id}/adapter-secrets/externalization-proof"]
        .post.responses["200"].content["application/json"].schema,
    ).toMatchObject({
      properties: {
        provider: { type: "string", enum: ["local_encrypted"] },
        runtimeResolutionHash: { type: "string", pattern: expect.any(String) },
        receipt: { type: "string", pattern: expect.any(String) },
      },
    });
    expect(
      res.body.paths["/api/agents/{id}/lifecycle-canary-preflight"]
        .get.responses["200"].content["application/json"].schema,
    ).toMatchObject({
      properties: {
        ready: { type: "boolean" },
        blockers: { type: "array" },
        configFingerprint: {
          nullable: true,
          pattern: expect.any(String),
        },
        agentUpdatedAt: { type: "string", format: "date-time" },
      },
    });
  });

  it("covers the mounted server routes exactly", () => {
    const { routes: actualRoutes, unknownRouteFiles } = loadActualRoutes();
    const { routes: specRoutes } = loadSpecRoutes();

    const missingInSpec = [...actualRoutes].filter((route) => !specRoutes.has(route)).sort();
    const extraInSpec = [...specRoutes].filter((route) => !actualRoutes.has(route)).sort();

    expect({ unknownRouteFiles, missingInSpec, extraInSpec }).toEqual({
      unknownRouteFiles: [],
      missingInSpec: [],
      extraInSpec: [],
    });
  });

  it("documents auth and reviewed response-code invariants", () => {
    const { spec } = loadSpecRoutes();

    expect(spec.paths["/api/openapi.json"].get.security).toEqual([]);
    expect(spec.paths["/api/plugins/install"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/plugins/install"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
    expect(spec.paths["/api/instance/maintenance/stale-wakeups/preview"].post["x-paperclip-authorization"])
      .toEqual({ actor: "board", instanceAdmin: true });
    expect(spec.paths["/api/instance/maintenance/stale-wakeups/run"].post["x-paperclip-authorization"])
      .toEqual({ actor: "board", instanceAdmin: true });
    for (const routePath of [
      "/api/approvals/{id}/execution-claim",
      "/api/approvals/{id}/execution-claim/consume",
      "/api/approvals/{id}/execution-claim/finalize",
    ]) {
      expect(spec.paths[routePath].post.security).toEqual([{ AgentBearerAuth: [] }]);
      expect(spec.paths[routePath].post["x-paperclip-authorization"])
        .toEqual({ actor: "agent", boundRun: true, taskBridgeKey: false });
    }
    const recoveryOperation = spec.paths[
      "/api/companies/{companyId}/approvals/{id}/execution-claim/recover-expired"
    ].post;
    expect(recoveryOperation.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(recoveryOperation["x-paperclip-authorization"]).toEqual({
      actor: "board",
      anyOf: [
        { permission: "environments:manage" },
        { instanceAdmin: true },
      ],
    });
    for (const [routePath, method] of [
      ["/api/companies/{companyId}/maintenance-leases/acquire", "post"],
      ["/api/companies/{companyId}/maintenance-leases/{leaseId}/drain-receipt", "get"],
      ["/api/companies/{companyId}/maintenance-leases/{leaseId}/release", "post"],
      ["/api/companies/{companyId}/portfolio-maintenance-preflight", "get"],
      ["/api/companies/{companyId}/portfolio-maintenance-wakes/quiesce", "post"],
      ["/api/companies/{companyId}/portfolio-maintenance-gates/release", "post"],
      ["/api/agents/{id}/pause", "post"],
      ["/api/agents/{id}/resume", "post"],
      ["/api/agents/{id}/adapter-secrets/externalization-preflight", "get"],
      ["/api/agents/{id}/adapter-secrets/externalization-proof", "post"],
      ["/api/agents/{id}/adapter-secrets/externalize", "post"],
      ["/api/agents/{id}/lifecycle-canary-preflight", "get"],
    ] as const) {
      expect(spec.paths[routePath][method].security).toEqual([
        { BoardSessionAuth: [] },
        { BoardApiKeyAuth: [] },
      ]);
      expect(spec.paths[routePath][method]["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(spec.paths[routePath][method].responses["403"]).toBeDefined();
    }
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["403"]).toBeDefined();
    expect(spec.paths["/api/instance/database-backups"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/invites/{token}/accept"].post.responses["202"]).toBeDefined();
    expect(spec.paths["/api/board-api-keys"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/import"].post.responses["202"]).toBeDefined();
  });
});
