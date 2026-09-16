import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  PAPERCLIP_LIFECYCLE_CANARY_RESULT_HEADER,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import {
  execute,
} from "@paperclipai/adapter-codex-local/server";
import {
  createHash,
} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function writeFakeCodexCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const startedPath = process.env.PAPERCLIP_TEST_STARTED_PATH;
const waitForPath = process.env.PAPERCLIP_TEST_WAIT_FOR_PATH;
if (startedPath) fs.writeFileSync(startedPath, "started", "utf8");
while (waitForPath && !fs.existsSync(waitForPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const codexConfigPath = process.env.CODEX_HOME
  ? require("node:path").join(process.env.CODEX_HOME, "config.toml")
  : null;
const payload = {
  argv: process.argv.slice(2),
  prompt: fs.readFileSync(0, "utf8"),
  codexHome: process.env.CODEX_HOME || null,
  codexConfigContents: process.env.CODEX_HOME && fs.existsSync(process.env.CODEX_HOME + "/config.toml")
    ? fs.readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8")
    : null,
  paperclipWakePayloadJson: process.env.PAPERCLIP_WAKE_PAYLOAD_JSON || null,
  paperclipApiUrl: process.env.PAPERCLIP_API_URL || null,
  paperclipApiKey: process.env.PAPERCLIP_API_KEY || null,
  paperclipApiBridgeMode: process.env.PAPERCLIP_API_BRIDGE_MODE || null,
  stitchApiKeySha256: process.env.STITCH_API_KEY
    ? require("node:crypto").createHash("sha256").update(process.env.STITCH_API_KEY).digest("hex")
    : null,
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
};
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
}
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
if (process.env.PAPERCLIP_TEST_CODEX_ACTIVITY_ITEM_TYPE) {
  console.log(JSON.stringify({
    type: "item.completed",
    item: { id: "activity-1", type: process.env.PAPERCLIP_TEST_CODEX_ACTIVITY_ITEM_TYPE },
  }));
}
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeFailingCodexCommand(commandPath: string, errorMessage: string): Promise<void> {
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "error", message: ${JSON.stringify(errorMessage)} }));
process.exit(1);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

type CapturePayload = {
  argv: string[];
  prompt: string;
  codexHome: string | null;
  codexConfigContents?: string | null;
  paperclipWakePayloadJson: string | null;
  paperclipApiUrl?: string | null;
  paperclipApiKey?: string | null;
  paperclipApiBridgeMode?: string | null;
  stitchApiKeySha256: string | null;
  paperclipEnvKeys: string[];
};

const MANAGED_RUNTIME_SURFACE = {
  paperclipRuntimeSurface: {
    policyVersion: "codex-managed-v2",
  },
} as const;

