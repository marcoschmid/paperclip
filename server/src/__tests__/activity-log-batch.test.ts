import { beforeEach, describe, expect, it, vi } from "vitest";

const publishLiveEvent = vi.hoisted(() => vi.fn());
vi.mock("../services/live-events.js", () => ({ publishLiveEvent }));

import type { Db } from "@paperclipai/db";
import { logActivities, publishLoggedActivities } from "../services/activity-log.js";

describe("batched activity logging", () => {
  beforeEach(() => publishLiveEvent.mockReset());

  it("inserts a batch once and defers live publication until the caller commits", async () => {
    const inserted: unknown[] = [];
    const db = {
      insert: () => ({
        values: async (rows: unknown[]) => {
          inserted.push(rows);
        },
      }),
    } as unknown as Db;
    const activities = ["company-a", "company-b"].map((companyId) => ({
      companyId,
      actorType: "user" as const,
      actorId: "admin",
      action: "instance.maintenance.test",
      entityType: "instance_maintenance",
      entityId: "test",
      details: { safe: "visible" },
    }));

    const prepared = await logActivities(db, activities, {
      censorUsernameInLogs: false,
      publish: false,
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(2);
    expect(publishLiveEvent).not.toHaveBeenCalled();

    publishLoggedActivities(prepared);
    expect(publishLiveEvent).toHaveBeenCalledTimes(2);
  });
});
