CREATE TABLE "routine_run_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_run_id" uuid NOT NULL,
	"issue_id" uuid,
	"assignee_agent_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"wakeup_idempotency_key" text NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"delivered_wakeup_request_id" uuid,
	"delivered_heartbeat_run_id" uuid,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_run_deliveries_status_check" CHECK ("status" in ('pending', 'claimed', 'delivered', 'failed')),
	CONSTRAINT "routine_run_deliveries_attempt_count_check" CHECK ("attempt_count" >= 0),
	CONSTRAINT "routine_run_deliveries_wakeup_idempotency_check" CHECK ("wakeup_idempotency_key" = 'routine-delivery:' || "routine_run_id"::text),
	CONSTRAINT "routine_run_deliveries_last_error_bound_check" CHECK ("last_error" is null or char_length("last_error") <= 1024),
	CONSTRAINT "routine_run_deliveries_active_identity_check" CHECK ("status" in ('failed') or ("issue_id" is not null and "assignee_agent_id" is not null)),
	CONSTRAINT "routine_run_deliveries_claim_window_check" CHECK ("claimed_at" is null or "claim_expires_at" > "claimed_at"),
	CONSTRAINT "routine_run_deliveries_status_payload_check" CHECK ((
		("status" = 'pending' and "claim_token" is null and "claimed_at" is null and "claim_expires_at" is null and "delivered_wakeup_request_id" is null and "delivered_heartbeat_run_id" is null and "delivered_at" is null and "failed_at" is null)
		or ("status" = 'claimed' and "claim_token" is not null and "claimed_at" is not null and "claim_expires_at" is not null and "delivered_wakeup_request_id" is null and "delivered_heartbeat_run_id" is null and "delivered_at" is null and "failed_at" is null)
		or ("status" = 'delivered' and "claim_token" is null and "claimed_at" is null and "claim_expires_at" is null and "delivered_wakeup_request_id" is not null and "delivered_heartbeat_run_id" is not null and "delivered_at" is not null and "failed_at" is null)
		or ("status" = 'failed' and "claim_token" is null and "claimed_at" is null and "claim_expires_at" is null and "delivered_wakeup_request_id" is null and "delivered_heartbeat_run_id" is null and "delivered_at" is null and "failed_at" is not null)
	))
);
--> statement-breakpoint
ALTER TABLE "routine_run_deliveries" ADD CONSTRAINT "routine_run_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routine_run_deliveries" ADD CONSTRAINT "routine_run_deliveries_routine_run_id_routine_runs_id_fk" FOREIGN KEY ("routine_run_id") REFERENCES "public"."routine_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routine_run_deliveries" ADD CONSTRAINT "routine_run_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routine_run_deliveries" ADD CONSTRAINT "routine_run_deliveries_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routine_run_deliveries" ADD CONSTRAINT "routine_run_deliveries_delivered_wakeup_request_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("delivered_wakeup_request_id") REFERENCES "public"."agent_wakeup_requests"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "routine_run_deliveries" ADD CONSTRAINT "routine_run_deliveries_delivered_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("delivered_heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "routine_run_deliveries_routine_run_unique" ON "routine_run_deliveries" USING btree ("routine_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "routine_run_deliveries_wakeup_idempotency_unique" ON "routine_run_deliveries" USING btree ("wakeup_idempotency_key");
--> statement-breakpoint
CREATE INDEX "routine_run_deliveries_status_available_idx" ON "routine_run_deliveries" USING btree ("status","available_at");
--> statement-breakpoint
CREATE INDEX "routine_run_deliveries_agent_status_idx" ON "routine_run_deliveries" USING btree ("assignee_agent_id","status");
--> statement-breakpoint
CREATE INDEX "routine_run_deliveries_company_status_idx" ON "routine_run_deliveries" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "routine_run_deliveries_claimed_expiry_idx" ON "routine_run_deliveries" USING btree ("status","claim_expires_at") WHERE "status" = 'claimed';
--> statement-breakpoint
CREATE FUNCTION "enforce_routine_run_delivery_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	run_company_id uuid;
	run_linked_issue_id uuid;
	routine_company_id uuid;
	issue_company_id uuid;
	issue_assignee_agent_id uuid;
	issue_origin_run_id text;
	agent_company_id uuid;
BEGIN
	SELECT rr."company_id", rr."linked_issue_id", r."company_id"
	INTO run_company_id, run_linked_issue_id, routine_company_id
	FROM "routine_runs" rr
	INNER JOIN "routines" r ON r."id" = rr."routine_id"
	WHERE rr."id" = NEW."routine_run_id";
	IF NOT FOUND OR run_company_id IS DISTINCT FROM NEW."company_id"
		OR routine_company_id IS DISTINCT FROM NEW."company_id" THEN
		RAISE EXCEPTION 'routine_run_delivery_identity_mismatch' USING ERRCODE = '23514';
	END IF;

	IF NEW."issue_id" IS NOT NULL THEN
		SELECT i."company_id", i."assignee_agent_id", i."origin_run_id"
		INTO issue_company_id, issue_assignee_agent_id, issue_origin_run_id
		FROM "issues" i WHERE i."id" = NEW."issue_id";
		IF NOT FOUND OR issue_company_id IS DISTINCT FROM NEW."company_id" THEN
			RAISE EXCEPTION 'routine_run_delivery_issue_tenant_mismatch' USING ERRCODE = '23514';
		END IF;
	END IF;

	IF NEW."assignee_agent_id" IS NOT NULL THEN
		SELECT a."company_id" INTO agent_company_id
		FROM "agents" a WHERE a."id" = NEW."assignee_agent_id";
		IF NOT FOUND OR agent_company_id IS DISTINCT FROM NEW."company_id" THEN
			RAISE EXCEPTION 'routine_run_delivery_agent_tenant_mismatch' USING ERRCODE = '23514';
		END IF;
	END IF;

	IF NEW."status" <> 'failed' AND (
		run_linked_issue_id IS DISTINCT FROM NEW."issue_id"
		OR issue_assignee_agent_id IS DISTINCT FROM NEW."assignee_agent_id"
		OR issue_origin_run_id IS DISTINCT FROM NEW."routine_run_id"::text
	) THEN
		RAISE EXCEPTION 'routine_run_delivery_active_identity_mismatch' USING ERRCODE = '23514';
	END IF;

	IF NEW."status" = 'delivered' THEN
		-- Lock both proof rows before accepting a delivered receipt. This makes
		-- direct SQL writers obey the same serialization as the service path:
		-- a concurrent reverse-identity update either wins first and invalidates
		-- this insert, or waits and is rejected by the reverse guards below.
		PERFORM awr."id"
		FROM "agent_wakeup_requests" awr
		INNER JOIN "heartbeat_runs" hr
			ON hr."id" = NEW."delivered_heartbeat_run_id"
			AND hr."id" = awr."run_id"
			AND hr."wakeup_request_id" = awr."id"
		WHERE awr."id" = NEW."delivered_wakeup_request_id"
			AND awr."company_id" = NEW."company_id"
			AND awr."agent_id" = NEW."assignee_agent_id"
			AND awr."idempotency_key" = NEW."wakeup_idempotency_key"
			AND awr."payload" ->> 'issueId' = NEW."issue_id"::text
			AND hr."company_id" = NEW."company_id"
			AND hr."agent_id" = NEW."assignee_agent_id"
			AND hr."context_snapshot" ->> 'issueId' = NEW."issue_id"::text
		FOR KEY SHARE OF awr, hr;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'routine_run_delivery_evidence_mismatch' USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "routine_run_deliveries_identity_guard"
AFTER INSERT OR UPDATE ON "routine_run_deliveries"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_routine_run_delivery_identity"();
--> statement-breakpoint
WITH legacy_candidates AS (
	SELECT rr."id" AS routine_run_id, rr."company_id", rr."linked_issue_id" AS issue_id,
		i."assignee_agent_id"
	FROM "routine_runs" rr
	INNER JOIN "routines" r
		ON r."id" = rr."routine_id" AND r."company_id" = rr."company_id"
	INNER JOIN "issues" i
		ON i."id" = rr."linked_issue_id"
		AND i."company_id" = rr."company_id"
		AND i."origin_run_id" = rr."id"::text
		AND i."assignee_agent_id" IS NOT NULL
	INNER JOIN "agents" a
		ON a."id" = i."assignee_agent_id" AND a."company_id" = rr."company_id"
	WHERE rr."status" = 'received'
), exact_legacy_evidence AS (
	SELECT c."routine_run_id", c."company_id", c."issue_id", c."assignee_agent_id",
		(array_agg(awr."id" ORDER BY awr."id"))[1] AS wakeup_request_id
	FROM legacy_candidates c
	INNER JOIN "agent_wakeup_requests" awr
		ON awr."company_id" = c."company_id"
		AND awr."agent_id" = c."assignee_agent_id"
		AND awr."source" = 'assignment'
		AND awr."trigger_detail" = 'system'
		AND awr."payload" ->> 'issueId' = c."issue_id"::text
		AND awr."payload" ->> 'mutation' = 'create'
		AND awr."idempotency_key" IS NULL
	INNER JOIN "heartbeat_runs" hr
		ON hr."id" = awr."run_id"
		AND hr."wakeup_request_id" = awr."id"
		AND hr."company_id" = c."company_id"
		AND hr."agent_id" = c."assignee_agent_id"
		AND hr."context_snapshot" ->> 'issueId' = c."issue_id"::text
	GROUP BY c."routine_run_id", c."company_id", c."issue_id", c."assignee_agent_id"
	HAVING count(*) = 1
		AND (SELECT count(*) FROM "agent_wakeup_requests" potential
			WHERE potential."company_id" = c."company_id"
				AND potential."agent_id" = c."assignee_agent_id"
				AND potential."source" = 'assignment'
				AND potential."trigger_detail" = 'system'
				AND potential."payload" ->> 'issueId' = c."issue_id"::text
				AND potential."payload" ->> 'mutation' = 'create') = 1
)
UPDATE "agent_wakeup_requests" awr
SET "idempotency_key" = 'routine-delivery:' || evidence."routine_run_id"::text,
	"updated_at" = now()
FROM exact_legacy_evidence evidence
WHERE awr."id" = evidence."wakeup_request_id";
--> statement-breakpoint
WITH legacy_candidates AS (
	SELECT rr."id" AS routine_run_id, rr."company_id", rr."linked_issue_id" AS issue_id,
		i."assignee_agent_id"
	FROM "routine_runs" rr
	INNER JOIN "routines" r
		ON r."id" = rr."routine_id" AND r."company_id" = rr."company_id"
	INNER JOIN "issues" i
		ON i."id" = rr."linked_issue_id"
		AND i."company_id" = rr."company_id"
		AND i."origin_run_id" = rr."id"::text
		AND i."assignee_agent_id" IS NOT NULL
	INNER JOIN "agents" a
		ON a."id" = i."assignee_agent_id" AND a."company_id" = rr."company_id"
	WHERE rr."status" = 'received'
), classified AS (
	SELECT c.*,
		coalesce(evidence.potential_count, 0) AS potential_count,
		coalesce(evidence.exact_count, 0) AS exact_count,
		evidence.wakeup_request_id,
		evidence.heartbeat_run_id
	FROM legacy_candidates c
	LEFT JOIN LATERAL (
		SELECT count(DISTINCT awr."id")::integer AS potential_count,
			count(hr."id")::integer AS exact_count,
			(array_agg(awr."id" ORDER BY awr."id") FILTER (WHERE hr."id" IS NOT NULL))[1] AS wakeup_request_id,
			(array_agg(hr."id" ORDER BY hr."id") FILTER (WHERE hr."id" IS NOT NULL))[1] AS heartbeat_run_id
		FROM "agent_wakeup_requests" awr
		LEFT JOIN "heartbeat_runs" hr
			ON hr."id" = awr."run_id"
			AND hr."wakeup_request_id" = awr."id"
			AND hr."company_id" = c."company_id"
			AND hr."agent_id" = c."assignee_agent_id"
			AND hr."context_snapshot" ->> 'issueId' = c."issue_id"::text
		WHERE awr."company_id" = c."company_id"
			AND awr."agent_id" = c."assignee_agent_id"
			AND awr."source" = 'assignment'
			AND awr."trigger_detail" = 'system'
			AND awr."payload" ->> 'issueId' = c."issue_id"::text
			AND awr."payload" ->> 'mutation' = 'create'
	) evidence ON true
)
INSERT INTO "routine_run_deliveries" (
	"id", "company_id", "routine_run_id", "issue_id", "assignee_agent_id", "status",
	"wakeup_idempotency_key", "attempt_count", "available_at", "last_error",
	"delivered_wakeup_request_id", "delivered_heartbeat_run_id", "delivered_at", "failed_at",
	"created_at", "updated_at"
)
SELECT gen_random_uuid(), classified."company_id", classified."routine_run_id", classified."issue_id",
	classified."assignee_agent_id",
	CASE WHEN classified.potential_count = 1 AND classified.exact_count = 1
		AND awr."idempotency_key" = 'routine-delivery:' || classified."routine_run_id"::text
		THEN 'delivered' ELSE 'failed' END,
	'routine-delivery:' || classified."routine_run_id"::text,
	0, now(),
	CASE WHEN classified.potential_count = 1 AND classified.exact_count = 1
		AND awr."idempotency_key" = 'routine-delivery:' || classified."routine_run_id"::text THEN NULL
		WHEN classified.potential_count = 0 THEN 'legacy_received_no_wake_evidence'
		ELSE 'legacy_received_ambiguous_wake_evidence' END,
	CASE WHEN classified.potential_count = 1 AND classified.exact_count = 1
		AND awr."idempotency_key" = 'routine-delivery:' || classified."routine_run_id"::text
		THEN classified.wakeup_request_id ELSE NULL END,
	CASE WHEN classified.potential_count = 1 AND classified.exact_count = 1
		AND awr."idempotency_key" = 'routine-delivery:' || classified."routine_run_id"::text
		THEN classified.heartbeat_run_id ELSE NULL END,
	CASE WHEN classified.potential_count = 1 AND classified.exact_count = 1
		AND awr."idempotency_key" = 'routine-delivery:' || classified."routine_run_id"::text
		THEN now() ELSE NULL END,
	CASE WHEN classified.potential_count = 1 AND classified.exact_count = 1
		AND awr."idempotency_key" = 'routine-delivery:' || classified."routine_run_id"::text
		THEN NULL ELSE now() END,
	now(), now()
FROM classified
LEFT JOIN "agent_wakeup_requests" awr ON awr."id" = classified.wakeup_request_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "routine_runs" rr
SET "status" = CASE WHEN delivery."status" = 'delivered' THEN 'issue_created' ELSE 'failed' END,
	-- A failed historical proof is not proof that the issue is disposable.
	-- Preserve the link for audit/recovery and never infer that no other live
	-- heartbeat, queued wake, delivered run, or coalesced follower owns it.
	"linked_issue_id" = delivery."issue_id",
	"failure_reason" = CASE WHEN delivery."status" = 'failed' THEN delivery."last_error" ELSE NULL END,
	"completed_at" = now(),
	"updated_at" = now()
FROM "routine_run_deliveries" delivery
WHERE rr."id" = delivery."routine_run_id" AND rr."status" = 'received';
--> statement-breakpoint
UPDATE "routine_runs" rr
SET "status" = 'failed',
	"failure_reason" = 'legacy_received_identity_invalid',
	"completed_at" = now(),
	"updated_at" = now()
WHERE rr."status" = 'received'
	AND NOT EXISTS (
		SELECT 1 FROM "routine_run_deliveries" delivery WHERE delivery."routine_run_id" = rr."id"
	);
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: migrations run transactionally; routine-delivery is a new idempotency namespace with no pre-existing matching rows
CREATE UNIQUE INDEX "agent_wakeup_requests_routine_delivery_idempotency_unique" ON "agent_wakeup_requests" USING btree ("company_id","agent_id","idempotency_key") WHERE "idempotency_key" like 'routine-delivery:%';
--> statement-breakpoint
CREATE FUNCTION "protect_delivered_routine_wakeup_evidence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF EXISTS (
			SELECT 1 FROM "routine_run_deliveries" delivery
			WHERE delivery."status" = 'delivered'
				AND delivery."delivered_wakeup_request_id" = OLD."id"
		) THEN
			RAISE EXCEPTION 'routine_delivery_wakeup_evidence_is_immutable' USING ERRCODE = '23514';
		END IF;
		RETURN OLD;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "routine_run_deliveries" delivery
		LEFT JOIN "heartbeat_runs" heartbeat
			ON heartbeat."id" = delivery."delivered_heartbeat_run_id"
		WHERE delivery."status" = 'delivered'
			AND delivery."delivered_wakeup_request_id" = OLD."id"
			AND (
				NEW."id" IS DISTINCT FROM delivery."delivered_wakeup_request_id"
				OR NEW."company_id" IS DISTINCT FROM delivery."company_id"
				OR NEW."agent_id" IS DISTINCT FROM delivery."assignee_agent_id"
				OR NEW."idempotency_key" IS DISTINCT FROM delivery."wakeup_idempotency_key"
				OR NEW."payload" ->> 'issueId' IS DISTINCT FROM delivery."issue_id"::text
				OR NEW."run_id" IS DISTINCT FROM delivery."delivered_heartbeat_run_id"
				OR heartbeat."id" IS NULL
				OR heartbeat."wakeup_request_id" IS DISTINCT FROM NEW."id"
			)
	) THEN
		RAISE EXCEPTION 'routine_delivery_wakeup_evidence_is_immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_wakeup_requests_routine_delivery_evidence_update_guard"
