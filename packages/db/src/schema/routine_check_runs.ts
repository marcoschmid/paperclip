import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const routineCheckRuns = pgTable(
  "routine_check_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checkName: text("check_name").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    findings: integer("findings").notNull(),
    notifyChannel: text("notify_channel").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    notified: boolean("notified").notNull().default(false),
    durationMs: integer("duration_ms"),
    errorText: text("error_text"),
  },
  (t) => ({
    checkScheduledUnique: uniqueIndex("routine_check_runs_check_scheduled_unq").on(t.checkName, t.scheduledFor),
    checkRunAtIdx: index("routine_check_runs_check_run_at_idx").on(t.checkName, t.runAt.desc()),
    checkStatusRunAtIdx: index("routine_check_runs_check_status_run_at_idx").on(t.checkName, t.status, t.runAt.desc()),
  }),
);

export type RoutineCheckRun = typeof routineCheckRuns.$inferSelect;
export type NewRoutineCheckRun = typeof routineCheckRuns.$inferInsert;
