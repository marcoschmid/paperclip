import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentInstructionsService } from "../services/agent-instructions.js";

type TestAgent = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};

async function makeTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeAgent(adapterConfig: Record<string, unknown>): TestAgent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent 1",
    adapterConfig,
  };
}

function permissionBits(mode: number) {
  return mode & 0o777;
}

describe("agent instructions service", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("copies the existing bundle into the managed root when switching to managed mode", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-home-");
    const externalRoot = await makeTempDir("paperclip-agent-instructions-external-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(externalRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "# External Agent\n", "utf8");
    await fs.mkdir(path.join(externalRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });

    const result = await svc.updateBundle(agent, { mode: "managed" });

    expect(result.bundle.mode).toBe("managed");
    expect(result.bundle.managedRootPath).toBe(
      path.join(
        paperclipHome,
        "instances",
        "test-instance",
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "instructions",
      ),
    );
    expect(result.bundle.files.map((file) => file.path)).toEqual(["AGENTS.md", "docs/TOOLS.md"]);
    await expect(fs.readFile(path.join(result.bundle.managedRootPath, "AGENTS.md"), "utf8")).resolves.toBe("# External Agent\n");
    await expect(fs.readFile(path.join(result.bundle.managedRootPath, "docs", "TOOLS.md"), "utf8")).resolves.toBe("## Tools\n");
    expect(permissionBits((await fs.stat(result.bundle.managedRootPath)).mode)).toBe(0o700);
    expect(permissionBits((await fs.stat(path.join(result.bundle.managedRootPath, "docs"))).mode)).toBe(0o700);
    expect(permissionBits((await fs.stat(path.join(result.bundle.managedRootPath, "AGENTS.md"))).mode)).toBe(0o600);
    expect(permissionBits((await fs.stat(path.join(result.bundle.managedRootPath, "docs", "TOOLS.md"))).mode)).toBe(0o600);
  });

  it("creates the target entry file when switching to a new external root", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-home-");
    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    const externalRoot = await makeTempDir("paperclip-agent-instructions-new-external-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(externalRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });

    const result = await svc.updateBundle(agent, {
      mode: "external",
      rootPath: externalRoot,
      entryFile: "docs/AGENTS.md",
    });

    expect(result.bundle.mode).toBe("external");
    expect(result.bundle.rootPath).toBe(externalRoot);
    await expect(fs.readFile(path.join(externalRoot, "docs", "AGENTS.md"), "utf8")).resolves.toBe("# Managed Agent\n");
  });

  it("filters junk files, dependency bundles, and python caches from bundle listings and exports", async () => {
    const externalRoot = await makeTempDir("paperclip-agent-instructions-ignore-");
    cleanupDirs.add(externalRoot);

    await fs.writeFile(path.join(externalRoot, "AGENTS.md"), "# External Agent\n", "utf8");
    await fs.writeFile(path.join(externalRoot, ".gitignore"), "node_modules/\n", "utf8");
    await fs.writeFile(path.join(externalRoot, ".DS_Store"), "junk", "utf8");
    await fs.mkdir(path.join(externalRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");
    await fs.writeFile(path.join(externalRoot, "docs", "module.pyc"), "compiled", "utf8");
    await fs.writeFile(path.join(externalRoot, "docs", "._TOOLS.md"), "appledouble", "utf8");
    await fs.mkdir(path.join(externalRoot, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, "node_modules", "pkg", "index.js"), "export {};\n", "utf8");
    await fs.mkdir(path.join(externalRoot, "python", "__pycache__"), { recursive: true });
    await fs.writeFile(
      path.join(externalRoot, "python", "__pycache__", "module.cpython-313.pyc"),
      "compiled",
      "utf8",
    );
    await fs.mkdir(path.join(externalRoot, ".pytest_cache"), { recursive: true });
    await fs.writeFile(path.join(externalRoot, ".pytest_cache", "README.md"), "cache", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: externalRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(externalRoot, "AGENTS.md"),
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.files.map((file) => file.path)).toEqual([".gitignore", "AGENTS.md", "docs/TOOLS.md"]);
    expect(Object.keys(exported.files).sort((left, right) => left.localeCompare(right))).toEqual([
      ".gitignore",
      "AGENTS.md",
      "docs/TOOLS.md",
    ]);
  });

  it("recovers a managed bundle from disk when bundle config metadata is missing", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-recover-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Recovered Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({});

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Recovered Agent\n" });
    expect(permissionBits((await fs.stat(managedRoot)).mode)).toBe(0o700);
    expect(permissionBits((await fs.stat(path.join(managedRoot, "AGENTS.md"))).mode)).toBe(0o600);
  });

  it("never hardens a stale configured root outside the canonical managed root", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-safe-harden-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-safe-harden-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const staleEntry = path.join(staleRoot, "AGENTS.md");
    await fs.writeFile(staleEntry, "# External content\n", { mode: 0o644 });
    await fs.chmod(staleRoot, 0o755);
    await fs.chmod(staleEntry, 0o644);

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: staleEntry,
    });

    await svc.getBundle(agent);

    expect(permissionBits((await fs.stat(staleRoot)).mode)).toBe(0o755);
    expect(permissionBits((await fs.stat(staleEntry)).mode)).toBe(0o644);
  });

  it.each(["missing", "empty"])(
    "heals a stale managed root into the canonical %s root before writes or deletes",
    async (canonicalState) => {
      const paperclipHome = await makeTempDir(`paperclip-agent-instructions-safe-write-${canonicalState}-`);
      const staleRoot = await makeTempDir(`paperclip-agent-instructions-safe-write-${canonicalState}-stale-`);
      cleanupDirs.add(paperclipHome);
      cleanupDirs.add(staleRoot);
      process.env.PAPERCLIP_HOME = paperclipHome;
      process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

      const managedRoot = path.join(
        paperclipHome,
        "instances",
        "test-instance",
        "companies",
        "company-1",
        "agents",
        "agent-1",
        "instructions",
      );
      if (canonicalState === "empty") await fs.mkdir(managedRoot, { recursive: true });
      const staleEntry = path.join(staleRoot, "AGENTS.md");
      const staleDeleteTarget = path.join(staleRoot, "obsolete.md");
      await fs.writeFile(staleEntry, "# Stale managed content\n", { mode: 0o644 });
      await fs.writeFile(staleDeleteTarget, "keep external\n", { mode: 0o644 });
      await fs.chmod(staleRoot, 0o755);

      const svc = agentInstructionsService();
      const agent = makeAgent({
        instructionsBundleMode: "managed",
        instructionsRootPath: staleRoot,
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: staleEntry,
      });

      const written = await svc.writeFile(agent, "docs/TOOLS.md", "## Canonical tools\n");
      const healedAgent = { ...agent, adapterConfig: written.adapterConfig };
      await fs.writeFile(path.join(managedRoot, "obsolete.md"), "delete canonical\n", { mode: 0o600 });
      await svc.deleteFile(healedAgent, "obsolete.md");

      await expect(fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8"))
        .resolves.toBe("# Stale managed content\n");
      await expect(fs.readFile(path.join(managedRoot, "docs", "TOOLS.md"), "utf8"))
        .resolves.toBe("## Canonical tools\n");
      await expect(fs.stat(path.join(managedRoot, "obsolete.md"))).rejects.toThrow();
      await expect(fs.readFile(staleDeleteTarget, "utf8")).resolves.toBe("keep external\n");
      expect(permissionBits((await fs.stat(staleRoot)).mode)).toBe(0o755);
      expect(permissionBits((await fs.stat(staleEntry)).mode)).toBe(0o644);
      expect(written.adapterConfig).toMatchObject({
        instructionsBundleMode: "managed",
        instructionsRootPath: managedRoot,
        instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
      });
    },
  );

  it("prefers the managed bundle on disk when managed metadata points at a stale root", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-stale-managed-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-stale-root-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
      "Recovered managed instructions entry file from disk as AGENTS.md; previous entry docs/MISSING.md was missing.",
    ]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Managed Agent\n" });
  });

  it("heals stale managed metadata when writing bundle files", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-heal-write-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-heal-write-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(path.join(managedRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const result = await svc.writeFile(agent, "docs/TOOLS.md", "## Tools\n");

    expect(result.adapterConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });
    await expect(fs.readFile(path.join(managedRoot, "docs", "TOOLS.md"), "utf8")).resolves.toBe("## Tools\n");
    expect(permissionBits((await fs.stat(path.join(managedRoot, "docs", "TOOLS.md"))).mode)).toBe(0o600);
  });

  it("heals stale managed metadata when deleting bundle files", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-heal-delete-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-heal-delete-stale-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(path.join(managedRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");
    await fs.writeFile(path.join(managedRoot, "docs", "TOOLS.md"), "## Tools\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    });

    const result = await svc.deleteFile(agent, "docs/TOOLS.md");

    expect(result.adapterConfig).toMatchObject({
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    });
    await expect(fs.stat(path.join(managedRoot, "docs", "TOOLS.md"))).rejects.toThrow();
    expect(result.bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
  });

  it("recovers the managed bundle when stale root metadata is present but mode is missing", async () => {
    const paperclipHome = await makeTempDir("paperclip-agent-instructions-partial-managed-");
    const staleRoot = await makeTempDir("paperclip-agent-instructions-partial-root-");
    cleanupDirs.add(paperclipHome);
    cleanupDirs.add(staleRoot);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Managed Agent\n", "utf8");

    const svc = agentInstructionsService();
    const agent = makeAgent({
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
    });

    const bundle = await svc.getBundle(agent);
    const exported = await svc.exportFiles(agent);

    expect(bundle.mode).toBe("managed");
    expect(bundle.rootPath).toBe(managedRoot);
    expect(bundle.entryFile).toBe("AGENTS.md");
    expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md"]);
    expect(bundle.warnings).toEqual([
      `Recovered managed instructions from disk at ${managedRoot}; ignoring stale configured root ${staleRoot}.`,
      "Recovered managed instructions entry file from disk as AGENTS.md; previous entry docs/MISSING.md was missing.",
    ]);
    expect(exported.files).toEqual({ "AGENTS.md": "# Managed Agent\n" });
  });
});
