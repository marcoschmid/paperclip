-- Migration: phase6_memory_tables
-- Consolidates Phase-0.5 drafts 0061_add_project_documents + 0062_add_decisions
-- into the canonical migration sequence so fresh/test databases get the
-- project-memory tables (decisions, project_documents) and the documents
-- tags/metadata columns. Fully idempotent (IF NOT EXISTS / guarded ADD
-- CONSTRAINT): a no-op on the live DB where Phase-0.5 already applied these.
-- Spec: projects/jarvis-os-redesign/docs/2026-04-30-system-redesign-design.md (Anhang B / Phase 6 Memory-Mapping).

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "documents" SET "tags" = '[]'::jsonb WHERE "tags" IS NULL;
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "tags" SET DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "tags" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "documents" SET "metadata" = '{}'::jsonb WHERE "metadata" IS NULL;
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "metadata" SET NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'project_documents_company_id_companies_id_fk'
			AND conrelid = 'public.project_documents'::regclass
	) THEN
		ALTER TABLE "project_documents"
			ADD CONSTRAINT "project_documents_company_id_companies_id_fk"
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
		WHERE conname = 'project_documents_project_id_projects_id_fk'
			AND conrelid = 'public.project_documents'::regclass
	) THEN
		ALTER TABLE "project_documents"
			ADD CONSTRAINT "project_documents_project_id_projects_id_fk"
			FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'project_documents_document_id_documents_id_fk'
			AND conrelid = 'public.project_documents'::regclass
	) THEN
		ALTER TABLE "project_documents"
			ADD CONSTRAINT "project_documents_document_id_documents_id_fk"
			FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_documents_company_project_key_uq"
ON "project_documents" USING btree ("company_id", "project_id", "key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_documents_document_uq"
ON "project_documents" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_documents_company_project_updated_idx"
ON "project_documents" USING btree ("company_id", "project_id", "updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_project_slug" text NOT NULL,
	"source_key" text NOT NULL,
	"source_hash" text NOT NULL,
	"title" text NOT NULL,
	"context" text,
	"decision" text NOT NULL,
	"consequences" text,
	"status" text DEFAULT 'accepted' NOT NULL,
	"superseded_by" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'decisions_status_check'
			AND conrelid = 'public.decisions'::regclass
	) THEN
		ALTER TABLE "decisions"
			ADD CONSTRAINT "decisions_status_check"
			CHECK ("status" IN ('proposed', 'accepted', 'deprecated', 'superseded'));
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'decisions_company_id_companies_id_fk'
			AND conrelid = 'public.decisions'::regclass
	) THEN
		ALTER TABLE "decisions"
			ADD CONSTRAINT "decisions_company_id_companies_id_fk"
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
		WHERE conname = 'decisions_project_id_projects_id_fk'
			AND conrelid = 'public.decisions'::regclass
	) THEN
		ALTER TABLE "decisions"
			ADD CONSTRAINT "decisions_project_id_projects_id_fk"
			FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id")
			ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'decisions_superseded_by_decisions_id_fk'
			AND conrelid = 'public.decisions'::regclass
	) THEN
		ALTER TABLE "decisions"
			ADD CONSTRAINT "decisions_superseded_by_decisions_id_fk"
			FOREIGN KEY ("superseded_by") REFERENCES "public"."decisions"("id")
			ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'decisions_created_by_agent_id_agents_id_fk'
			AND conrelid = 'public.decisions'::regclass
	) THEN
		ALTER TABLE "decisions"
			ADD CONSTRAINT "decisions_created_by_agent_id_agents_id_fk"
			FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id")
			ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "decisions_company_source_key_uq"
ON "decisions" USING btree ("company_id", "source_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decisions_source_project_slug_idx"
ON "decisions" USING btree ("company_id", "source_project_slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decisions_status_idx" ON "decisions" USING btree ("status");
