import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getLocalEncryptedMasterKeyProof,
  localEncryptedProvider,
} from "../secrets/local-encrypted-provider.js";

describe.sequential("local-encrypted master-key first write", () => {
  const previousFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousInline = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  let root = "";
  let keyPath = "";

  beforeEach(() => {
    root = path.join(os.tmpdir(), `paperclip-master-key-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    keyPath = path.join(root, "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyPath;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  });

  afterEach(() => {
    if (previousFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousFile;
    if (previousInline === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousInline;
    rmSync(root, { recursive: true, force: true });
  });

  it("creates one fsynced 0600 key through the lock/wx/temp/rename path without active leftovers", async () => {
    await localEncryptedProvider.createSecret({ value: "bounded-test-value" });
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const decoded = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    expect(decoded).toHaveLength(32);
    expect(getLocalEncryptedMasterKeyProof()).toEqual({
      fingerprintSha256: createHash("sha256").update(decoded).digest("hex"),
    });
    expect(readdirSync(root)).toEqual(["master.key"]);
  });

  it("fails closed on a competing first-write lock and never creates or replaces the key", async () => {
    writeFileSync(`${keyPath}.lock`, "competing-writer\n", { mode: 0o600, flag: "wx" });
    await expect(localEncryptedProvider.createSecret({ value: "must-not-write" }))
      .rejects.toThrow(/first-write lock|acquire.*lock/i);
    expect(() => statSync(keyPath)).toThrow();
    expect(readFileSync(`${keyPath}.lock`, "utf8")).toBe("competing-writer\n");
  });
});
