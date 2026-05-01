-- Down: add_issue_runs

DROP INDEX IF EXISTS "issue_runs_executor_idx";
DROP INDEX IF EXISTS "issue_runs_status_idx";
DROP INDEX IF EXISTS "issue_runs_company_status_idx";
DROP INDEX IF EXISTS "issue_runs_active_lease_per_issue_uq";
DROP TABLE IF EXISTS "issue_runs";
