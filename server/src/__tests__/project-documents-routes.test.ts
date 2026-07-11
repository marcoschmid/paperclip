import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  upsert: vi.fn(),
  getByKey: vi.fn(),
  list: vi.fn(),
  getProjectById: vi.fn(),
  logActivity: vi.fn(),
}));

vi.doMock("../services/index.js", () => ({
  projectDocumentService: () => ({ upsert: m.upsert, getByKey: m.getByKey, list: m.list }),
  projectService: () => ({ getById: m.getProjectById }),
  logActivity: m.logActivity,
}));

const ACTOR = {
  type: "board" as const,
  userId: "tester",
  source: "local_implicit" as const,
  isInstanceAdmin: true,
  companyIds: [] as string[],
};

async function createApp() {
  const [{ projectDocumentRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/project-documents.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: typeof ACTOR }).actor = ACTOR;
    next();
  });
  const api = express.Router();
  api.use(projectDocumentRoutes({} as never));
  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

const CID = "11111111-1111-1111-1111-111111111111";
const PID = "22222222-2222-2222-2222-222222222222";
const keyPath = `/api/companies/${CID}/projects/${PID}/documents/project-memory`;
const listPath = `/api/companies/${CID}/projects/${PID}/documents`;

beforeEach(() => {
  vi.clearAllMocks();
  m.getProjectById.mockResolvedValue({ id: PID, companyId: CID });
});

describe("projectDocumentRoutes", () => {
  it("PUT creates a project document (201) and logs activity", async () => {
    m.upsert.mockResolvedValue({
      created: true,
      projectDocument: { id: "pd1" },
      document: { id: "doc1", latestBody: "# Memory", latestRevisionNumber: 1 },
      revision: { id: "rev1", revisionNumber: 1 },
    });
    const res = await request(await createApp()).put(keyPath).send({ body: "# Memory" });

    expect(res.status).toBe(201);
    expect(res.body.key).toBe("project-memory");
    expect(res.body.latestRevisionNumber).toBe(1);
    expect(m.upsert).toHaveBeenCalledWith(CID, {
      projectId: PID,
      key: "project-memory",
      body: "# Memory",
    });
    expect(m.logActivity).toHaveBeenCalledTimes(1);
  });

  it("PUT returns 200 when the document already existed (new revision)", async () => {
    m.upsert.mockResolvedValue({
      created: false,
      projectDocument: { id: "pd1" },
      document: { id: "doc1", latestBody: "# v2", latestRevisionNumber: 2 },
      revision: { id: "rev2", revisionNumber: 2 },
    });
    const res = await request(await createApp()).put(keyPath).send({ body: "# v2" });
    expect(res.status).toBe(200);
    expect(res.body.latestRevisionNumber).toBe(2);
  });

  it("PUT rejects an invalid body (400)", async () => {
    const res = await request(await createApp()).put(keyPath).send({ title: "no body field" });
    expect(res.status).toBe(400);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("PUT returns 404 when the project does not belong to the company", async () => {
    m.getProjectById.mockResolvedValue(null);
    const res = await request(await createApp()).put(keyPath).send({ body: "x" });
    expect(res.status).toBe(404);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("GET :key returns 404 when absent", async () => {
    m.getByKey.mockResolvedValue(null);
    const res = await request(await createApp()).get(keyPath);
    expect(res.status).toBe(404);
  });

  it("GET lists project documents", async () => {
    m.list.mockResolvedValue([{ id: "pd1", key: "project-memory" }]);
    const res = await request(await createApp()).get(listPath);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(m.list).toHaveBeenCalledWith(CID, PID);
  });
});
