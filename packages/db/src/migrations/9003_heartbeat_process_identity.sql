ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "process_executable" text;

ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "process_command_sha256" text;
