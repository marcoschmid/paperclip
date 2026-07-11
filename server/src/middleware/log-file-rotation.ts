import fs from "node:fs";

export type LogFileRotationOptions = {
  maxBytes: number;
  retentionFiles: number;
};

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_MAX_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_RETENTION_FILES = 5;
const MAX_RETENTION_FILES = 50;

function boundedPositiveInteger(value: number, fallback: number, maximum: number) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

export function rotateLogFileAtStartup(
  logFile: string,
  options: LogFileRotationOptions,
): boolean {
  const maxBytes = boundedPositiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES);
  const retentionFiles = boundedPositiveInteger(
    options.retentionFiles,
    DEFAULT_RETENTION_FILES,
    MAX_RETENTION_FILES,
  );
  let size: number;
  try {
    size = fs.statSync(logFile).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (size <= maxBytes) return false;

  fs.rmSync(`${logFile}.${retentionFiles}`, { force: true });
  for (let index = retentionFiles - 1; index >= 1; index -= 1) {
    const source = `${logFile}.${index}`;
    const target = `${logFile}.${index + 1}`;
    if (!fs.existsSync(source)) continue;
    fs.renameSync(source, target);
    fs.chmodSync(target, 0o600);
  }
  fs.renameSync(logFile, `${logFile}.1`);
  fs.chmodSync(`${logFile}.1`, 0o600);
  return true;
}
