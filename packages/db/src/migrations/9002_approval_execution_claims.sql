CREATE TABLE "approval_execution_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"origin_run_id" uuid NOT NULL,
	"executor_run_id" uuid NOT NULL,
	"execution_run_id" text NOT NULL,
	"approval_payload_sha256" text NOT NULL,
	"receipt_sha256" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_origin_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_executor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("executor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_execution_claims_approval_unique" ON "approval_execution_claims" USING btree ("approval_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_execution_claims_execution_run_unique" ON "approval_execution_claims" USING btree ("execution_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_execution_claims_receipt_unique" ON "approval_execution_claims" USING btree ("receipt_sha256");
--> statement-breakpoint
CREATE INDEX "approval_execution_claims_company_claimed_idx" ON "approval_execution_claims" USING btree ("company_id","claimed_at");
--> statement-breakpoint
CREATE INDEX "approval_execution_claims_agent_claimed_idx" ON "approval_execution_claims" USING btree ("agent_id","claimed_at");
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_execution_run_id_check" CHECK (length(btrim("execution_run_id")) between 1 and 200);
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_payload_sha_check" CHECK ("approval_payload_sha256" ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
ALTER TABLE "approval_execution_claims" ADD CONSTRAINT "approval_execution_claims_receipt_sha_check" CHECK ("receipt_sha256" ~ '^[a-f0-9]{64}$');
