import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexHomeHasUsableAuth,
  ensureSymlink,
  evaluateCodexCredentialReadiness,
  isManagedCodexHomePath,
  prepareManagedCodexHome,
  reconcileManagedCodexHome,
  resolveManagedCodexHomeDir,
  seedManagedCodexHome,
} from "./codex-home.js";

describe("codex managed home", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a concurrently-created expected auth symlink as success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (source, target, type) => {
      await originalSymlink(source, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).resolves.toBe(managedCodexHome);

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("still throws on EEXIST when a raced-in auth symlink points elsewhere", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const wrongAuth = path.join(sharedCodexHome, "other-auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");
    await fs.writeFile(wrongAuth, '{"token":"other"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (_source, target, type) => {
      await originalSymlink(wrongAuth, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(managedAuth)).toBe(wrongAuth);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Regression for #5028: older Paperclip versions copied auth.json into the
  // managed home instead of symlinking. After upgrading to the symlink-based
  // logic, the stale regular file at the target stayed in place and every
  // subsequent codex_local run failed with refresh_token_reused as soon as the
  // source token rotated. `ensureSymlink` now heals the upgrade path by
  // unlinking the stale copy and creating a symlink to the live source.
  it("replaces a stale regular-file auth.json with a symlink to the live source (#5028)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const paperclipHome = path.join(root, "paperclip-home");
      const managedCodexHome = path.join(
        paperclipHome,
        "instances",
        "default",
        "companies",
        "company-1",
        "codex-home",
      );
      const sharedAuth = path.join(sharedCodexHome, "auth.json");
      const managedAuth = path.join(managedCodexHome, "auth.json");

      await fs.mkdir(sharedCodexHome, { recursive: true });
      // The live source has rotated since the stale copy was written.
      await fs.writeFile(sharedAuth, '{"token":"fresh"}', "utf8");

      // Simulate a stale copy left by a previous Paperclip version.
      await fs.mkdir(managedCodexHome, { recursive: true });
      await fs.writeFile(managedAuth, '{"token":"stale-from-copy"}', "utf8");

      await prepareManagedCodexHome(
        {
          CODEX_HOME: sharedCodexHome,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
        },
        async () => {},
        "company-1",
      );

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(managedAuth, "utf8")).toBe('{"token":"fresh"}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Direct unit coverage for the new ensureSymlink branch (#5028). The
  // regression test above goes through prepareManagedCodexHome, whose
  // pre-existing apikey-mode cleanup `fs.rm`s the stale auth.json before
  // ensureSymlink runs — so the heal branch never executes there. Call
  // ensureSymlink directly to prove the unlink-and-recreate path itself.
  it("ensureSymlink: unlinks a stale regular file and recreates the symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ensure-symlink-"));
    try {
      const source = path.join(root, "live-source.json");
      const target = path.join(root, "stale-target.json");
      await fs.writeFile(source, '{"token":"fresh"}', "utf8");
      await fs.writeFile(target, '{"token":"stale-from-copy"}', "utf8");

      await ensureSymlink(target, source);

      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe('{"token":"fresh"}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // The isDirectory() guard added with the heal branch must keep an unexpected
  // directory in place rather than throwing EISDIR. We treat a directory at
  // this path as operator-owned, not a stale Paperclip copy.
  it("ensureSymlink: leaves an unexpected directory in place instead of throwing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ensure-symlink-dir-"));
    try {
      const source = path.join(root, "live-source.json");
      const target = path.join(root, "unexpected-dir");
      await fs.writeFile(source, '{"token":"fresh"}', "utf8");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "sentinel"), "keep-me", "utf8");

      await expect(ensureSymlink(target, source)).resolves.toBeUndefined();

      expect((await fs.lstat(target)).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(target, "sentinel"), "utf8")).toBe("keep-me");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

});

describe("isManagedCodexHomePath", () => {
  const env = {
    PAPERCLIP_HOME: "/srv/paperclip",
    PAPERCLIP_INSTANCE_ID: "default",
  } satisfies NodeJS.ProcessEnv;
  const companyRoot = path.resolve(
    "/srv/paperclip/instances/default/companies/company-1",
  );

  it("treats the per-agent managed home as managed", () => {
    expect(
      isManagedCodexHomePath(
        env,
        "company-1",
        path.join(companyRoot, "agents", "agent-7", "codex-home"),
      ),
    ).toBe(true);
  });

  it("treats the shared company home as managed", () => {
    expect(
      isManagedCodexHomePath(env, "company-1", path.join(companyRoot, "codex-home")),
    ).toBe(true);
  });

  it("treats a path outside the company tree as an external override", () => {
    expect(isManagedCodexHomePath(env, "company-1", "/home/dev/.codex")).toBe(false);
    expect(
      isManagedCodexHomePath(
        env,
        "company-1",
        path.resolve("/srv/paperclip/instances/default/companies/company-2/codex-home"),
      ),
    ).toBe(false);
  });

  it("returns false without a companyId", () => {
    expect(isManagedCodexHomePath(env, undefined, path.join(companyRoot, "codex-home"))).toBe(
      false,
    );
  });
});

describe("resolveManagedCodexHomeDir", () => {
  it("returns stable, distinct managed homes for two agents in the same company", () => {
    const env = {
      PAPERCLIP_HOME: "/srv/paperclip",
      PAPERCLIP_INSTANCE_ID: "default",
    } satisfies NodeJS.ProcessEnv;

    const first = resolveManagedCodexHomeDir(env, "company-1", "agent-1");
    const second = resolveManagedCodexHomeDir(env, "company-1", "agent-2");

    expect(first).toBe(path.resolve(
      "/srv/paperclip/instances/default/companies/company-1/agents/agent-1/codex-home",
    ));
    expect(second).toBe(path.resolve(
      "/srv/paperclip/instances/default/companies/company-1/agents/agent-2/codex-home",
    ));
    expect(resolveManagedCodexHomeDir(env, "company-1", "agent-1")).toBe(first);
    expect(second).not.toBe(first);
  });

  it.each([
    ["company traversal", "../company-2", "agent-1"],
    ["agent traversal", "company-1", "../agent-2"],
    ["absolute company", "/tmp/company-1", "agent-1"],
    ["absolute agent", "company-1", "/tmp/agent-1"],
    ["nested company", "company-1/child", "agent-1"],
    ["nested agent", "company-1", "agent-1/child"],
  ])("rejects unsafe %s path components", (_name, companyId, agentId) => {
    const env = {
      PAPERCLIP_HOME: "/srv/paperclip",
      PAPERCLIP_INSTANCE_ID: "default",
    } satisfies NodeJS.ProcessEnv;

    expect(() => resolveManagedCodexHomeDir(env, companyId, agentId)).toThrow(
      /safe single path component/,
    );
  });
});

describe("managed home path containment", () => {
  it.each(["companies", "company-root"])(
    "rejects a symlinked managed %s ancestor outside the instance root",
    async (symlinkAt) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-ancestor-"));
      try {
        const sharedCodexHome = path.join(root, "shared-codex-home");
        const paperclipHome = path.join(root, "paperclip-home");
        const instanceRoot = path.join(paperclipHome, "instances", "default");
        const companiesRoot = path.join(instanceRoot, "companies");
        const outside = path.join(root, "outside");
        await fs.mkdir(sharedCodexHome, { recursive: true });
        await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}', "utf8");
        await fs.mkdir(instanceRoot, { recursive: true });
        await fs.mkdir(outside, { recursive: true, mode: 0o755 });
        if (symlinkAt === "companies") {
          await fs.symlink(outside, companiesRoot);
        } else {
          await fs.mkdir(companiesRoot, { recursive: true });
          await fs.symlink(outside, path.join(companiesRoot, "company-1"));
        }

        await expect(
          prepareManagedCodexHome(
            {
              CODEX_HOME: sharedCodexHome,
              PAPERCLIP_HOME: paperclipHome,
              PAPERCLIP_INSTANCE_ID: "default",
            },
            async () => {},
            "company-1",
            { agentId: "agent-1" },
          ),
        ).rejects.toThrow(/symbolic link|instance root/);
        await expect(fs.readdir(outside)).resolves.toEqual([]);
        expect((await fs.stat(outside)).mode & 0o777).toBe(0o755);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["agents", "codex-home"])(
    "rejects a symlinked managed %s descendant before auth or chmod operations",
    async (symlinkAt) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-containment-"));
      try {
        const sharedCodexHome = path.join(root, "shared-codex-home");
        const paperclipHome = path.join(root, "paperclip-home");
        const companyRoot = path.join(
          paperclipHome,
          "instances",
          "default",
          "companies",
          "company-1",
        );
        const outside = path.join(root, "outside");
        await fs.mkdir(sharedCodexHome, { recursive: true });
        await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}', "utf8");
        await fs.mkdir(outside, { recursive: true, mode: 0o755 });
        if (symlinkAt === "agents") {
          await fs.mkdir(companyRoot, { recursive: true });
          await fs.symlink(outside, path.join(companyRoot, "agents"));
        } else {
          const agentRoot = path.join(companyRoot, "agents", "agent-1");
          await fs.mkdir(agentRoot, { recursive: true });
          await fs.symlink(outside, path.join(agentRoot, "codex-home"));
        }

        await expect(
          prepareManagedCodexHome(
            {
              CODEX_HOME: sharedCodexHome,
              PAPERCLIP_HOME: paperclipHome,
              PAPERCLIP_INSTANCE_ID: "default",
            },
            async () => {},
            "company-1",
            { agentId: "agent-1" },
          ),
        ).rejects.toThrow(/symbolic link/);
        await expect(fs.readdir(outside)).resolves.toEqual([]);
        expect((await fs.stat(outside)).mode & 0o777).toBe(0o755);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("codexHomeHasUsableAuth", () => {
  it("is true for credential-bearing auth.json and false when missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-"));
    try {
      expect(await codexHomeHasUsableAuth(root)).toBe(false);
      await fs.writeFile(path.join(root, "auth.json"), "{}", "utf8");
      expect(await codexHomeHasUsableAuth(root)).toBe(false);
      await fs.writeFile(path.join(root, "auth.json"), '{"foo":"bar"}', "utf8");
      expect(await codexHomeHasUsableAuth(root)).toBe(false);
      await fs.writeFile(path.join(root, "auth.json"), '{"token":"shared"}', "utf8");
      expect(await codexHomeHasUsableAuth(root)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("is false for a dangling auth.json symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-dangling-"));
    try {
      await fs.symlink(path.join(root, "missing-source.json"), path.join(root, "auth.json"));
      expect(await codexHomeHasUsableAuth(root)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("seedManagedCodexHome", () => {
  it("symlinks auth.json from the shared source into an explicit per-agent home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-seed-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const agentHome = path.join(
        root,
        "instances",
        "default",
        "companies",
        "company-1",
        "agents",
        "agent-7",
        "codex-home",
      );
      const sharedAuth = path.join(sharedCodexHome, "auth.json");
      const agentAuth = path.join(agentHome, "auth.json");

      await fs.mkdir(sharedCodexHome, { recursive: true });
      await fs.writeFile(sharedAuth, '{"token":"shared"}', "utf8");

      await seedManagedCodexHome(agentHome, { CODEX_HOME: sharedCodexHome }, async () => {});

      expect((await fs.lstat(agentAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(agentAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("writes an API-key auth.json into the home when an apiKey is supplied", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-seed-apikey-"));
    try {
      const agentHome = path.join(root, "agent-home");
      const emptyShared = path.join(root, "empty-shared");
      await fs.mkdir(emptyShared, { recursive: true });
      await seedManagedCodexHome(agentHome, { CODEX_HOME: emptyShared }, async () => {}, {
        apiKey: "sk-test-123",
      });

      const written = JSON.parse(await fs.readFile(path.join(agentHome, "auth.json"), "utf8"));
      expect(written).toEqual({ OPENAI_API_KEY: "sk-test-123" });
      expect((await fs.stat(agentHome)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(agentHome, "auth.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not inherit shared profile config, instructions, plugins, hooks, or session state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-minimal-seed-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const agentHome = path.join(root, "agent-home");
      await fs.mkdir(path.join(sharedCodexHome, "plugins"), { recursive: true });
      await fs.mkdir(path.join(sharedCodexHome, "hooks"), { recursive: true });
      await fs.mkdir(path.join(sharedCodexHome, "sessions"), { recursive: true });
      await Promise.all([
        fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}', "utf8"),
        fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "host-model"\n', "utf8"),
        fs.writeFile(path.join(sharedCodexHome, "config.json"), '{"mcp_servers":{"host":{}}}', "utf8"),
        fs.writeFile(path.join(sharedCodexHome, "instructions.md"), "Host instructions\n", "utf8"),
        fs.writeFile(path.join(sharedCodexHome, "plugins", "host-plugin.json"), "{}", "utf8"),
        fs.writeFile(path.join(sharedCodexHome, "hooks", "host-hook.sh"), "exit 0\n", "utf8"),
        fs.writeFile(path.join(sharedCodexHome, "sessions", "host-session.json"), "{}", "utf8"),
      ]);

      await seedManagedCodexHome(agentHome, { CODEX_HOME: sharedCodexHome }, async () => {});

      expect((await fs.lstat(path.join(agentHome, "auth.json"))).isSymbolicLink()).toBe(true);
      await expect(fs.readdir(agentHome)).resolves.toEqual(["auth.json"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["wrong", "dangling"])(
    "removes a %s managed subscription auth symlink when current shared auth is missing",
    async (kind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stale-auth-"));
      try {
        const sharedCodexHome = path.join(root, "shared-codex-home");
        const agentHome = path.join(root, "agent-home");
        const wrongAuth = path.join(root, "wrong-auth.json");
        await fs.mkdir(sharedCodexHome, { recursive: true });
        await fs.mkdir(agentHome, { recursive: true });
        await fs.writeFile(wrongAuth, '{"token":"other"}', "utf8");
        const source = kind === "wrong"
          ? wrongAuth
          : path.join(sharedCodexHome, "auth.json");
        await fs.symlink(source, path.join(agentHome, "auth.json"));

        await seedManagedCodexHome(agentHome, { CODEX_HOME: sharedCodexHome }, async () => {});

        await expect(fs.lstat(path.join(agentHome, "auth.json"))).rejects.toThrow();
        await expect(fs.readFile(wrongAuth, "utf8")).resolves.toBe('{"token":"other"}');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("managed home legacy profile migration", () => {
  it("quarantines inherited profile files before managed runtime generation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-upgrade-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const paperclipHome = path.join(root, "paperclip-home");
      const agentRoot = path.join(
        paperclipHome,
        "instances",
        "default",
        "companies",
        "company-1",
        "agents",
        "agent-1",
      );
      const agentHome = path.join(agentRoot, "codex-home");
      const quarantine = path.join(agentRoot, "codex-home-legacy-profile");
      await fs.mkdir(sharedCodexHome, { recursive: true });
      await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"token":"shared"}', "utf8");
      await fs.mkdir(agentHome, { recursive: true, mode: 0o755 });
      for (const name of [
        "config.toml",
        "config.json",
        "instructions.md",
        "config.toml.paperclip-backup",
      ]) {
        await fs.writeFile(path.join(agentHome, name), `legacy:${name}\n`, { mode: 0o644 });
      }

      await prepareManagedCodexHome(
        {
          CODEX_HOME: sharedCodexHome,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
        },
        async () => {},
        "company-1",
        { agentId: "agent-1" },
      );

      await expect(fs.readdir(agentHome)).resolves.toEqual(["auth.json"]);
      await expect(fs.readdir(quarantine)).resolves.toEqual([
        "config.json",
        "config.toml",
        "config.toml.paperclip-backup",
        "instructions.md",
      ]);
      expect((await fs.stat(quarantine)).mode & 0o777).toBe(0o700);
      for (const name of await fs.readdir(quarantine)) {
        expect((await fs.stat(path.join(quarantine, name))).mode & 0o777).toBe(0o600);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// Startup backfill for already-isolated managed homes.
describe("reconcileManagedCodexHome", () => {
  async function makeFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-reconcile-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const agentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-7",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const agentAuth = path.join(agentHome, "auth.json");
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"token":"shared"}', "utf8");
    const env = {
      CODEX_HOME: sharedCodexHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "default",
    } satisfies NodeJS.ProcessEnv;
    return { root, sharedCodexHome, sharedAuth, agentHome, agentAuth, env };
  }

  it("seeds a previously-stranded managed home and is a no-op on re-run", async () => {
    const fx = await makeFixture();
    try {
      // The isolation guard created the per-agent home with no auth.json.
      expect(await codexHomeHasUsableAuth(fx.agentHome)).toBe(false);

      const first = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        env: fx.env,
      });
      expect(first.status).toBe("seeded");
      expect(first.home).toBe(fx.agentHome);
      expect((await fs.lstat(fx.agentAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(fx.agentAuth)).toBe(await fs.realpath(fx.sharedAuth));

      const second = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        env: fx.env,
      });
      expect(second.status).toBe("already_seeded");
      expect((await fs.lstat(fx.agentAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(fx.agentAuth)).toBe(await fs.realpath(fx.sharedAuth));
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("reports source_auth_missing when shared auth is unavailable", async () => {
    const fx = await makeFixture();
    try {
      await fs.rm(fx.sharedAuth, { force: true });

      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        env: fx.env,
      });

      expect(result.status).toBe("source_auth_missing");
      await expect(fs.lstat(fx.agentAuth)).rejects.toThrow();
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("leaves a genuine external override untouched", async () => {
    const fx = await makeFixture();
    try {
      const external = path.join(fx.root, "user-codex");
      await fs.mkdir(external, { recursive: true });

      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: external,
        env: fx.env,
      });
      expect(result.status).toBe("external_override");
      expect(await codexHomeHasUsableAuth(external)).toBe(false);
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("reports no_managed_home when no CODEX_HOME is configured", async () => {
    const fx = await makeFixture();
    try {
      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: null,
        env: fx.env,
      });
      expect(result).toEqual({ status: "no_managed_home", home: null });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("preserves an existing API-key auth.json when the key is secret-bound", async () => {
    const fx = await makeFixture();
    try {
      // A prior execute-time run resolved the secret and wrote a regular-file
      // auth.json containing the key.
      await fs.mkdir(fx.agentHome, { recursive: true });
      await fs.writeFile(
        fx.agentAuth,
        JSON.stringify({ OPENAI_API_KEY: "sk-secret-resolved" }),
        { mode: 0o644 },
      );
      await fs.chmod(fx.agentAuth, 0o644);

      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        apiKeySecretBound: true,
        env: fx.env,
      });

      expect(result.status).toBe("already_seeded");
      expect((await fs.lstat(fx.agentAuth)).isSymbolicLink()).toBe(false);
      expect(JSON.parse(await fs.readFile(fx.agentAuth, "utf8"))).toEqual({
        OPENAI_API_KEY: "sk-secret-resolved",
      });
      expect((await fs.stat(fx.agentAuth)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("does not preserve a wrong usable auth symlink for a secret-bound API key", async () => {
    const fx = await makeFixture();
    try {
      const wrongAuth = path.join(fx.root, "wrong-auth.json");
      await fs.writeFile(wrongAuth, '{"token":"other-subscription"}', "utf8");
      await fs.rm(fx.sharedAuth, { force: true });
      await fs.mkdir(fx.agentHome, { recursive: true });
      await fs.symlink(wrongAuth, fx.agentAuth);

      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        apiKeySecretBound: true,
        env: fx.env,
      });

      expect(result.status).toBe("source_auth_missing");
      await expect(fs.lstat(fx.agentAuth)).rejects.toThrow();
      await expect(fs.readFile(wrongAuth, "utf8")).resolves.toBe('{"token":"other-subscription"}');
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("seeds the shared symlink for a secret-bound key when no auth exists yet", async () => {
    const fx = await makeFixture();
    try {
      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        apiKeySecretBound: true,
        env: fx.env,
      });

      expect(result.status).toBe("seeded");
      expect((await fs.lstat(fx.agentAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(fx.agentAuth)).toBe(await fs.realpath(fx.sharedAuth));
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("writes an API-key auth.json into a managed home when an apiKey is supplied", async () => {
    const fx = await makeFixture();
    try {
      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        apiKey: "sk-reconcile-1",
        env: fx.env,
      });
      expect(result.status).toBe("seeded");
      const written = JSON.parse(await fs.readFile(fx.agentAuth, "utf8"));
      expect(written).toEqual({ OPENAI_API_KEY: "sk-reconcile-1" });

      const second = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        apiKey: "sk-reconcile-1",
        env: fx.env,
      });
      expect(second.status).toBe("already_seeded");
      expect(JSON.parse(await fs.readFile(fx.agentAuth, "utf8"))).toEqual({
        OPENAI_API_KEY: "sk-reconcile-1",
      });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("rehardens a matching regular API-key auth file before the already_seeded fast path", async () => {
    const fx = await makeFixture();
    try {
      await fs.mkdir(fx.agentHome, { recursive: true });
      await fs.writeFile(
        fx.agentAuth,
        JSON.stringify({ OPENAI_API_KEY: "sk-matching" }),
        { mode: 0o644 },
      );
      await fs.chmod(fx.agentAuth, 0o644);

      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        apiKey: "sk-matching",
        env: fx.env,
      });

      expect(result.status).toBe("already_seeded");
      expect((await fs.stat(fx.agentAuth)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe("evaluateCodexCredentialReadiness", () => {
  async function makeFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-readiness-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const companyRoot = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
    );
    const managedCompanyHome = path.join(companyRoot, "codex-home");
    const managedAgentHome = path.join(companyRoot, "agents", "agent-1", "codex-home");
    const env: NodeJS.ProcessEnv = {
      CODEX_HOME: sharedCodexHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "default",
    };
    await fs.mkdir(sharedCodexHome, { recursive: true });
    return { root, sharedCodexHome, managedCompanyHome, managedAgentHome, env };
  }

  async function writeUsableAuth(home: string) {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "auth.json"), '{"OPENAI_API_KEY":"sk-live"}\n', "utf8");
  }

  it("flags a managed home with no source auth and empty OPENAI_API_KEY as not ready", async () => {
    const fx = await makeFixture();
    try {
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        configuredCodexHome: fx.managedAgentHome,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: true, authMode: "subscription", ready: false });
      expect(result.effectiveHome).toBe(path.resolve(fx.managedAgentHome));
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("treats a non-empty resolved OPENAI_API_KEY as ready without touching disk", async () => {
    const fx = await makeFixture();
    try {
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        configuredCodexHome: fx.managedAgentHome,
        configuredApiKey: "sk-agent-key",
      });
      expect(result).toMatchObject({ managed: true, authMode: "api", ready: true });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("is ready when the shared source home carries usable subscription auth", async () => {
    const fx = await makeFixture();
    try {
      await writeUsableAuth(fx.sharedCodexHome);
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        configuredCodexHome: fx.managedAgentHome,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: true, authMode: "subscription", ready: true });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("is ready when the already-seeded effective home resolves to current shared auth", async () => {
    const fx = await makeFixture();
    try {
      await writeUsableAuth(fx.sharedCodexHome);
      await fs.mkdir(fx.managedAgentHome, { recursive: true });
      await fs.symlink(
        path.join(fx.sharedCodexHome, "auth.json"),
        path.join(fx.managedAgentHome, "auth.json"),
      );
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        configuredCodexHome: fx.managedAgentHome,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: true, authMode: "subscription", ready: true });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("defaults to the managed agent home when no CODEX_HOME is configured", async () => {
    const fx = await makeFixture();
    try {
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        agentId: "agent-1",
        configuredCodexHome: null,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: true, authMode: "subscription", ready: false });
      expect(result.effectiveHome).toBe(path.resolve(fx.managedAgentHome));
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("treats an external/user-supplied CODEX_HOME override as self-managed and ready", async () => {
    const fx = await makeFixture();
    try {
      const externalHome = path.join(fx.root, "user-codex-home");
      await fs.mkdir(externalHome, { recursive: true });
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        configuredCodexHome: externalHome,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: false, ready: true });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("rejects a sibling managed agent home instead of treating it as an external override", async () => {
    const fx = await makeFixture();
    try {
      const siblingManagedHome = path.join(
        path.dirname(path.dirname(fx.managedAgentHome)),
        "agent-2",
        "codex-home",
      );
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        agentId: "agent-1",
        configuredCodexHome: siblingManagedHome,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: true, ready: false });
      expect(result.effectiveHome).toBe(path.resolve(siblingManagedHome));
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("fails closed for lexical and realpath aliases into reserved Codex namespaces", async () => {
    const fx = await makeFixture();
    try {
      const instanceRoot = path.join(fx.env.PAPERCLIP_HOME!, "instances", "default");
      const otherCompanyHome = path.join(instanceRoot, "companies", "company-2", "codex-home");
      const realAlias = path.join(fx.root, "alias-to-shared");
      const instanceAlias = path.join(fx.root, "alias-to-instance");
      await fs.mkdir(instanceRoot, { recursive: true });
      await fs.symlink(fx.sharedCodexHome, realAlias);
      await fs.symlink(instanceRoot, instanceAlias);
      const candidates = [
        ["other company", otherCompanyHome],
        ["instance home", path.join(instanceRoot, "codex-home")],
        ["host shared source", fx.sharedCodexHome],
        ["default host source", path.join(os.homedir(), ".codex")],
        ["realpath alias", realAlias],
        ["missing leaf behind realpath alias", path.join(instanceAlias, "new-home")],
      ] as const;
      for (const [label, configuredCodexHome] of candidates) {
        const result = await evaluateCodexCredentialReadiness({
          env: fx.env,
          companyId: "company-1",
          agentId: "agent-1",
          configuredCodexHome,
          configuredApiKey: "",
        });
        expect(result.managed, label).toBe(true);
        expect(result.ready, label).toBe(false);
      }
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("does not accept a usable managed auth symlink when the current shared source is missing", async () => {
    const fx = await makeFixture();
    try {
      const wrongAuth = path.join(fx.root, "wrong-auth.json");
      await fs.writeFile(wrongAuth, '{"token":"other"}', "utf8");
      await fs.mkdir(fx.managedAgentHome, { recursive: true });
      await fs.symlink(wrongAuth, path.join(fx.managedAgentHome, "auth.json"));

      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        agentId: "agent-1",
        configuredCodexHome: fx.managedAgentHome,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: true, authMode: "subscription", ready: false });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe("managed Codex home lease", () => {
  type Lease = { release: () => Promise<void> };
  type AcquireLease = (
    home: string,
    options?: { waitMs?: number; pollMs?: number; staleOwnerGraceMs?: number },
  ) => Promise<Lease>;

  async function loadAcquireLease(): Promise<AcquireLease | undefined> {
    const module = await import("./codex-home.js");
    return (module as unknown as { acquireManagedCodexHomeLease?: AcquireLease })
      .acquireManagedCodexHomeLease;
  }

  it("continues waiting past the old timeout while a live owner holds the lease", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-lease-bounded-"));
    try {
      const acquire = await loadAcquireLease();
      expect(acquire).toBeTypeOf("function");
      if (!acquire) return;
      const home = path.join(root, "codex-home");
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      const first = await acquire(home, { waitMs: 100, pollMs: 5 });
      const second = acquire(home, { waitMs: 20, pollMs: 5 }).then(
        (lease) => ({ lease, error: null }),
        (error: unknown) => ({ lease: null, error }),
      );
      const early = await Promise.race([
        second,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 60)),
      ]);
      expect(early).toBeNull();
      await first.release();
      const acquired = await second;
      expect(acquired.error).toBeNull();
      await acquired.lease?.release();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a stale lease owned by a dead process and releases by owner token", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-lease-stale-"));
    try {
      const acquire = await loadAcquireLease();
      expect(acquire).toBeTypeOf("function");
      if (!acquire) return;
      const home = path.join(root, "codex-home");
      const lockDir = `${home}.paperclip-lock`;
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      await fs.mkdir(lockDir, { mode: 0o700 });
      await fs.writeFile(
        path.join(lockDir, "owner.json"),
        JSON.stringify({
          pid: 999_999_999,
          hostname: os.hostname(),
          token: "stale-token",
          createdAt: "2000-01-01T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );

      const lease = await acquire(home, { waitMs: 100, pollMs: 5, staleOwnerGraceMs: 0 });
      expect((await fs.stat(lockDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(lockDir, "owner.json"))).mode & 0o777).toBe(0o600);
      await lease.release();
      await expect(fs.access(lockDir)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
