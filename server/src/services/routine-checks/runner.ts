import { and, desc, eq, ne } from "drizzle-orm";
import { routineCheckRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { CheckStatus, NotifyChannel } from "./types.js";

export async function computePreviousStatus(args: {
  db: Db;
  checkName: string;
  currentId: string;
}): Promise<CheckStatus | null> {
  const rows = await args.db
    .select({ status: routineCheckRuns.status })
    .from(routineCheckRuns)
    .where(and(eq(routineCheckRuns.checkName, args.checkName), ne(routineCheckRuns.id, args.currentId)))
    .orderBy(desc(routineCheckRuns.scheduledFor))
    .limit(1);
  return rows[0] ? (rows[0].status as CheckStatus) : null;
}

export async function insertOrSkipRun(args: {
  db: Db;
  checkName: string;
  scheduledFor: Date;
  notifyChannel: NotifyChannel;
}): Promise<string | null> {
  const rows = await args.db
    .insert(routineCheckRuns)
    .values({
      checkName: args.checkName,
      scheduledFor: args.scheduledFor,
      runAt: new Date(),
      status: "ok",
      findings: 0,
      notifyChannel: args.notifyChannel,
      payloadJson: { _state: "running" },
    })
    .onConflictDoNothing({ target: [routineCheckRuns.checkName, routineCheckRuns.scheduledFor] })
    .returning({ id: routineCheckRuns.id });
  return rows[0]?.id ?? null;
}
