CREATE TABLE "agent_portfolio_maintenance_gates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"expected_snapshot_fingerprint" text NOT NULL,
	"recovery_fingerprint" text NOT NULL,
	"receipt_id" text NOT NULL,
	"stage" text DEFAULT 'fenced' NOT NULL,
	"issued_by_user_id" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_portfolio_maintenance_gates" ADD CONSTRAINT "agent_portfolio_maintenance_gates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_portfolio_maintenance_gates" ADD CONSTRAINT "agent_portfolio_maintenance_gates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_portfolio_maintenance_gates_agent_unique" ON "agent_portfolio_maintenance_gates" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "agent_portfolio_maintenance_gates_company_operation_idx" ON "agent_portfolio_maintenance_gates" USING btree ("company_id","operation_id");
--> statement-breakpoint
CREATE INDEX "agent_portfolio_maintenance_gates_company_receipt_idx" ON "agent_portfolio_maintenance_gates" USING btree ("company_id","receipt_id");
--> statement-breakpoint
ALTER TABLE "agent_portfolio_maintenance_gates" ADD CONSTRAINT "agent_portfolio_maintenance_gates_stage_check" CHECK ("stage" IN ('fenced', 'quiesced'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_heartbeat_run_portfolio_maintenance_gate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	agent_metadata jsonb;
	gate_active boolean;
	gate_receipt text;
	gate_stage text;
	pending_lifecycle boolean;
	canary_authorized boolean;
	cleanup_authorized boolean;
	touches_active boolean;
BEGIN
	touches_active := NEW.status IN ('queued', 'running', 'scheduled_retry');
	IF TG_OP = 'UPDATE' THEN
		touches_active := touches_active OR OLD.status IN ('queued', 'running', 'scheduled_retry');
	END IF;
	IF NOT touches_active THEN
		RETURN NEW;
	END IF;
	IF TG_OP = 'UPDATE' AND (
		OLD.agent_id IS DISTINCT FROM NEW.agent_id
		OR OLD.company_id IS DISTINCT FROM NEW.company_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'heartbeat_run_active_scope_immutable';
	END IF;

	-- The always-present agent row is the serialization boundary.  A stale
	-- INSERT that took its statement snapshot before maintenance waits here;
	-- after the quiesce commit READ COMMITTED/EPQ observes the durable gate
	-- instead of admitting work from the stale snapshot. A paused status alone
	-- is not a maintenance fence: recovery must still be able to represent and
	-- reap historical active runs that belong to an otherwise paused agent.
	SELECT COALESCE(agent.metadata, '{}'::jsonb)
	INTO agent_metadata
	FROM agents agent
	WHERE agent.id = NEW.agent_id AND agent.company_id = NEW.company_id
	FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			MESSAGE = 'heartbeat_run_agent_scope_invalid';
	END IF;

	SELECT gate.receipt_id, gate.stage
	INTO gate_receipt, gate_stage
	FROM agent_portfolio_maintenance_gates gate
	WHERE gate.agent_id = NEW.agent_id AND gate.company_id = NEW.company_id;
	gate_active := FOUND;
	pending_lifecycle := COALESCE(
		agent_metadata -> 'lifecycle' ->> 'lastCanaryResult' = 'pending',
		false
	);

	IF NEW.status IN ('queued', 'running', 'scheduled_retry') AND NOT gate_active AND NOT pending_lifecycle THEN
		-- PostgreSQL intentionally writes a new MVCC row version even though the
		-- timestamp value is unchanged. This makes an admitted execution write
		-- visible to a concurrent SERIALIZABLE maintenance boundary; a quiesce
		-- that waited behind it must restart instead of retaining a stale
		-- heartbeat/wake snapshot.
		UPDATE agents
		SET updated_at = updated_at
		WHERE id = NEW.agent_id AND company_id = NEW.company_id;
		RETURN NEW;
	END IF;

	-- This exception is bound to the server-managed receipt stored on the
	-- locked agent row, the one pre-issued run id, its staged wake row, and the
	-- exact run context.  Null/missing values fail closed via COALESCE(...).
	canary_authorized := COALESCE(
		pending_lifecycle
		AND agent_metadata -> 'lifecycleCanaryGate' ->> 'schemaVersion' = '1.0.0'
		AND agent_metadata -> 'lifecycleCanaryGate' ->> 'agentId' = NEW.agent_id::text
		AND agent_metadata -> 'lifecycleCanaryGate' ->> 'companyId' = NEW.company_id::text
		AND agent_metadata -> 'lifecycleCanaryGate' ->> 'canaryIssueId' = agent_metadata -> 'lifecycle' ->> 'canaryIssueId'
		AND agent_metadata -> 'lifecycleCanaryGate' ->> 'runId' = NEW.id::text
		AND NEW.session_id_before IS NULL
		AND NEW.context_snapshot ->> 'forceFreshSession' = 'true'
		AND NEW.context_snapshot ->> 'wakeReason' = 'lifecycle_pending_canary'
		AND NEW.context_snapshot ->> 'issueId' = agent_metadata -> 'lifecycleCanaryGate' ->> 'canaryIssueId'
		AND NEW.context_snapshot ->> 'taskId' = agent_metadata -> 'lifecycleCanaryGate' ->> 'canaryIssueId'
		AND NEW.context_snapshot ->> 'taskKey' = 'lifecycle-canary:' || (agent_metadata -> 'lifecycleCanaryGate' ->> 'canaryIssueId')
		AND NEW.context_snapshot -> 'lifecycleCanary' ->> 'agentId' = NEW.agent_id::text
		AND NEW.context_snapshot -> 'lifecycleCanary' ->> 'companyId' = NEW.company_id::text
		AND NEW.context_snapshot -> 'lifecycleCanary' ->> 'canaryIssueId' = agent_metadata -> 'lifecycleCanaryGate' ->> 'canaryIssueId'
		AND NEW.context_snapshot -> 'lifecycleCanary' ->> 'runId' = NEW.id::text
		AND NEW.context_snapshot -> 'lifecycleCanary' ->> 'configFingerprint' = agent_metadata -> 'lifecycleCanaryGate' ->> 'configFingerprint'
		AND NEW.context_snapshot -> 'lifecycleCanary' ->> 'receiptHash' = agent_metadata -> 'lifecycleCanaryGate' ->> 'receiptHash'
		AND EXISTS (
			SELECT 1
			FROM agent_wakeup_requests wake
			WHERE wake.id = NEW.wakeup_request_id
				AND wake.agent_id = NEW.agent_id
				AND wake.company_id = NEW.company_id
				AND wake.status IN ('lifecycle_canary_staging', 'queued', 'claimed', 'deferred_issue_execution')
				AND wake.reason = 'lifecycle_pending_canary'
				AND wake.idempotency_key = 'lifecycle-canary:' || NEW.id::text
				AND wake.payload ->> 'issueId' = agent_metadata -> 'lifecycleCanaryGate' ->> 'canaryIssueId'
		),
		false
	);

	cleanup_authorized := COALESCE(
		TG_OP = 'UPDATE'
		AND OLD.status IN ('queued', 'running', 'scheduled_retry')
		AND NEW.status NOT IN ('queued', 'running', 'scheduled_retry')
		AND gate_active
		AND gate_stage = 'fenced'
		AND gate_receipt = current_setting('paperclip.portfolio_maintenance_receipt', true),
		false
	);

	IF NOT canary_authorized AND NOT cleanup_authorized AND NOT (
		NOT gate_active
		AND NEW.status NOT IN ('queued', 'running', 'scheduled_retry')
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'agent_portfolio_maintenance_gate_active';
	END IF;
	UPDATE agents
	SET updated_at = updated_at
	WHERE id = NEW.agent_id AND company_id = NEW.company_id;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_agent_wakeup_portfolio_maintenance_gate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	agent_metadata jsonb;
	gate_active boolean;
	gate_receipt text;
	gate_stage text;
	pending_lifecycle boolean;
	canary_authorized boolean;
	passed_canary_terminal_authorized boolean;
	cleanup_authorized boolean;
	touches_active boolean;
BEGIN
	touches_active := NEW.status IN ('queued', 'claimed', 'deferred_issue_execution');
	IF TG_OP = 'UPDATE' THEN
		touches_active := touches_active OR OLD.status IN ('queued', 'claimed', 'deferred_issue_execution');
	END IF;
	IF NOT touches_active THEN
		RETURN NEW;
	END IF;
	IF TG_OP = 'UPDATE' AND (
		OLD.agent_id IS DISTINCT FROM NEW.agent_id
		OR OLD.company_id IS DISTINCT FROM NEW.company_id
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'agent_wakeup_active_scope_immutable';
	END IF;

	SELECT COALESCE(agent.metadata, '{}'::jsonb)
	INTO agent_metadata
	FROM agents agent
	WHERE agent.id = NEW.agent_id AND agent.company_id = NEW.company_id
	FOR UPDATE;
	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23503',
			MESSAGE = 'agent_wakeup_agent_scope_invalid';
	END IF;

	SELECT gate.receipt_id, gate.stage
	INTO gate_receipt, gate_stage
	FROM agent_portfolio_maintenance_gates gate
	WHERE gate.agent_id = NEW.agent_id AND gate.company_id = NEW.company_id;
	gate_active := FOUND;
	pending_lifecycle := COALESCE(
		agent_metadata -> 'lifecycle' ->> 'lastCanaryResult' = 'pending',
		false
	);

	IF NEW.status IN ('queued', 'claimed', 'deferred_issue_execution') AND NOT gate_active AND NOT pending_lifecycle THEN
		UPDATE agents
		SET updated_at = updated_at
		WHERE id = NEW.agent_id AND company_id = NEW.company_id;
		RETURN NEW;
	END IF;

	canary_authorized := COALESCE(
		pending_lifecycle
		AND agent_metadata -> 'lifecycleCanaryGate' ->> 'schemaVersion' = '1.0.0'
		AND agent_metadata -> 'lifecycleCanaryGate' ->> 'agentId' = NEW.agent_id::text
		AND agent_metadata -> 'lifecycleCanaryGate' ->> 'companyId' = NEW.company_id::text
		AND agent_metadata -> 'lifecycleCanaryGate' ->> 'canaryIssueId' = agent_metadata -> 'lifecycle' ->> 'canaryIssueId'
		AND NEW.reason = 'lifecycle_pending_canary'
		AND NEW.run_id::text = agent_metadata -> 'lifecycleCanaryGate' ->> 'runId'
		AND NEW.idempotency_key = 'lifecycle-canary:' || (agent_metadata -> 'lifecycleCanaryGate' ->> 'runId')
		AND NEW.payload ->> 'issueId' = agent_metadata -> 'lifecycleCanaryGate' ->> 'canaryIssueId'
		AND EXISTS (
			SELECT 1
			FROM heartbeat_runs run
			WHERE run.id = NEW.run_id
				AND run.wakeup_request_id = NEW.id
				AND run.agent_id = NEW.agent_id
				AND run.company_id = NEW.company_id
				AND run.session_id_before IS NULL
				AND run.context_snapshot ->> 'forceFreshSession' = 'true'
				AND run.context_snapshot ->> 'wakeReason' = 'lifecycle_pending_canary'
				AND run.context_snapshot ->> 'issueId' = agent_metadata -> 'lifecycleCanaryGate' ->> 'canaryIssueId'
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'runId' = NEW.run_id::text
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'receiptHash' = agent_metadata -> 'lifecycleCanaryGate' ->> 'receiptHash'
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'configFingerprint' = agent_metadata -> 'lifecycleCanaryGate' ->> 'configFingerprint'
		),
		false
	);

	passed_canary_terminal_authorized := COALESCE(
		TG_OP = 'UPDATE'
		AND OLD.status IN ('queued', 'claimed', 'deferred_issue_execution')
		AND NEW.status NOT IN ('queued', 'claimed', 'deferred_issue_execution')
		AND agent_metadata -> 'lifecycle' ->> 'lastCanaryResult' = 'passed'
		AND agent_metadata -> 'lifecycle' ->> 'canaryIssueId' = NEW.payload ->> 'issueId'
		AND agent_metadata -> 'lifecycleGate' ->> 'schemaVersion' = '1.0.0'
		AND agent_metadata -> 'lifecycleGate' ->> 'lastSatisfiedRunId' = NEW.run_id::text
		AND NEW.reason = 'lifecycle_pending_canary'
		AND NEW.idempotency_key = 'lifecycle-canary:' || NEW.run_id::text
		AND EXISTS (
			SELECT 1
			FROM heartbeat_runs run
			WHERE run.id = NEW.run_id
				AND run.wakeup_request_id = NEW.id
				AND run.agent_id = NEW.agent_id
				AND run.company_id = NEW.company_id
				AND run.status = 'succeeded'
				AND run.session_id_before IS NULL
				AND run.context_snapshot ->> 'forceFreshSession' = 'true'
				AND run.context_snapshot ->> 'wakeReason' = 'lifecycle_pending_canary'
				AND run.context_snapshot ->> 'issueId' = agent_metadata -> 'lifecycle' ->> 'canaryIssueId'
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'runId' = NEW.run_id::text
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'receiptHash' = agent_metadata -> 'lifecycleGate' ->> 'receiptHash'
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'configFingerprint' = agent_metadata -> 'lifecycleGate' ->> 'configFingerprint'
		),
		false
	);

	cleanup_authorized := COALESCE(
		TG_OP = 'UPDATE'
		AND OLD.status IN ('queued', 'claimed', 'deferred_issue_execution')
		AND NEW.status NOT IN ('queued', 'claimed', 'deferred_issue_execution')
		AND gate_active
		AND gate_stage = 'fenced'
		AND gate_receipt = current_setting('paperclip.portfolio_maintenance_receipt', true),
		false
	);

	IF NOT canary_authorized AND NOT passed_canary_terminal_authorized AND NOT cleanup_authorized AND NOT (
		NOT gate_active
		AND NEW.status NOT IN ('queued', 'claimed', 'deferred_issue_execution')
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'agent_portfolio_maintenance_gate_active';
	END IF;
	UPDATE agents
	SET updated_at = updated_at
	WHERE id = NEW.agent_id AND company_id = NEW.company_id;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER heartbeat_runs_portfolio_maintenance_gate
BEFORE INSERT OR UPDATE OF status, agent_id, company_id, context_snapshot, wakeup_request_id, session_id_before
ON heartbeat_runs
FOR EACH ROW EXECUTE FUNCTION enforce_heartbeat_run_portfolio_maintenance_gate();
--> statement-breakpoint
CREATE TRIGGER agent_wakeup_requests_portfolio_maintenance_gate
BEFORE INSERT OR UPDATE OF status, agent_id, company_id, reason, idempotency_key, run_id, payload
ON agent_wakeup_requests
FOR EACH ROW EXECUTE FUNCTION enforce_agent_wakeup_portfolio_maintenance_gate();