BEFORE UPDATE OF "id", "company_id", "agent_id", "idempotency_key", "payload", "run_id"
ON "agent_wakeup_requests"
FOR EACH ROW
EXECUTE FUNCTION "protect_delivered_routine_wakeup_evidence"();
--> statement-breakpoint
CREATE TRIGGER "agent_wakeup_requests_routine_delivery_evidence_delete_guard"
BEFORE DELETE ON "agent_wakeup_requests"
FOR EACH ROW
EXECUTE FUNCTION "protect_delivered_routine_wakeup_evidence"();
--> statement-breakpoint
CREATE FUNCTION "protect_delivered_routine_heartbeat_evidence"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF EXISTS (
			SELECT 1 FROM "routine_run_deliveries" delivery
			WHERE delivery."status" = 'delivered'
				AND delivery."delivered_heartbeat_run_id" = OLD."id"
		) THEN
			RAISE EXCEPTION 'routine_delivery_heartbeat_evidence_is_immutable' USING ERRCODE = '23514';
		END IF;
		RETURN OLD;
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "routine_run_deliveries" delivery
		LEFT JOIN "agent_wakeup_requests" wakeup
			ON wakeup."id" = delivery."delivered_wakeup_request_id"
		WHERE delivery."status" = 'delivered'
			AND delivery."delivered_heartbeat_run_id" = OLD."id"
			AND (
				NEW."id" IS DISTINCT FROM delivery."delivered_heartbeat_run_id"
				OR NEW."company_id" IS DISTINCT FROM delivery."company_id"
				OR NEW."agent_id" IS DISTINCT FROM delivery."assignee_agent_id"
				OR NEW."wakeup_request_id" IS DISTINCT FROM delivery."delivered_wakeup_request_id"
				OR NEW."context_snapshot" ->> 'issueId' IS DISTINCT FROM delivery."issue_id"::text
				OR wakeup."id" IS NULL
				OR wakeup."run_id" IS DISTINCT FROM NEW."id"
			)
	) THEN
		RAISE EXCEPTION 'routine_delivery_heartbeat_evidence_is_immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_routine_delivery_evidence_update_guard"
BEFORE UPDATE OF "id", "company_id", "agent_id", "wakeup_request_id", "context_snapshot"
ON "heartbeat_runs"
FOR EACH ROW
EXECUTE FUNCTION "protect_delivered_routine_heartbeat_evidence"();
--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_routine_delivery_evidence_delete_guard"
BEFORE DELETE ON "heartbeat_runs"
FOR EACH ROW
EXECUTE FUNCTION "protect_delivered_routine_heartbeat_evidence"();
