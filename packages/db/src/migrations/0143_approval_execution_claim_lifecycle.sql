ALTER TABLE "approval_execution_claims" ADD COLUMN "call_fingerprint_sha256" text;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD COLUMN "status" text DEFAULT 'revoked' NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD COLUMN "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD COLUMN "execution_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD COLUMN "execution_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD COLUMN "execution_receipt_sha256" text;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD COLUMN "finished_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD COLUMN "failure_code" text;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD COLUMN "finalization_receipt_sha256" text;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD COLUMN "revoked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD COLUMN "revocation_reason" text;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
UPDATE "approval_execution_claims"
SET
  "call_fingerprint_sha256" = "approval_payload_sha256",
  "expires_at" = "claimed_at" + interval '1 microsecond',
  "revoked_at" = "claimed_at",
  "revocation_reason" = 'legacy_claim_unconsumable',
  "updated_at" = greatest("claimed_at", now())
WHERE "call_fingerprint_sha256" IS NULL OR "expires_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ALTER COLUMN "call_fingerprint_sha256" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ALTER COLUMN "expires_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ALTER COLUMN "status" SET DEFAULT 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_execution_claims_execution_receipt_unique" ON "approval_execution_claims" USING btree ("execution_receipt_sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_execution_claims_finalization_receipt_unique" ON "approval_execution_claims" USING btree ("finalization_receipt_sha256");
--> statement-breakpoint
CREATE INDEX "approval_execution_claims_company_status_expiry_idx" ON "approval_execution_claims" USING btree ("company_id","status","expires_at");
--> statement-breakpoint
CREATE INDEX "approval_execution_claims_executor_status_idx" ON "approval_execution_claims" USING btree ("executor_run_id","status");
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_call_fingerprint_sha_check" CHECK ("call_fingerprint_sha256" ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_execution_receipt_sha_check" CHECK ("execution_receipt_sha256" is null or "execution_receipt_sha256" ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_finalization_receipt_sha_check" CHECK ("finalization_receipt_sha256" is null or "finalization_receipt_sha256" ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_status_check" CHECK ("status" in ('pending', 'executing', 'completed', 'failed', 'revoked'));
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_expiry_check" CHECK ("expires_at" > "claimed_at");
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_lifecycle_check" CHECK (
  ("status" = 'pending'
    and "execution_started_at" is null
    and "execution_expires_at" is null
    and "execution_receipt_sha256" is null
    and "finished_at" is null
    and "failure_code" is null
    and "finalization_receipt_sha256" is null
    and "revoked_at" is null
    and "revocation_reason" is null)
  or
  ("status" = 'executing'
    and "execution_started_at" is not null
    and "execution_expires_at" > "execution_started_at"
    and "execution_receipt_sha256" is not null
    and "finished_at" is null
    and "failure_code" is null
    and "finalization_receipt_sha256" is null
    and "revoked_at" is null
    and "revocation_reason" is null)
  or
  ("status" = 'completed'
    and "execution_started_at" is not null
    and "execution_expires_at" > "execution_started_at"
    and "execution_receipt_sha256" is not null
    and "finished_at" is not null
    and "failure_code" is null
    and "finalization_receipt_sha256" is not null
    and "revoked_at" is null
    and "revocation_reason" is null)
  or
  ("status" = 'failed'
    and "execution_started_at" is not null
    and "execution_expires_at" > "execution_started_at"
    and "execution_receipt_sha256" is not null
    and "finished_at" is not null
    and "failure_code" is not null
    and "finalization_receipt_sha256" is not null
    and "revoked_at" is null
    and "revocation_reason" is null)
  or
  ("status" = 'revoked'
    and "execution_started_at" is null
    and "execution_expires_at" is null
    and "execution_receipt_sha256" is null
    and "finished_at" is null
    and "failure_code" is null
    and "finalization_receipt_sha256" is null
    and "revoked_at" is not null
    and "revocation_reason" is not null)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "approval_execution_claims_before_run_terminal"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
     AND OLD.status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out') THEN
    IF EXISTS (
      SELECT 1
      FROM approval_execution_claims claim
      WHERE claim.executor_run_id = NEW.id
        AND claim.status = 'executing'
    ) THEN
      RAISE EXCEPTION 'Active approval execution lease blocks terminal run transition'
        USING ERRCODE = '23514';
    END IF;

    UPDATE approval_execution_claims
    SET
      status = 'revoked',
      revoked_at = clock_timestamp(),
      revocation_reason = 'executor_run_terminal',
      updated_at = clock_timestamp()
    WHERE executor_run_id = NEW.id
      AND status = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "approval_execution_claims_run_terminal_guard" ON "heartbeat_runs";
--> statement-breakpoint
CREATE TRIGGER "approval_execution_claims_run_terminal_guard"
BEFORE UPDATE OF "status" ON "heartbeat_runs"
FOR EACH ROW
EXECUTE FUNCTION "approval_execution_claims_before_run_terminal"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "approval_execution_claims_before_agent_terminal"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'terminated' AND OLD.status <> 'terminated' THEN
    IF EXISTS (
      SELECT 1
      FROM approval_execution_claims claim
      WHERE claim.agent_id = NEW.id
        AND claim.status = 'executing'
    ) THEN
      RAISE EXCEPTION 'Active approval execution lease blocks terminal agent transition'
        USING ERRCODE = '23514';
    END IF;

    UPDATE approval_execution_claims
    SET
      status = 'revoked',
      revoked_at = clock_timestamp(),
      revocation_reason = 'agent_terminal',
      updated_at = clock_timestamp()
    WHERE agent_id = NEW.id
      AND status = 'pending';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "approval_execution_claims_agent_terminal_guard" ON "agents";
--> statement-breakpoint
CREATE TRIGGER "approval_execution_claims_agent_terminal_guard"
BEFORE UPDATE OF "status" ON "agents"
FOR EACH ROW
EXECUTE FUNCTION "approval_execution_claims_before_agent_terminal"();
