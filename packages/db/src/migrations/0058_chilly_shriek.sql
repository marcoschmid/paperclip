CREATE TABLE "routine_check_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_name" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"findings" integer NOT NULL,
	"notify_channel" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"notified" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"error_text" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "routine_check_runs_check_scheduled_unq" ON "routine_check_runs" USING btree ("check_name","scheduled_for");--> statement-breakpoint
CREATE INDEX "routine_check_runs_check_run_at_idx" ON "routine_check_runs" USING btree ("check_name","run_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "routine_check_runs_check_status_run_at_idx" ON "routine_check_runs" USING btree ("check_name","status","run_at" DESC NULLS LAST);