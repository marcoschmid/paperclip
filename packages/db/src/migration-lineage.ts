export const FORK_MIGRATION_LINEAGE = [
  {
    legacyFile: "0137_agent_portfolio_maintenance_gates.sql",
    canonicalFile: "9001_agent_portfolio_maintenance_gates.sql",
    sha256: "55abbde4d01b3c429fad5cfab45e2043b868230e74ea8fc18dc4c48c362c69f7",
  },
  {
    legacyFile: "0138_approval_execution_claims.sql",
    canonicalFile: "9002_approval_execution_claims.sql",
    sha256: "2d4d42bd7f88d514ec199c3290a2c7fff4c459181fb306ee61223a0263d41bb1",
  },
  {
    legacyFile: "0139_heartbeat_process_identity.sql",
    canonicalFile: "9003_heartbeat_process_identity.sql",
    sha256: "5903e3ca1104722f89bc6a49e8aa455ac432bb213997e13aad662eac4d5d89a3",
  },
  {
    legacyFile: "0140_agent_retirement_claims.sql",
    canonicalFile: "9004_agent_retirement_claims.sql",
    sha256: "48d8b959a1ef1a51bc8785e3755a6031fcab499d9234855871d23cbdd4275779",
  },
  {
    legacyFile: "0141_agent_retirement_private_evidence.sql",
    canonicalFile: "9005_agent_retirement_private_evidence.sql",
    sha256: "56d0f6a8a45d27d4f8ea5aa5dba9ed0732e70e538e6e2ced7b6264aa1397f80c",
  },
  {
    legacyFile: "0142_failed_canary_wake_terminalization.sql",
    canonicalFile: "9006_failed_canary_wake_terminalization.sql",
    sha256: "2359f2f916b5c4a9545d5aeb7f6c8df3d6eab37bf19e2dd4eb7c5206f4db6ac8",
  },
  {
    legacyFile: "0143_approval_execution_claim_lifecycle.sql",
    canonicalFile: "9007_approval_execution_claim_lifecycle.sql",
    sha256: "4f02ec9c415fdd3f10c741b29dffef8866eecfa9b39028bb6ed1cfa694ff54d1",
  },
  {
    legacyFile: "0144_workspace_runtime_start_claims.sql",
    canonicalFile: "9008_workspace_runtime_start_claims.sql",
    sha256: "da1549f9094c68ff93f1f67ff45492d71cacc0e6982684b62f11972abb834b94",
  },
  {
    legacyFile: "0145_routine_run_deliveries.sql",
    canonicalFile: "9009_routine_run_deliveries.sql",
    sha256: "af06c2199b1b06df72fbff4a22495582055b7e43e5d069885bb8750966f5f557",
  },
  {
    legacyFile: "0146_historical_agent_tombstone_access_cleanup.sql",
    canonicalFile: "9010_historical_agent_tombstone_access_cleanup.sql",
    sha256: "dbe70aec23c52b1000318433b25bd1fa965729b7d3f10f6275b55bf75475c746",
  },
  {
    legacyFile: "0147_heartbeat_runs_agent_index.sql",
    canonicalFile: "9011_heartbeat_runs_agent_index.sql",
    sha256: "02d7e51933fd8e007295dbc1c12a463ed80ebd6644ac998c2884d9417b9dfa83",
  },
] as const;

