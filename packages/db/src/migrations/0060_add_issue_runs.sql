-- Migration: add_issue_runs
-- Spec: projects/jarvis-os-redesign/docs/2026-04-30-system-redesign-design.md, Section 3.6.
-- Phase: 0.5 draft. Validate in sandbox before any production apply.

CREATE TABLE IF NOT EXISTS "issue_runs" (
	"run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"executor" text NOT NULL,
	"lease_owner" text NOT NULL,
	"leased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"prompt_snapshot_path" text,
	"exit_code" integer,
	"result_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_runs_executor_check" CHECK ("executor" IN ('hermes', 'mc-dispatch')),
	CONSTRAINT "issue_runs_status_check" CHECK ("status" IN ('running', 'completed', 'failed', 'failed_lease_expired'))
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'issue_runs_company_id_companies_id_fk'
			AND conrelid = 'public.issue_runs'::regclass
	) THEN
		ALTER TABLE "issue_runs"
			ADD CONSTRAINT "issue_runs_company_id_companies_id_fk"
			FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'issue_runs_issue_id_issues_id_fk'
			AND conrelid = 'public.issue_runs'::regclass
	) THEN
		ALTER TABLE "issue_runs"
			ADD CONSTRAINT "issue_runs_issue_id_issues_id_fk"
			FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_runs_active_lease_per_issue_uq"
ON "issue_runs" USING btree ("issue_id")
WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_runs_company_status_idx" ON "issue_runs" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_runs_status_idx" ON "issue_runs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_runs_executor_idx" ON "issue_runs" USING btree ("executor");
