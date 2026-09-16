CREATE TABLE "workspace_runtime_start_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"service_key" text NOT NULL,
	"claim_id" uuid NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"runtime_service_id" uuid,
	"owner_agent_id" uuid,
	"failure_code" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_runtime_start_claims_status_check" CHECK ("workspace_runtime_start_claims"."status" in ('starting', 'running', 'stopped', 'failed')),
	CONSTRAINT "workspace_runtime_start_claims_service_key_check" CHECK (length(btrim("workspace_runtime_start_claims"."service_key")) between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "workspace_runtime_start_claims" ADD CONSTRAINT "workspace_runtime_start_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_runtime_start_claims" ADD CONSTRAINT "workspace_runtime_start_claims_runtime_service_id_workspace_runtime_services_id_fk" FOREIGN KEY ("runtime_service_id") REFERENCES "public"."workspace_runtime_services"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_runtime_start_claims" ADD CONSTRAINT "workspace_runtime_start_claims_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_runtime_start_claims_company_service_unique" ON "workspace_runtime_start_claims" USING btree ("company_id","service_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_runtime_start_claims_claim_unique" ON "workspace_runtime_start_claims" USING btree ("claim_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_runtime_start_claims_runtime_service_unique" ON "workspace_runtime_start_claims" USING btree ("runtime_service_id");
--> statement-breakpoint
CREATE INDEX "workspace_runtime_start_claims_owner_status_idx" ON "workspace_runtime_start_claims" USING btree ("owner_agent_id","status");
--> statement-breakpoint
CREATE INDEX "workspace_runtime_start_claims_company_status_expiry_idx" ON "workspace_runtime_start_claims" USING btree ("company_id","status","expires_at");
