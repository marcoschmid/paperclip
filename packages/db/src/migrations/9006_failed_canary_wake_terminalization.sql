CREATE OR REPLACE FUNCTION enforce_agent_wakeup_portfolio_maintenance_gate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	agent_metadata jsonb;
	agent_status text;
	gate_active boolean;
	gate_receipt text;
	gate_stage text;
	pending_lifecycle boolean;
	canary_authorized boolean;
	passed_canary_terminal_authorized boolean;
	failed_canary_terminal_authorized boolean;
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

	SELECT COALESCE(agent.metadata, '{}'::jsonb), agent.status
	INTO agent_metadata, agent_status
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

	-- A successful adapter run can still fail its final canary scope check. In
	-- that case the promotion transaction has already consumed the one-shot
	-- receipt, paused the exact agent, blocked the exact issue, and written a
	-- run-bound system comment before the ordinary run finalizer terminalizes
	-- the claimed wake. Admit only that fully bound terminal transition.
	failed_canary_terminal_authorized := COALESCE(
		TG_OP = 'UPDATE'
		AND OLD.status IN ('queued', 'claimed', 'deferred_issue_execution')
		AND NEW.status = 'completed'
		AND NEW.finished_at IS NOT NULL
		AND agent_status = 'paused'
		AND agent_metadata -> 'lifecycle' ->> 'lastCanaryResult' = 'failed'
		AND agent_metadata -> 'lifecycle' ->> 'canaryIssueId' = NEW.payload ->> 'issueId'
		AND agent_metadata -> 'lifecycle' -> 'pause' ->> 'reasonCode' = 'canary_failed'
		AND agent_metadata -> 'lifecycle' -> 'pause' ->> 'repairIssueId' = NEW.payload ->> 'issueId'
		AND NOT (agent_metadata ? 'lifecycleCanaryGate')
		AND NOT (agent_metadata ? 'lifecycleGate')
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
				AND run.context_snapshot ->> 'taskId' = agent_metadata -> 'lifecycle' ->> 'canaryIssueId'
				AND run.context_snapshot ->> 'taskKey' = 'lifecycle-canary:' || (agent_metadata -> 'lifecycle' ->> 'canaryIssueId')
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'agentId' = NEW.agent_id::text
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'companyId' = NEW.company_id::text
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'canaryIssueId' = agent_metadata -> 'lifecycle' ->> 'canaryIssueId'
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'runId' = NEW.run_id::text
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'receiptHash' ~ '^v1:sha256:[a-f0-9]{64}$'
				AND run.context_snapshot -> 'lifecycleCanary' ->> 'configFingerprint' ~ '^v1:sha256:[a-f0-9]{64}$'
		)
		AND EXISTS (
			SELECT 1
			FROM issues issue
			WHERE issue.id::text = NEW.payload ->> 'issueId'
				AND issue.company_id = NEW.company_id
				AND issue.assignee_agent_id = NEW.agent_id
				AND issue.status = 'blocked'
				AND issue.checkout_run_id IS NULL
				AND issue.execution_run_id IS NULL
		)
		AND EXISTS (
			SELECT 1
			FROM issue_comments comment
			WHERE comment.company_id = NEW.company_id
				AND comment.issue_id::text = NEW.payload ->> 'issueId'
				AND comment.author_type = 'system'
				AND comment.created_by_run_id = NEW.run_id
				AND comment.body LIKE 'Lifecycle canary failed closed (%'
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

	IF NOT canary_authorized
		AND NOT passed_canary_terminal_authorized
		AND NOT failed_canary_terminal_authorized
		AND NOT cleanup_authorized
		AND NOT (
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