export const FORK_MIGRATION_HISTORY_TOMBSTONES = [
  {
    historicalFile: "0058_chilly_shriek.sql",
    sha256: "78a2291b0688875e442f1195d98f4d3b340029431746e1c272b570f5c9bb760d",
    createdAt: 1777526846427,
  },
  {
    historicalFile: "0059_add_agent_executor.sql",
    sha256: "08a4efacbbd958b39ae68414a2f9893a350ca28050e210af3f73a11603692da2",
    createdAt: 1777648572662,
  },
  {
    historicalFile: "0060_add_issue_runs.sql",
    sha256: "b5aa0710ecc2f6f31bcf36ce1db9cd059454ddce140a28e53a11338b32a6c6be",
    createdAt: 1777649099144,
  },
  {
    historicalFile: "0061_add_project_documents.sql",
    sha256: "f4906181f9de0d4fa70184f190fd729331f2cc524e713a624730805176dca5f8",
    createdAt: 1777649385341,
  },
  {
    historicalFile: "0062_add_decisions.sql",
    sha256: "8154ed706638401b18810345b88d2781646d9899a7f9beea83e3a4567aa86305",
    createdAt: 1777649836644,
  },
  {
    historicalFile: "0075_native_cost_engine.sql",
    sha256: "85e25c8633c90a311aad7712435a3e7a60d95e61b860ca016deedda66d472564",
    createdAt: 1777999200000,
  },
  {
    historicalFile: "0090_phase6_memory_tables.sql",
    sha256: "c63eaee500f6fbf34e93174ad85838a3ea8f481af3470464b9e013597a31e09a",
    createdAt: 1779532800000,
  },
  {
    historicalFile: "0098_phase6_memory_tables.sql",
    sha256: "48712c923488a33d1718540a52ab9a122d23601090008b04f262fb28bf2eb413",
    createdAt: 1780551600000,
  },
  {
    historicalFile: "0140_agent_retirement_claims.pre_pin.sql",
    sha256: "9103550d587fdf5d58a43016f6144480de33b18e6f9671500a49fa4e2f93ef97",
    createdAt: 1783965600000,
  },
  {
    historicalFile: "0136_phase6_memory_tables.sql",
    sha256: "c3f263f82587d20cbac45991c27e68b069eb0f2151e098274568158234843e3c",
    createdAt: 1783034621000,
  },
] as const;

type ForkMigrationLineageEntry = (typeof FORK_MIGRATION_LINEAGE)[number];

const lineageByFileName: ReadonlyMap<string, ForkMigrationLineageEntry> = new Map(
  FORK_MIGRATION_LINEAGE.flatMap((entry) => [
    [entry.legacyFile, entry] as const,
    [entry.canonicalFile, entry] as const,
  ]),
);

const migrationHistoryTombstoneHashes: ReadonlySet<string> = new Set(
  FORK_MIGRATION_HISTORY_TOMBSTONES.map((entry) => entry.sha256),
);

export function validateForkMigrationLineage(
  migrationHashesByFile: ReadonlyMap<string, string>,
): Map<string, string> {
  const canonicalFileByHash = new Map<string, string>();

  for (const entry of FORK_MIGRATION_LINEAGE) {
    const hasLegacy = migrationHashesByFile.has(entry.legacyFile);
    const hasCanonical = migrationHashesByFile.has(entry.canonicalFile);
    if (hasLegacy && hasCanonical) {
      throw new Error(
        `Fork migration lineage contains both ${entry.legacyFile} and ${entry.canonicalFile}`,
      );
    }
    if (!hasLegacy && !hasCanonical) {
      throw new Error(
        `Fork migration lineage is missing ${entry.legacyFile} or ${entry.canonicalFile}`,
      );
    }

    const selectedFile = hasCanonical ? entry.canonicalFile : entry.legacyFile;
    const actualHash = migrationHashesByFile.get(selectedFile);
    if (actualHash !== entry.sha256) {
      throw new Error(`Fork migration hash mismatch for ${selectedFile}`);
    }
    if (canonicalFileByHash.has(entry.sha256)) {
      throw new Error(`Fork migration lineage contains duplicate pinned hash ${entry.sha256}`);
    }
    canonicalFileByHash.set(entry.sha256, selectedFile);
  }

  return canonicalFileByHash;
}

export function resolveMigrationHistoryFileName(
  migrationFile: string,
  availableMigrations: ReadonlySet<string>,
): string {
  const lineage = lineageByFileName.get(migrationFile);
  if (!lineage) return migrationFile;
  if (availableMigrations.has(lineage.canonicalFile)) return lineage.canonicalFile;
  return migrationFile;
}

export function migrationHistoryNamesForFile(migrationFile: string): string[] {
  const lineage = lineageByFileName.get(migrationFile);
  return lineage
    ? [lineage.canonicalFile, lineage.legacyFile]
    : [migrationFile];
}

export function resolveMigrationHistoryHashes(
  historyHashes: readonly string[],
  migrationFilesByHash: ReadonlyMap<string, string>,
): string[] {
  const unknownHashCount = historyHashes.filter(
    (hash) =>
      !migrationFilesByHash.has(hash) &&
      !migrationHistoryTombstoneHashes.has(hash),
  ).length;
  if (unknownHashCount > 0) {
    throw new Error(
      `Migration history contains ${unknownHashCount} unknown hash(es); refusing unsafe inference`,
    );
  }
  return historyHashes
    .map((hash) => migrationFilesByHash.get(hash))
    .filter((migrationFile): migrationFile is string => Boolean(migrationFile));
}
