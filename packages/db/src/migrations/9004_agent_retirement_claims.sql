CREATE TABLE IF NOT EXISTS "agent_retirement_plan_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_plan_receipt_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"plan" jsonb NOT NULL,
	"common_artifact_receipt" jsonb NOT NULL,
	"issued_by_user_id" text NOT NULL,
	"evidence_expires_at" timestamp with time zone NOT NULL,
	"execution_expires_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_retirement_execution_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_claim_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"source_agent_id" uuid NOT NULL,
	"receipt_id" text NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"source_artifact_receipt" jsonb NOT NULL,
	"initial_preflight_fingerprint" text NOT NULL,
	"phase" text DEFAULT 'started' NOT NULL,
	"cleanup_receipt_id" text,
	"final_preflight_fingerprint" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $migration$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_retirement_execution_claims'::regclass
			AND conname = left('agent_retirement_execution_claims_plan_claim_id_agent_retirement_plan_claims_id_fk', 63)
	) THEN
		ALTER TABLE "agent_retirement_execution_claims" ADD CONSTRAINT "agent_retirement_execution_claims_plan_claim_id_agent_retirement_plan_claims_id_fk" FOREIGN KEY ("plan_claim_id") REFERENCES "public"."agent_retirement_plan_claims"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_retirement_execution_claims'::regclass
			AND conname = left('agent_retirement_execution_claims_company_id_companies_id_fk', 63)
	) THEN
		ALTER TABLE "agent_retirement_execution_claims" ADD CONSTRAINT "agent_retirement_execution_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = 'public.agent_retirement_execution_claims'::regclass
			AND conname = left('agent_retirement_execution_claims_source_agent_id_agents_id_fk', 63)
	) THEN
		ALTER TABLE "agent_retirement_execution_claims" ADD CONSTRAINT "agent_retirement_execution_claims_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END
$migration$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_plan_claims_client_receipt_unique" ON "agent_retirement_plan_claims" USING btree ("client_plan_receipt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_plan_claims_receipt_unique" ON "agent_retirement_plan_claims" USING btree ("receipt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_retirement_plan_claims_execution_expiry_idx" ON "agent_retirement_plan_claims" USING btree ("execution_expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_execution_claims_source_unique" ON "agent_retirement_execution_claims" USING btree ("source_agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_retirement_execution_claims_receipt_unique" ON "agent_retirement_execution_claims" USING btree ("receipt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_retirement_execution_claims_plan_phase_idx" ON "agent_retirement_execution_claims" USING btree ("plan_claim_id","phase");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_retirement_execution_claims_expiry_idx" ON "agent_retirement_execution_claims" USING btree ("expires_at");
--> statement-breakpoint
DO $migration$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_plan_claims'::regclass AND conname = left('agent_retirement_plan_claims_client_receipt_check', 63)) THEN
		ALTER TABLE "agent_retirement_plan_claims" ADD CONSTRAINT "agent_retirement_plan_claims_client_receipt_check" CHECK ("client_plan_receipt_id" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_plan_claims'::regclass AND conname = left('agent_retirement_plan_claims_receipt_check', 63)) THEN
		ALTER TABLE "agent_retirement_plan_claims" ADD CONSTRAINT "agent_retirement_plan_claims_receipt_check" CHECK ("receipt_id" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_plan_claims'::regclass AND conname = left('agent_retirement_plan_claims_expiry_check', 63)) THEN
		ALTER TABLE "agent_retirement_plan_claims" ADD CONSTRAINT "agent_retirement_plan_claims_expiry_check" CHECK ("evidence_expires_at" >= "issued_at" AND "execution_expires_at" > "evidence_expires_at");
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_claims'::regclass AND conname = left('agent_retirement_execution_claims_receipt_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_claims" ADD CONSTRAINT "agent_retirement_execution_claims_receipt_check" CHECK ("receipt_id" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_claims'::regclass AND conname = left('agent_retirement_execution_claims_evidence_fingerprint_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_claims" ADD CONSTRAINT "agent_retirement_execution_claims_evidence_fingerprint_check" CHECK ("evidence_fingerprint" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_claims'::regclass AND conname = left('agent_retirement_execution_claims_initial_preflight_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_claims" ADD CONSTRAINT "agent_retirement_execution_claims_initial_preflight_check" CHECK ("initial_preflight_fingerprint" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_claims'::regclass AND conname = left('agent_retirement_execution_claims_cleanup_receipt_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_claims" ADD CONSTRAINT "agent_retirement_execution_claims_cleanup_receipt_check" CHECK ("cleanup_receipt_id" IS NULL OR "cleanup_receipt_id" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_claims'::regclass AND conname = left('agent_retirement_execution_claims_final_preflight_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_claims" ADD CONSTRAINT "agent_retirement_execution_claims_final_preflight_check" CHECK ("final_preflight_fingerprint" IS NULL OR "final_preflight_fingerprint" ~ '^v1:sha256:[a-f0-9]{64}$');
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_claims'::regclass AND conname = left('agent_retirement_execution_claims_phase_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_claims" ADD CONSTRAINT "agent_retirement_execution_claims_phase_check" CHECK ("phase" IN ('started', 'cleaned', 'termination_ready', 'terminated'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_claims'::regclass AND conname = left('agent_retirement_execution_claims_phase_payload_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_claims" ADD CONSTRAINT "agent_retirement_execution_claims_phase_payload_check" CHECK (
			("phase" = 'started' AND "cleanup_receipt_id" IS NULL AND "final_preflight_fingerprint" IS NULL)
			OR ("phase" = 'cleaned' AND "cleanup_receipt_id" IS NOT NULL AND "final_preflight_fingerprint" IS NULL)
			OR ("phase" IN ('termination_ready', 'terminated') AND "cleanup_receipt_id" IS NOT NULL AND "final_preflight_fingerprint" IS NOT NULL)
		);
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.agent_retirement_execution_claims'::regclass AND conname = left('agent_retirement_execution_claims_expiry_check', 63)) THEN
		ALTER TABLE "agent_retirement_execution_claims" ADD CONSTRAINT "agent_retirement_execution_claims_expiry_check" CHECK ("expires_at" > "started_at");
	END IF;
END
$migration$;