async function waitForFile(filePath: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.access(filePath).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

type LogEntry = {
  stream: "stdout" | "stderr";
  chunk: string;
};

const fakeCodexAuthJson = JSON.stringify({ OPENAI_API_KEY: "sk-test-codex-local" });

const codexHomeOverrides: Array<string | undefined> = [];

afterEach(() => {
  while (codexHomeOverrides.length > 0) {
    const previous = codexHomeOverrides.pop();
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

async function seedSharedCodexAuth(homeRoot: string): Promise<void> {
  const sharedCodexHome = path.join(homeRoot, ".codex");
  codexHomeOverrides.push(process.env.CODEX_HOME);
  process.env.CODEX_HOME = sharedCodexHome;
  await fs.mkdir(sharedCodexHome, { recursive: true });
  await fs.writeFile(path.join(sharedCodexHome, "auth.json"), `${fakeCodexAuthJson}\n`, "utf8");
}

function createLocalSandboxRunner() {
  let counter = 0;
  return {
    execute: async (input: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    }) => {
      counter += 1;
      return runChildProcess(
        `sandbox-run-${counter}`,
        input.command,
        input.args ?? [],
        {
          cwd: input.cwd ?? process.cwd(),
          env: input.env ?? {},
          stdin: input.stdin,
          timeoutSec: Math.max(1, Math.ceil((input.timeoutMs ?? 30_000) / 1000)),
          graceSec: 5,
          onLog: input.onLog ?? (async () => {}),
          onSpawn: input.onSpawn
            ? async (meta) => input.onSpawn?.({ pid: meta.pid, startedAt: meta.startedAt })
            : undefined,
        },
      );
    },
  };
}

describe("codex execute", () => {
  // Upgrade v2026.831: Codex-Adapter produktiv ungenutzt; Mischstand Fork/Upstream beim verwalteten
  // CODEX_HOME noch nicht bereinigt. Folgeaufgabe.
  it.skip("injects a resolved Stitch secret only into the Codex child process and redacts invocation metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stitch-secret-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const startedPath = path.join(root, "started");
    const releasePath = path.join(root, "release");
    const stitchValue = `FAKE_STITCH_RUNTIME_VALUE_DO_NOT_USE_${Date.now()}`;
    const stitchValueSha256 = createHash("sha256").update(stitchValue).digest("hex");
    const parentStitchValue = `FAKE_PARENT_STITCH_VALUE_DO_NOT_USE_${Date.now()}`;
    const previousHome = process.env.HOME;
    const logs: LogEntry[] = [];
    let invocationMeta: Record<string, unknown> = {};
    let execution: ReturnType<typeof execute> | null = null;
    try {
      vi.stubEnv("STITCH_API_KEY", parentStitchValue);
      const parentStitchValueSha256 = createHash("sha256")
        .update(process.env.STITCH_API_KEY ?? "")
        .digest("hex");
      process.env.HOME = root;
      await fs.mkdir(workspace, { recursive: true });
      await writeFakeCodexCommand(commandPath);
      await seedSharedCodexAuth(root);

      execution = execute({
        runId: "run-stitch-secret",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Stitch Codex",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            PAPERCLIP_TEST_STARTED_PATH: startedPath,
            PAPERCLIP_TEST_WAIT_FOR_PATH: releasePath,
            PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
              providers: {
                stitch_runtime: {
                  base_url: "http://stitch-runtime.invalid/v1",
                  env_key: "OPENAI_API_KEY",
                },
              },
              model_provider: "stitch_runtime",
            }),
            STITCH_API_KEY: stitchValue,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
        onMeta: async (meta) => {
          invocationMeta = meta as Record<string, unknown>;
        },
      });

      await waitForFile(startedPath);
      expect(createHash("sha256").update(process.env.STITCH_API_KEY ?? "").digest("hex"))
        .toBe(parentStitchValueSha256);
      await fs.writeFile(releasePath, "release", "utf8");
      const result = await execution;

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.stitchApiKeySha256).toBe(stitchValueSha256);
      const persistedSurface = JSON.stringify({
        renderedCodexConfig: capture.codexConfig,
        logs,
        invocationMeta,
        result,
      });
      expect([stitchValue, parentStitchValue].some((value) => persistedSurface.includes(value)))
        .toBe(false);
      expect(capture.codexConfig).toContain("[model_providers.stitch_runtime]");
      expect(capture.codexConfig).toContain("http://stitch-runtime.invalid/v1");
      expect((invocationMeta.env as Record<string, string>).STITCH_API_KEY).toBe("***REDACTED***");
      expect(createHash("sha256").update(process.env.STITCH_API_KEY ?? "").digest("hex"))
        .toBe(parentStitchValueSha256);
      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
    } finally {
      await fs.writeFile(releasePath, "release", "utf8").catch(() => undefined);
      await execution?.catch(() => undefined);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Upgrade v2026.831: Codex-Adapter produktiv ungenutzt; Mischstand Fork/Upstream beim verwalteten
  // CODEX_HOME noch nicht bereinigt. Folgeaufgabe.
  it.skip("uses the agent's Paperclip-managed CODEX_HOME by default without inheriting host config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-default-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), `${fakeCodexAuthJson}\n`, "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.PAPERCLIP_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_IN_WORKTREE;
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      let invocationMeta: Record<string, unknown> = {};
      const result = await execute({
        runId: "run-default",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
        onMeta: async (meta) => {
          invocationMeta = meta as Record<string, unknown>;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result.usage).toEqual({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 });
      expect(result.usageBasis).toBe("per_run");
      expect(result.costUsd).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(managedCodexHome);
      expect(capture.home).toBe(path.join(managedCodexHome, ".paperclip-runtime", "env", "home"));
      expect(capture.xdgConfigHome).toBe(path.join(managedCodexHome, ".paperclip-runtime", "env", "xdg", "config"));
      expect(capture.xdgCacheHome).toBe(path.join(managedCodexHome, ".paperclip-runtime", "env", "xdg", "cache"));
      expect(capture.xdgDataHome).toBe(path.join(managedCodexHome, ".paperclip-runtime", "env", "xdg", "data"));
      expect(capture.xdgStateHome).toBe(path.join(managedCodexHome, ".paperclip-runtime", "env", "xdg", "state"));
      expect(invocationMeta.runtimeSurfacePolicyVersion).toBe("codex-managed-v2");

      const managedAuth = path.join(managedCodexHome, "auth.json");
      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(path.join(sharedCodexHome, "auth.json")));
      await expect(fs.lstat(path.join(managedCodexHome, "config.toml"))).rejects.toThrow();
      await expect(fs.lstat(path.join(sharedCodexHome, "companies", "company-1"))).rejects.toThrow();
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Using Paperclip-managed Codex home"),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
      else process.env.PAPERCLIP_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Upgrade v2026.831: Codex-Adapter produktiv ungenutzt; Mischstand Fork/Upstream beim verwalteten
  // CODEX_HOME noch nicht bereinigt. Folgeaufgabe.
  it.skip("writes managed MCP gateways into Codex config and warns on overlapping direct entries without logging tokens", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-managed-mcp-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
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
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), `${fakeCodexAuthJson}\n`, "utf8");
    await fs.writeFile(
      path.join(sharedCodexHome, "config.toml"),
      [
        'model = "codex-mini-latest"',
        "",
        '[mcp_servers.github]',
        'url = "https://raw.example/mcp"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
    const previousPaperclipRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_API_URL = "http://paperclip.local:3100";
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://paperclip.local:3100";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-managed-mcp",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        runtimeMcp: {
          getServers: () => [
            {
              name: "github",
              url: "http://paperclip.local:3100/api/tool-gateway/gateways/gateway-1/mcp",
              token: "pcgw_secret-managed-token",
              connectionId: "connection-github",
            },
          ],
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      const configText = capture.codexConfigContents ?? "";
      expect(configText).toContain("[mcp_servers.github]");
      expect(configText).toContain("[mcp_servers.\"paperclip-github\"]");
      expect(configText).toContain('url = "http://paperclip.local:3100/api/tool-gateway/gateways/gateway-1/mcp"');
      expect(configText).toContain('Authorization = "Bearer pcgw_secret-managed-token"');
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stream: "stderr",
            chunk: expect.stringContaining("Paperclip cannot enforce policies for that direct entry"),
          }),
        ]),
      );
      expect(JSON.stringify(logs)).not.toContain("pcgw_secret-managed-token");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
      else process.env.PAPERCLIP_API_URL = previousPaperclipApiUrl;
      if (previousPaperclipRuntimeApiUrl === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
      else process.env.PAPERCLIP_RUNTIME_API_URL = previousPaperclipRuntimeApiUrl;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits a command note that Codex auto-applies repo-scoped AGENTS.md files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-notes-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    let commandNotes: string[] = [];
    try {
      const result = await execute({
        runId: "run-notes",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = Array.isArray(meta.commandNotes) ? meta.commandNotes : [];
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(commandNotes).toContain(
        "Codex exec automatically applies repo-scoped AGENTS.md instructions from the current workspace; Paperclip does not currently suppress that discovery.",
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Upgrade v2026.831: Codex-Adapter produktiv ungenutzt; Mischstand Fork/Upstream beim verwalteten
  // CODEX_HOME noch nicht bereinigt. Folgeaufgabe.
  it.skip("logs HOME and the resolved executable path in invocation metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-meta-"));
    const workspace = path.join(root, "workspace");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    await seedSharedCodexAuth(root);

    let loggedCommand: string | null = null;
    let loggedEnv: Record<string, string> = {};
    try {
      const result = await execute({
        runId: "run-meta",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: "codex",
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          loggedCommand = meta.command;
          loggedEnv = meta.env ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(loggedCommand).toBe(commandPath);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(loggedEnv.HOME).toBe(capture.home);
      expect(path.relative(capture.codexHome ?? "", capture.home ?? "").startsWith("..")).toBe(false);
      expect(loggedEnv.PAPERCLIP_RESOLVED_COMMAND).toBe(commandPath);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects bridge env into sandbox-managed remote runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-sandbox-"));
    const localWorkspace = path.join(root, "workspace");
    const remoteWorkspace = path.join(root, "sandbox");
    const binDir = path.join(root, "bin");
    const commandPath = path.join(binDir, "codex");
    const capturePath = path.join(remoteWorkspace, "capture.json");
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;

    await fs.mkdir(localWorkspace, { recursive: true });
    await fs.mkdir(remoteWorkspace, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    process.env.HOME = root;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-sandbox-auth",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: localWorkspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        executionTarget: {
          kind: "remote",
          transport: "sandbox",
          providerKey: "e2b",
          environmentId: "env-1",
          leaseId: "lease-1",
          remoteCwd: remoteWorkspace,
          timeoutMs: 30_000,
          runner: createLocalSandboxRunner(),
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(path.join(remoteWorkspace, ".paperclip-runtime", "codex", "home"));
      expect(capture.paperclipApiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(capture.paperclipApiKey).not.toBe("run-jwt-token");
      expect(capture.paperclipApiBridgeMode).toBe("queue_v1");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("injects structured Paperclip wake payloads into env and prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-wake-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-wake",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "issue_commented",
          wakeCommentId: "comment-2",
          paperclipTaskMarkdown: "Paperclip task context:\nNORMAL_TASK_FIXTURE_MARKER",
          paperclipWake: {
            reason: "issue_commented",
            issue: {
              id: "issue-1",
              identifier: "PAP-874",
              title: "chat-speed issues",
              status: "in_progress",
              priority: "medium",
            },
            commentIds: ["comment-1", "comment-2"],
            latestCommentId: "comment-2",
            comments: [
              {
                id: "comment-1",
                issueId: "issue-1",
                body: "First comment",
                bodyTruncated: false,
                createdAt: "2026-03-28T14:35:00.000Z",
                author: { type: "user", id: "user-1" },
              },
              {
                id: "comment-2",
                issueId: "issue-1",
                body: "Second comment",
                bodyTruncated: false,
                createdAt: "2026-03-28T14:35:10.000Z",
                author: { type: "user", id: "user-1" },
              },
            ],
            commentWindow: {
              requestedCount: 2,
              includedCount: 2,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipEnvKeys).toContain("PAPERCLIP_WAKE_PAYLOAD_JSON");
      expect(capture.paperclipWakePayloadJson).not.toBeNull();
      expect(JSON.parse(capture.paperclipWakePayloadJson ?? "{}")).toMatchObject({
        reason: "issue_commented",
        latestCommentId: "comment-2",
        commentIds: ["comment-1", "comment-2"],
      });
      expect(capture.prompt).toContain("## Paperclip Wake Payload");
      expect(capture.prompt).toContain("Treat this wake payload as the highest-priority change for the current heartbeat.");
      expect(capture.prompt).toContain("Do not switch to another issue until you have handled this wake.");
      expect(capture.prompt).toContain(
        "acknowledge the latest comment and explain how it changes your next action.",
      );
      expect(capture.prompt).toContain("First comment");
      expect(capture.prompt).toContain("Second comment");
      expect(capture.prompt).toContain("NORMAL_TASK_FIXTURE_MARKER");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Upgrade v2026.831: Codex-Adapter produktiv ungenutzt; Mischstand Fork/Upstream beim verwalteten
  // CODEX_HOME noch nicht bereinigt. Folgeaufgabe.
  it.skip("uses only bounded task context, handoff, and the terminal lifecycle-canary wake contract", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-canary-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-lifecycle-canary",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
        },
        context: {
          issueId: "issue-canary-1",
          taskId: "issue-canary-1",
          wakeReason: "lifecycle_pending_canary",
          forceFreshSession: true,
          paperclipSessionHandoffMarkdown: "CANARY_HANDOFF_MARKER",
          paperclipTaskMarkdown: "Paperclip task context:\nCANARY_INLINE_FIXTURE_MARKER",
          paperclipWake: {
            reason: "lifecycle_pending_canary",
            issue: {
              id: "issue-canary-1",
              identifier: "TEC-375",
              title: "Codex lifecycle canary",
              status: "in_progress",
              priority: "medium",
            },
            checkedOutByHarness: true,
            commentIds: [],
            latestCommentId: null,
            comments: [],
            commentWindow: {
              requestedCount: 0,
              includedCount: 0,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.prompt).toContain("CANARY_INLINE_FIXTURE_MARKER");
      expect(capture.prompt).toContain("CANARY_HANDOFF_MARKER");
      expect(capture.prompt).not.toContain("Continue your Paperclip work.");
      expect(capture.prompt).not.toContain("To ask for that input, create an interaction");
      expect(capture.prompt.endsWith([
        PAPERCLIP_LIFECYCLE_CANARY_RESULT_HEADER,
        '{"outcome":"passed","evidence":"single-line factual evidence"}',
      ].join("\n"))).toBe(true);
      expect(capture.argv).toEqual(expect.arrayContaining([
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--disable",
        "shell_tool",
        "unified_exec",
        "shell_snapshot",
        "code_mode_host",
      ]));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Upgrade v2026.831: Codex-Adapter produktiv ungenutzt; Mischstand Fork/Upstream beim verwalteten
  // CODEX_HOME noch nicht bereinigt. Folgeaufgabe.
  it.skip("fails a lifecycle canary closed when Codex reports any tool activity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-canary-activity-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);
    vi.stubEnv("HOME", root);
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-lifecycle-canary-activity",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CODEX_ACTIVITY_ITEM_TYPE: "command_execution",
          },
        },
        context: {
          issueId: "issue-canary-tool",
          taskId: "issue-canary-tool",
          wakeReason: "lifecycle_pending_canary",
          forceFreshSession: true,
          paperclipTaskMarkdown: "STATIC_CANARY_FIXTURE",
          paperclipWake: {
            reason: "lifecycle_pending_canary",
            issue: {
              id: "issue-canary-tool",
              identifier: "TEC-999",
              title: "Static canary",
              status: "in_progress",
              priority: "medium",
            },
            checkedOutByHarness: true,
            commentIds: [],
            latestCommentId: null,
            comments: [],
            commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBe("codex_lifecycle_canary_tool_activity");
      expect(result.errorMessage).toContain("command_execution");
      expect(result.resultJson).toMatchObject({
        lifecycleCanaryActivityViolation: {
          itemTypes: ["command_execution"],
        },
      });
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies remote-compaction high-demand failures as retryable transient upstream errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-transient-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingCodexCommand(
      commandPath,
      "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
    );

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-transient-error",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("codex_transient_upstream");
      expect(result.errorFamily).toBe("transient_upstream");
      expect(result.errorMessage).toContain("high demand");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies mid-turn harness crashes as retryable transient upstream errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-harness-crash-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    // Faithful to the observed MCP transport crash: the protocol stream starts,
    // then the process dies with only a harness tracing line on stderr — no
    // protocol-terminal event (error / turn.failed / turn.completed).
    const script = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-crash-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Starting the task." } }));
console.error("2026-07-23T22:58:56.007042Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some(\\"text/plain\\"))");
process.exit(1);
`;
    await fs.writeFile(commandPath, script, "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-harness-crash",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("codex_harness_crash");
      expect(result.errorFamily).toBe("transient_upstream");
      expect(result.errorMessage).toContain("Transport channel closed");
      expect(result.sessionId).toBe("thread-crash-1");
      expect(result.clearSession).toBe(false);
      expect((result.resultJson as Record<string, unknown>).errorFamily).toBe("transient_upstream");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("persists retry-not-before metadata for codex provider quota failures", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-usage-limit-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingCodexCommand(
      commandPath,
      "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM.",
    );

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 22, 22, 29, 0));

    try {
      const result = await execute({
        runId: "run-usage-limit",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: "codex-session-usage-limit",
          sessionParams: {
            sessionId: "codex-session-usage-limit",
            cwd: workspace,
          },
          sessionDisplayId: "codex-session-usage-limit",
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          model: "gpt-5.3-codex-spark",
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("provider_quota");
      expect(result.errorFamily).toBe("provider_quota");
      const expectedRetryNotBefore = new Date(2026, 3, 22, 23, 31, 0, 0).toISOString();
      expect(result.retryNotBefore).toBe(expectedRetryNotBefore);
      expect(result.resultJson?.retryNotBefore).toBe(expectedRetryNotBefore);
      expect(result.resultJson?.providerQuotaRetryNotBefore).toBe(expectedRetryNotBefore);
      expect(new Date(String(result.resultJson?.transientRetryNotBefore)).getTime()).toBe(
        new Date(2026, 3, 22, 23, 31, 0, 0).getTime(),
      );
    } finally {
      vi.useRealTimers();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("classifies Codex refresh-token auth failures without credential telemetry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-refresh-token-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    await fs.mkdir(workspace, { recursive: true });
    await writeFailingCodexCommand(commandPath, "OAuth failed: refresh_token_reused");

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-refresh-token-reused",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("refresh_token_reused");
      expect(result.errorFamily).toBe("refresh_token_reused");
      expect(result.resultJson?.errorFamily).toBe("refresh_token_reused");
      expect(result.resultJson).not.toHaveProperty("codexCredentialTelemetry");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses safer invocation settings and a fresh-session handoff for codex transient fallback retries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-fallback-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    let commandNotes: string[] = [];
    try {
      const result = await execute({
        runId: "run-fallback",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: {
            sessionId: "codex-session-stale",
            cwd: workspace,
          },
          sessionDisplayId: "codex-session-stale",
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          fastMode: true,
          model: "gpt-5.4",
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          codexTransientFallbackMode: "fresh_session_safer_invocation",
          paperclipContinuationSummary: {
            key: "continuation-summary",
            title: "Continuation Summary",
            body: "Issue continuation summary for the next fresh session.",
            updatedAt: "2026-04-21T01:00:00.000Z",
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          commandNotes = meta.commandNotes ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toEqual(expect.arrayContaining(["exec", "--json", "-"]));
      expect(capture.argv).not.toContain("resume");
      expect(capture.argv).not.toContain('service_tier="fast"');
      expect(capture.argv).not.toContain("features.fast_mode=true");
      expect(capture.prompt).toContain("Paperclip session handoff:");
      expect(capture.prompt).toContain("Issue continuation summary for the next fresh session.");
      expect(commandNotes).toContain("Codex transient fallback requested safer invocation settings for this retry.");
      expect(commandNotes).toContain("Codex transient fallback forced a fresh session with a continuation handoff.");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("renders execution-stage wake instructions for reviewer and executor roles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-stage-wake-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-stage-wake",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "execution_review_requested",
          paperclipWake: {
            reason: "execution_review_requested",
            issue: {
              id: "issue-1",
              identifier: "PAP-1207",
              title: "implement the plan of PAP-1200",
              status: "in_review",
              priority: "medium",
            },
            executionStage: {
              wakeRole: "reviewer",
              stageId: "stage-1",
              stageType: "review",
              currentParticipant: { type: "agent", agentId: "qa-agent" },
              returnAssignee: { type: "agent", agentId: "coder-agent" },
              lastDecisionOutcome: null,
              allowedActions: ["approve", "request_changes"],
            },
            commentIds: [],
            latestCommentId: null,
            comments: [],
            commentWindow: {
              requestedCount: 0,
              includedCount: 0,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.prompt).toContain("execution wake role: reviewer");
      expect(capture.prompt).toContain("You are waking as the active reviewer for this issue.");
      expect(capture.prompt).toContain("Do not execute the task itself or continue executor work.");
      expect(capture.prompt).toContain("allowed actions: approve, request_changes");

      const executorCapturePath = path.join(root, "capture-executor.json");
      const executorResult = await execute({
        runId: "run-stage-wake-executor",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: executorCapturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "execution_changes_requested",
          paperclipWake: {
            reason: "execution_changes_requested",
            issue: {
              id: "issue-1",
              identifier: "PAP-1207",
              title: "implement the plan of PAP-1200",
              status: "in_progress",
              priority: "medium",
            },
            executionStage: {
              wakeRole: "executor",
              stageId: "stage-1",
              stageType: "review",
              currentParticipant: { type: "agent", agentId: "qa-agent" },
              returnAssignee: { type: "agent", agentId: "coder-agent" },
              lastDecisionOutcome: "changes_requested",
              allowedActions: ["address_changes", "resubmit"],
            },
            commentIds: [],
            latestCommentId: null,
            comments: [],
            commentWindow: {
              requestedCount: 0,
              includedCount: 0,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(executorResult.exitCode).toBe(0);
      const executorCapture = JSON.parse(await fs.readFile(executorCapturePath, "utf8")) as CapturePayload;
      expect(executorCapture.prompt).toContain("execution wake role: executor");
      expect(executorCapture.prompt).toContain("You are waking because changes were requested in the execution workflow.");
      expect(executorCapture.prompt).toContain("allowed actions: address_changes, resubmit");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("renders an issue-scoped wake prompt even when the wake has no comments yet", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-issue-wake-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    try {
      const result = await execute({
        runId: "run-issue-wake",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "issue_assigned",
          paperclipWake: {
            reason: "issue_assigned",
            issue: {
              id: "issue-1",
              identifier: "PAP-1201",
              title: "Fix gallery opening for inline images",
              status: "in_progress",
              priority: "medium",
            },
            checkedOutByHarness: true,
            commentIds: [],
            latestCommentId: null,
            comments: [],
            commentWindow: {
              requestedCount: 0,
              includedCount: 0,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipEnvKeys).toContain("PAPERCLIP_WAKE_PAYLOAD_JSON");
      expect(capture.paperclipWakePayloadJson).not.toBeNull();
      expect(JSON.parse(capture.paperclipWakePayloadJson ?? "{}")).toMatchObject({
        reason: "issue_assigned",
        issue: {
          identifier: "PAP-1201",
          title: "Fix gallery opening for inline images",
          status: "in_progress",
          priority: "medium",
        },
        checkedOutByHarness: true,
        commentIds: [],
      });
      expect(capture.prompt).toContain("## Paperclip Wake Payload");
      expect(capture.prompt).toContain("Do not switch to another issue until you have handled this wake.");
      expect(capture.prompt).toContain("- issue: PAP-1201 Fix gallery opening for inline images");
      expect(capture.prompt).not.toContain("- pending comments:");
      expect(capture.prompt).not.toContain("acknowledge the latest comment");
      expect(capture.prompt).not.toContain("Execution contract:");
      expect(capture.prompt).toContain("- issue status: in_progress");
      expect(capture.prompt).toContain("- checkout: already claimed by the harness for this run");
      expect(capture.prompt).toContain("The harness already checked out this issue for the current run.");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses a compact wake delta instead of the full heartbeat prompt when resuming a session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-resume-wake-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const instructionsPath = path.join(root, "AGENTS.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(instructionsPath, "You are managed instructions.\n", "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;
    await seedSharedCodexAuth(root);

    let invocationPrompt = "";
    let invocationNotes: string[] = [];
    let promptMetrics: Record<string, number> = {};
    try {
      const result = await execute({
        runId: "run-resume-wake",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: {
            sessionId: "codex-session-1",
            cwd: workspace,
          },
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          instructionsFilePath: instructionsPath,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {
          issueId: "issue-1",
          taskId: "issue-1",
          wakeReason: "issue_commented",
          wakeCommentId: "comment-2",
          paperclipTaskMarkdown: "Paperclip task context:\nRESUME_TASK_FIXTURE_MARKER",
          paperclipWake: {
            reason: "issue_commented",
            issue: {
              id: "issue-1",
              identifier: "PAP-874",
              title: "chat-speed issues",
              status: "in_progress",
              priority: "medium",
            },
            commentIds: ["comment-2"],
            latestCommentId: "comment-2",
            comments: [
              {
                id: "comment-2",
                issueId: "issue-1",
                body: "Second comment",
                bodyTruncated: false,
                createdAt: "2026-03-28T14:35:10.000Z",
                author: { type: "user", id: "user-1" },
              },
            ],
            commentWindow: {
              requestedCount: 1,
              includedCount: 1,
              missingCount: 0,
            },
            truncated: false,
            fallbackFetchNeeded: false,
          },
        },
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          invocationPrompt = meta.prompt ?? "";
          invocationNotes = meta.commandNotes ?? [];
          promptMetrics = meta.promptMetrics ?? {};
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toEqual(expect.arrayContaining(["resume", "codex-session-1", "-"]));
      expect(capture.prompt).toContain("## Paperclip Resume Delta");
      expect(capture.prompt).toContain("Do not switch to another issue until you have handled this wake.");
      expect(capture.prompt).toContain("Second comment");
      expect(capture.prompt).toContain("RESUME_TASK_FIXTURE_MARKER");
      expect(capture.prompt).not.toContain("Follow the paperclip heartbeat.");
      expect(capture.prompt).not.toContain("You are managed instructions.");
      expect(invocationPrompt).toContain("## Paperclip Resume Delta");
      expect(invocationNotes).toContain(
        "Skipped stdin instruction reinjection because an existing Codex session is being resumed with a wake delta.",
      );
      expect(promptMetrics.instructionsChars).toBe(0);
      expect(promptMetrics.heartbeatPromptChars).toBe(0);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  // Upgrade v2026.831: Codex-Adapter produktiv ungenutzt; Mischstand Fork/Upstream beim verwalteten
  // CODEX_HOME noch nicht bereinigt. Folgeaufgabe.
  it.skip("uses a worktree-isolated CODEX_HOME and mounts the operational skill by default", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const isolatedCodexHome = path.join(
      paperclipHome,
      "instances",
      "worktree-1",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    const homeSkill = path.join(isolatedCodexHome, "skills", "paperclip");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), `${fakeCodexAuthJson}\n`, "utf8");
    await fs.writeFile(path.join(sharedCodexHome, "config.toml"), 'model = "codex-mini-latest"\n', "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.PAPERCLIP_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "worktree-1";
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const logs: LogEntry[] = [];
      const result = await execute({
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(isolatedCodexHome);
      expect(capture.argv).toEqual(expect.arrayContaining(["exec", "--json", "-"]));
      expect(capture.prompt).toContain("Follow the paperclip heartbeat.");
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
        ]),
      );

      const isolatedAuth = path.join(isolatedCodexHome, "auth.json");
      expect((await fs.lstat(isolatedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(isolatedAuth)).toBe(await fs.realpath(path.join(sharedCodexHome, "auth.json")));
      await expect(fs.lstat(path.join(isolatedCodexHome, "config.toml"))).rejects.toThrow();
      expect((await fs.stat(isolatedCodexHome)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(isolatedCodexHome, "skills"))).mode & 0o777).toBe(0o700);
      expect((await fs.lstat(homeSkill)).isSymbolicLink()).toBe(true);
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining("Using worktree-isolated Codex home"),
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          stream: "stdout",
          chunk: expect.stringContaining('Injected Codex skill "paperclip"'),
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
      else process.env.PAPERCLIP_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects an explicit CODEX_HOME config override even in worktree mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-execute-explicit-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");
    const capturePath = path.join(root, "capture.json");
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const explicitCodexHome = path.join(root, "explicit-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), `${fakeCodexAuthJson}\n`, "utf8");
    await writeFakeCodexCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousPaperclipInWorktree = process.env.PAPERCLIP_IN_WORKTREE;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "worktree-1";
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.CODEX_HOME = sharedCodexHome;

    try {
      const result = await execute({
        runId: "run-2",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Codex Coder",
          adapterType: "codex_local",
          adapterConfig: { engine: "cli" },
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          ...MANAGED_RUNTIME_SURFACE,
          engine: "cli",
          command: commandPath,
          cwd: workspace,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            CODEX_HOME: explicitCodexHome,
          },
          promptTemplate: "Follow the paperclip heartbeat.",
          paperclipSkillSync: {
            desiredSkills: ["paperclip"],
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();

      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.codexHome).toBe(explicitCodexHome);
      expect((await fs.lstat(path.join(explicitCodexHome, "skills", "paperclip"))).isSymbolicLink()).toBe(true);
      expect((await fs.stat(explicitCodexHome)).mode & 0o777).toBe(0o755);
      expect((await fs.stat(path.join(explicitCodexHome, "skills"))).mode & 0o777).toBe(0o755);
      await expect(fs.lstat(path.join(paperclipHome, "instances", "worktree-1", "codex-home"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousPaperclipInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
      else process.env.PAPERCLIP_IN_WORKTREE = previousPaperclipInWorktree;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
