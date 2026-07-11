import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  upsert: vi.fn(),
  getByKey: vi.fn(),
  listByProject: vi.fn(),
  getProjectById: vi.fn(),
  logActivity: vi.fn(),
}));

vi.doMock("../services/index.js", () => ({
  decisionService: () => ({ upsert: m.upsert, getByKey: m.getByKey, listByProject: m.listByProject }),
  projectService: () => ({ getById: m.getProjectById }),
  logActivity: m.logActivity,
}));

// source: "local_implicit" bypasses the company-access checks in assertCompanyAccess.
const ACTOR = {
  type: "board" as const,
  userId: "tester",
  source: "local_implicit" as const,
  isInstanceAdmin: true,
  companyIds: [] as string[],
};

async function createApp() {
  const [{ decisionRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/decisions.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: typeof ACTOR }).actor = ACTOR;
    next();
  });
  const api = express.Router();
  api.use(decisionRoutes({} as never));
  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

const CID = "11111111-1111-1111-1111-111111111111";
const PID = "22222222-2222-2222-2222-222222222222";
const path = `/api/companies/${CID}/projects/${PID}/decisions`;
const base = {
  sourceProjectSlug: "jarvis-os-redesign",
  sourceKey: "adr-0001",
  sourceHash: "h1",
  title: "Use Paperclip as project-memory SoT",
  decision: "Store project decisions in Paperclip.",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getProjectById.mockResolvedValue({ id: PID, companyId: CID });
});

describe("decisionRoutes", () => {
  it("POST creates a decision (201) and logs activity", async () => {
    m.upsert.mockResolvedValue({
      created: true,
      decision: { id: "d1", sourceKey: "adr-0001", projectId: PID, status: "accepted" },
    });
    const res = await request(await createApp()).post(path).send(base);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("d1");
    expect(m.upsert).toHaveBeenCalledWith(CID, { projectId: PID, ...base });
    expect(m.logActivity).toHaveBeenCalledTimes(1);
  });

  it("POST returns 200 when the decision already existed (updated in place)", async () => {
    m.upsert.mockResolvedValue({
      created: false,
      decision: { id: "d1", sourceKey: "adr-0001", projectId: PID, status: "superseded" },
    });
    const res = await request(await createApp()).post(path).send(base);
    expect(res.status).toBe(200);
  });

  it("POST rejects an invalid body (400) without touching the service", async () => {
    const res = await request(await createApp()).post(path).send({ title: "missing required fields" });
    expect(res.status).toBe(400);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("POST returns 404 when the project does not belong to the company", async () => {
    m.getProjectById.mockResolvedValue(null);
    const res = await request(await createApp()).post(path).send(base);
    expect(res.status).toBe(404);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("GET lists decisions scoped to the project", async () => {
    m.listByProject.mockResolvedValue([{ id: "d1", sourceKey: "adr-0001" }]);
    const res = await request(await createApp()).get(path);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(m.listByProject).toHaveBeenCalledWith(CID, PID);
  });
});
