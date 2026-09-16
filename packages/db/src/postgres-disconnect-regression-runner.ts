import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export type PostgresDisconnectRegressionScenario =
  | "queued-write-during-reconnect"
  | "stale-transaction-after-reconnect"
  | "real-idle-transaction-timeout";

export type PostgresDisconnectRegressionResult = Record<string, unknown>;

const childPath = fileURLToPath(
  new URL("./postgres-disconnect-regression-child.mjs", import.meta.url),
);
const resultPrefix = "PAPERCLIP_POSTGRES_DISCONNECT_RESULT=";

export async function runPostgresDisconnectRegressionChild(
  scenario: PostgresDisconnectRegressionScenario,
  options: { databaseUrl?: string; timeoutMs?: number } = {},
): Promise<PostgresDisconnectRegressionResult> {
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [childPath],
        {
          env: {
            ...process.env,
            PAPERCLIP_POSTGRES_DISCONNECT_SCENARIO: scenario,
            ...(options.databaseUrl
              ? { PAPERCLIP_POSTGRES_DISCONNECT_DATABASE_URL: options.databaseUrl }
              : {}),
          },
          encoding: "utf8",
          timeout: options.timeoutMs ?? 15_000,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
        },
        (error, childStdout, childStderr) => {
          if (error) {
            reject(
              new Error(
                [
                  `postgres disconnect regression child failed (${scenario}): ${error.message}`,
                  childStdout.trim() ? `stdout:\n${childStdout.trim()}` : "",
                  childStderr.trim() ? `stderr:\n${childStderr.trim()}` : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
              ),
            );
            return;
          }
          resolve({ stdout: childStdout, stderr: childStderr });
        },
      );
    },
  );

  const resultLine = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(resultPrefix));
  if (!resultLine) {
    throw new Error(
      [
        `postgres disconnect regression child returned no result (${scenario})`,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
        stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return JSON.parse(resultLine.slice(resultPrefix.length)) as PostgresDisconnectRegressionResult;
}
