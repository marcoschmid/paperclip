-- Retirement and lifecycle dependency checks address heartbeat history by
-- agent across companies. The existing company-first index cannot serve that
-- bounded lookup efficiently once run payloads become large.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_agent_idx"
	ON "heartbeat_runs" USING btree ("agent_id");
