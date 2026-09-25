import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRetirementBackupRoot } from "../services/agent-retirement.js";

describe("agent retirement backup root", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function tempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-retirement-backup-root-"));
    roots.push(root);
    return root;
  }

  it("resolves a backup directory that was relocated behind a symlink", () => {
    const root = tempRoot();
    const relocated = path.join(root, "external", "backups");
    fs.mkdirSync(relocated, { recursive: true, mode: 0o700 });
    const configured = path.join(root, "backups");
    fs.symlinkSync(relocated, configured);

    expect(resolveRetirementBackupRoot(configured)).toBe(fs.realpathSync(relocated));
  });

  it("keeps an exact directory and leaves a missing path to the fail-closed artifact checks", () => {
    const root = tempRoot();
    const exact = path.join(root, "backups");
    fs.mkdirSync(exact, { mode: 0o700 });
    const missing = path.join(root, "missing");

    expect(resolveRetirementBackupRoot(exact)).toBe(fs.realpathSync(exact));
    expect(resolveRetirementBackupRoot(missing)).toBe(missing);
  });
});
