import { describe, expect, it } from "vitest";
import {
  FORK_MIGRATION_LINEAGE,
  FORK_MIGRATION_HISTORY_TOMBSTONES,
  migrationHistoryNamesForFile,
  resolveMigrationHistoryHashes,
  resolveMigrationHistoryFileName,
  validateForkMigrationLineage,
} from "./migration-lineage.js";

function legacyHashes(): Map<string, string> {
  return new Map<string, string>(
    FORK_MIGRATION_LINEAGE.map((entry) => [entry.legacyFile, entry.sha256]),
  );
}

describe("fork migration lineage", () => {
  it("accepts exactly one byte-identical filename for every pinned migration", () => {
    const hashes = legacyHashes();
    const first = FORK_MIGRATION_LINEAGE[0];
    hashes.delete(first.legacyFile);
    hashes.set(first.canonicalFile, first.sha256);

    expect(validateForkMigrationLineage(hashes).get(first.sha256)).toBe(first.canonicalFile);
  });

  it("fails closed on changed, missing, or duplicate fork migrations", () => {
    const first = FORK_MIGRATION_LINEAGE[0];

    const changed = legacyHashes();
    changed.set(first.legacyFile, "0".repeat(64));
    expect(() => validateForkMigrationLineage(changed)).toThrow(/hash mismatch/i);

    const missing = legacyHashes();
    missing.delete(first.legacyFile);
    expect(() => validateForkMigrationLineage(missing)).toThrow(/missing/i);

    const duplicate = legacyHashes();
    duplicate.set(first.canonicalFile, first.sha256);
    expect(() => validateForkMigrationLineage(duplicate)).toThrow(/both/i);
  });

  it("aliases legacy name-based history only when the canonical file is available", () => {
    const first = FORK_MIGRATION_LINEAGE[0];

    expect(
      resolveMigrationHistoryFileName(first.legacyFile, new Set([first.canonicalFile])),
    ).toBe(first.canonicalFile);
    expect(
      resolveMigrationHistoryFileName(first.legacyFile, new Set([first.legacyFile])),
    ).toBe(first.legacyFile);
    expect(migrationHistoryNamesForFile(first.canonicalFile)).toEqual([
      first.canonicalFile,
      first.legacyFile,
    ]);
  });

  it("refuses to infer migration history from unknown hashes", () => {
    const filesByHash = new Map([["known-hash", "0000_known.sql"]]);

    expect(resolveMigrationHistoryHashes(["known-hash"], filesByHash)).toEqual([
      "0000_known.sql",
    ]);
    expect(() => resolveMigrationHistoryHashes(["unknown-hash"], filesByHash)).toThrow(
      /unknown hash/i,
    );
    expect(
      resolveMigrationHistoryHashes(
        [FORK_MIGRATION_HISTORY_TOMBSTONES[0].sha256],
        filesByHash,
      ),
    ).toEqual([]);
  });
});
