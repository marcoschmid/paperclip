ALTER TABLE "agent_retirement_plan_claims" ADD COLUMN IF NOT EXISTS "approval_comment_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_retirement_plan_claims" ADD COLUMN IF NOT EXISTS "approval_nonce" text;
--> statement-breakpoint
ALTER TABLE "agent_retirement_plan_claims" ADD COLUMN IF NOT EXISTS "approval_fingerprint" text;
--> statement-breakpoint
DO $migration$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "agent_retirement_plan_claims"
		WHERE "approval_comment_id" IS NULL OR "approval_nonce" IS NULL OR "approval_fingerprint" IS NULL
	) THEN
		RAISE EXCEPTION 'Existing retirement plan claims require explicit approval replay migration review';
	END IF;
	ALTER TABLE "agent_retirement_plan_claims" ALTER COLUMN "approval_comment_id" SET NOT NULL;
	ALTER TABLE "agent_retirement_plan_claims" ALTER COLUMN "approval_nonce" SET NOT NULL;
	ALTER TABLE "agent_retirement_plan_claims" ALTER COLUMN "approval_fingerprint" SET NOT NULL;
END
$migration$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_plan_claims_approval_comment_unique" ON "agent_retirement_plan_claims" USING btree ("approval_comment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_plan_claims_approval_nonce_unique" ON "agent_retirement_plan_claims" USING btree ("approval_nonce");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_plan_claims_approval_fingerprint_unique" ON "agent_retirement_plan_claims" USING btree ("approval_fingerprint");
--> statement-breakpoint
DO $migration$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_plan_claims'::regclass AND conname = left('agent_retirement_plan_claims_approval_nonce_check', 63)) THEN
		ALTER TABLE "agent_retirement_plan_claims" ADD CONSTRAINT "agent_retirement_plan_claims_approval_nonce_check" CHECK ("approval_nonce" ~ '^[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_plan_claims'::regclass AND conname = left('agent_retirement_plan_claims_approval_fingerprint_check', 63)) THEN
		ALTER TABLE "agent_retirement_plan_claims" ADD CONSTRAINT "agent_retirement_plan_claims_approval_fingerprint_check" CHECK ("approval_fingerprint" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
END
$migration$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_retirement_plan_evidence_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_claim_id" uuid NOT NULL,
	"registration_receipt_id" text NOT NULL,
	"evidence_by_source_id" jsonb NOT NULL,
	"source_artifact_receipts_by_source_id" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_retirement_execution_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_claim_id" uuid NOT NULL,
	"plan_claim_id" uuid NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"request_receipt_id" text NOT NULL,
	"recovery_receipt_id" text NOT NULL,
	"previous_execution_claim_receipt_id" text,
	"new_execution_claim_receipt_id" text NOT NULL,
	"previous_phase" text NOT NULL,
	"previous_cleanup_receipt_id" text,
	"evidence" jsonb NOT NULL,
	"source_artifact_receipt" jsonb NOT NULL,
	"common_artifact_receipt" jsonb NOT NULL,
	"initial_preflight_fingerprint" text NOT NULL,
	"recovered_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $migration$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_plan_evidence_bundles'::regclass AND conname = left('agent_retirement_plan_evidence_bundles_plan_claim_id_agent_retirement_plan_claims_id_fk', 63)) THEN
		ALTER TABLE "agent_retirement_plan_evidence_bundles" ADD CONSTRAINT "agent_retirement_plan_evidence_bundles_plan_claim_id_agent_retirement_plan_claims_id_fk" FOREIGN KEY ("plan_claim_id") REFERENCES "public"."agent_retirement_plan_claims"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_recoveries'::regclass AND conname = left('agent_retirement_execution_recoveries_execution_claim_id_agent_retirement_execution_claims_id_fk', 63)) THEN
		ALTER TABLE "agent_retirement_execution_recoveries" ADD CONSTRAINT "agent_retirement_execution_recoveries_execution_claim_id_agent_retirement_execution_claims_id_fk" FOREIGN KEY ("execution_claim_id") REFERENCES "public"."agent_retirement_execution_claims"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_recoveries'::regclass AND conname = left('agent_retirement_execution_recoveries_plan_claim_id_agent_retirement_plan_claims_id_fk', 63)) THEN
		ALTER TABLE "agent_retirement_execution_recoveries" ADD CONSTRAINT "agent_retirement_execution_recoveries_plan_claim_id_agent_retirement_plan_claims_id_fk" FOREIGN KEY ("plan_claim_id") REFERENCES "public"."agent_retirement_plan_claims"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_recoveries'::regclass AND conname = left('agent_retirement_execution_recoveries_source_agent_id_agents_id_fk', 63)) THEN
		ALTER TABLE "agent_retirement_execution_recoveries" ADD CONSTRAINT "agent_retirement_execution_recoveries_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END
$migration$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_plan_evidence_bundles_plan_unique" ON "agent_retirement_plan_evidence_bundles" USING btree ("plan_claim_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_plan_evidence_bundles_receipt_unique" ON "agent_retirement_plan_evidence_bundles" USING btree ("registration_receipt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_execution_recoveries_receipt_unique" ON "agent_retirement_execution_recoveries" USING btree ("recovery_receipt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_execution_recoveries_request_unique" ON "agent_retirement_execution_recoveries" USING btree ("request_receipt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_execution_recoveries_new_execution_unique" ON "agent_retirement_execution_recoveries" USING btree ("new_execution_claim_receipt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_retirement_execution_recoveries_source_time_idx" ON "agent_retirement_execution_recoveries" USING btree ("source_agent_id", "recovered_at");
--> statement-breakpoint
DO $migration$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_plan_evidence_bundles'::regclass AND conname = left('agent_retirement_plan_evidence_bundles_receipt_check', 63)) THEN
		ALTER TABLE "agent_retirement_plan_evidence_bundles" ADD CONSTRAINT "agent_retirement_plan_evidence_bundles_receipt_check" CHECK ("registration_receipt_id" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_recoveries'::regclass AND conname = left('agent_retirement_execution_recoveries_receipt_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_recoveries" ADD CONSTRAINT "agent_retirement_execution_recoveries_receipt_check" CHECK ("recovery_receipt_id" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_recoveries'::regclass AND conname = left('agent_retirement_execution_recoveries_request_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_recoveries" ADD CONSTRAINT "agent_retirement_execution_recoveries_request_check" CHECK ("request_receipt_id" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_recoveries'::regclass AND conname = left('agent_retirement_execution_recoveries_previous_execution_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_recoveries" ADD CONSTRAINT "agent_retirement_execution_recoveries_previous_execution_check" CHECK ("previous_execution_claim_receipt_id" IS NULL OR "previous_execution_claim_receipt_id" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_recoveries'::regclass AND conname = left('agent_retirement_execution_recoveries_new_execution_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_recoveries" ADD CONSTRAINT "agent_retirement_execution_recoveries_new_execution_check" CHECK ("new_execution_claim_receipt_id" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_recoveries'::regclass AND conname = left('agent_retirement_execution_recoveries_previous_cleanup_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_recoveries" ADD CONSTRAINT "agent_retirement_execution_recoveries_previous_cleanup_check" CHECK ("previous_cleanup_receipt_id" IS NULL OR "previous_cleanup_receipt_id" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_recoveries'::regclass AND conname = left('agent_retirement_execution_recoveries_initial_preflight_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_recoveries" ADD CONSTRAINT "agent_retirement_execution_recoveries_initial_preflight_check" CHECK ("initial_preflight_fingerprint" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_recoveries'::regclass AND conname = left('agent_retirement_execution_recoveries_previous_phase_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_recoveries" ADD CONSTRAINT "agent_retirement_execution_recoveries_previous_phase_check" CHECK ("previous_phase" IN ('unstarted', 'started', 'cleaned', 'termination_ready'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_recoveries'::regclass AND conname = left('agent_retirement_execution_recoveries_expiry_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_recoveries" ADD CONSTRAINT "agent_retirement_execution_recoveries_expiry_check" CHECK ("expires_at" > "recovered_at");
	END IF;
END
$migration$;
