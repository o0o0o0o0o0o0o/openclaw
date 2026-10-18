import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { buildBootstrapContextFiles } from "./embedded-agent-helpers/bootstrap.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./sandbox/remote-fs-bridge.test-helpers.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { registerAgentWorkspaceAccess, type AgentWorkspaceAccess } from "./workspace-access.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "./workspace-bootstrap-read.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_USER_FILENAME,
  filterBootstrapFilesForSession as filterForSession,
  type WorkspaceBootstrapFile,
  workspaceFilesShareSourceIdentity,
  loadExtraBootstrapFilesWithDiagnostics as loadExtra,
  loadWorkspaceBootstrapFiles as loadBootstrap,
} from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function workspace(files: Record<string, string | Buffer> = {}) {
  const dir = tempDirs.make("bootstrap-");
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return dir;
}

function mockBridge(overrides: Partial<AgentWorkspaceAccess["bridge"]> = {}) {
  return { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn(), ...overrides };
}

async function withAccess(
  dir: string,
  bridge: AgentWorkspaceAccess["bridge"],
  run: () => Promise<unknown>,
) {
  const release = registerAgentWorkspaceAccess(dir, { bridge });
  try {
    await run();
  } finally {
    release();
  }
}

function bootstrapFile(
  name: WorkspaceBootstrapFile["name"],
  filePath = `/w/${name}`,
  content = "",
): WorkspaceBootstrapFile {
  return { name, path: filePath, content, missing: false };
}

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

function captureWarningLogger() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  const warn = vi.fn();
  loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  return warn;
}

describe("workspace bootstrap read diagnostics", () => {
  it.runIf(process.platform !== "win32").each(["oversized", "invalid-utf8"] as const)(
    "preserves native bootstrap handling for %s remote files",
    async (kind) => {
      const bytes =
        kind === "oversized"
          ? Buffer.alloc(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1, "x")
          : Buffer.from([0x61, 0xff, 0x62]);
      const local = await workspace({ "AGENTS.md": "stale local document" });
      const remote = await workspace({ "AGENTS.md": bytes });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandboxTestContext({
          overrides: { workspaceDir: local, agentWorkspaceDir: local },
        }),
        runtime: {
          remoteWorkspaceDir: remote,
          remoteAgentWorkspaceDir: remote,
          runRemoteShellScript: createLocalRemoteShellScriptRunner(),
        },
      });
      await withAccess(local, bridge, async () => {
        const [file] = await loadBootstrap(local, [DEFAULT_AGENTS_FILENAME]);
        expect(file?.missing).toBe(false);
        if (kind === "oversized") {
          expect(file?.content).toContain("[UNREADABLE:");
          expect(await loadExtra(local, ["AGENTS.md"])).toMatchObject({
            files: [],
            diagnostics: [expect.anything()],
          });
        } else {
          expect(file?.content).toBe(bytes.toString("utf8"));
        }
        expect(file?.content).not.toContain("stale local document");
      });
    },
  );

  it("loads configured extra documents from the remote workspace, including glob discovery", async () => {
    const local = await workspace({
      "AGENTS.md": "Gateway decoy",
      "packages/app/AGENTS.md": "Gateway decoy",
    });
    const remote = await workspace({
      "AGENTS.md": "remote root",
      "packages/app/AGENTS.md": "remote project",
    });
    const bridge: AgentWorkspaceAccess["bridge"] = {
      writeFile: vi.fn(),
      stat: async ({ filePath }) => {
        const stat = await fs.stat(path.join(remote, filePath));
        return {
          type: stat.isDirectory() ? "directory" : "file",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      },
      readFile: async ({ filePath }) => fs.readFile(path.join(remote, filePath)),
      readFileWithSource: async ({ filePath }) => ({
        data: await fs.readFile(path.join(remote, filePath)),
        canonicalPath: path.join(remote, filePath),
      }),
      readDirectory: async ({ filePath }) =>
        (await fs.readdir(path.join(remote, filePath), { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        })),
    };
    await withAccess(local, bridge, async () => {
      const { files, diagnostics } = await loadExtra(local, ["AGENTS.md", "packages/*/AGENTS.md"]);
      expect(diagnostics).toEqual([]);
      expect(files.map((file) => file.content)).toEqual(["remote root", "remote project"]);
    });
    await withAccess(local, { ...bridge, readDirectory: undefined }, async () => {
      const unavailable = await loadExtra(local, ["packages/*/AGENTS.md"]);
      expect(unavailable).toMatchObject({
        files: [],
        diagnostics: [
          {
            reason: "io",
            detail: expect.stringContaining("listing is unavailable"),
          },
        ],
      });
    });
  });

  it("omits missing remote MEMORY.md and USER.md even when Gateway copies exist", async () => {
    const names = [DEFAULT_MEMORY_FILENAME, DEFAULT_USER_FILENAME] as const;
    const local = await workspace(Object.fromEntries(names.map((name) => [name, "Gateway decoy"])));
    await withAccess(
      local,
      mockBridge({
        readFileWithSource: async () => {
          throw Object.assign(new Error("Remote file does not exist"), { code: "ENOENT" });
        },
      }),
      () => expect(loadBootstrap(local, names)).resolves.toEqual([]),
    );
  });

  it("does not split surrogate pairs when bounding unreadable reasons", async () => {
    const tempDir = await workspace({ "AGENTS.md": "# AGENTS.md\n" });
    const reason = `${"x".repeat(299)}😀tail`;
    const readSpy = vi.spyOn(syncFs, "read").mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      callback(new Error(reason));
    }) as typeof syncFs.read);

    try {
      const files = await loadBootstrap(tempDir);
      expect(files.find((file) => file.name === DEFAULT_AGENTS_FILENAME)?.content).toBe(
        `[UNREADABLE: ${"x".repeat(299)}]`,
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  it.each(["revoked access", "missing provenance"] as const)(
    "rejects remote bootstrap content with %s without local fallback",
    async (failure) => {
      const tempDir = await workspace({ "AGENTS.md": "stale local document" });
      const missingProvenance = failure === "missing provenance";
      let release = () => {};
      const readFile = missingProvenance
        ? vi.fn(async () => Buffer.from("unattributed remote document"))
        : vi.fn();
      const stat = vi.fn<AgentWorkspaceAccess["bridge"]["stat"]>();
      const bridge: AgentWorkspaceAccess["bridge"] = mockBridge({ readFile, stat });
      if (!missingProvenance) {
        bridge.readFileWithSource = vi.fn(async () => {
          release();
          return { data: Buffer.from("remote document"), canonicalPath: "/remote/AGENTS.md" };
        });
      }
      release = registerAgentWorkspaceAccess(tempDir, { bridge });
      try {
        await expect(loadBootstrap(tempDir)).rejects.toThrow(
          missingProvenance
            ? "Workspace bootstrap source identity is unavailable"
            : /Workspace access/,
        );
        if (missingProvenance) {
          expect(readFile).not.toHaveBeenCalled();
          expect(stat).not.toHaveBeenCalled();
        }
      } finally {
        release();
      }
    },
  );

  it("marks oversized bootstrap files unreadable and warns with the bounded-read reason", async () => {
    const tempDir = await workspace({
      "AGENTS.md": "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1),
    });
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    const warn = captureWarningLogger();

    const files = await loadBootstrap(tempDir);
    const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
    const warningText = warn.mock.calls.flat().map(String).join("\n");

    expect(agents).toMatchObject({
      missing: false,
      content: `[UNREADABLE: File exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes]`,
    });
    if (!agents) {
      throw new Error("expected AGENTS.md bootstrap record");
    }
    expect(buildBootstrapContextFiles([agents])).toEqual([
      { path: agentsPath, content: agents.content },
    ]);
    expect(warningText).toContain(agentsPath);
    expect(warningText).toContain(`File exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes`);
  });
});

const mockFiles = (
  ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md"] as const
).map((name) => bootstrapFile(name));

it("carries canonical source identity through extra-file conversion", async () => {
  const tempDir = await workspace({
    "MEMORY.md": "root memory",
    "packages/core/MEMORY.md": "nested memory",
  });
  const nestedDir = path.join(tempDir, "packages", "core");
  const rootAliasDir = path.join(tempDir, "root-memory-alias[1]");
  const nestedAliasDir = path.join(tempDir, "nested-memory-alias");
  await fs.symlink(tempDir, rootAliasDir, process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(nestedDir, nestedAliasDir, process.platform === "win32" ? "junction" : "dir");

  const rootMemory = (await loadBootstrap(tempDir)).find(
    (file) => file.name === DEFAULT_MEMORY_FILENAME,
  );
  const { files: aliases } = await loadExtra(tempDir, [
    path.relative(tempDir, path.join(rootAliasDir, DEFAULT_MEMORY_FILENAME)),
    path.relative(tempDir, path.join(nestedAliasDir, DEFAULT_MEMORY_FILENAME)),
  ]);
  const rootAlias = aliases.find((file) => file.path.startsWith(rootAliasDir));
  const nestedAlias = aliases.find((file) => file.path.startsWith(nestedAliasDir));

  expect([rootMemory, rootAlias, nestedAlias]).not.toContain(undefined);
  expect(workspaceFilesShareSourceIdentity(rootMemory!, rootAlias!)).toBe(true);
  expect(workspaceFilesShareSourceIdentity(rootMemory!, nestedAlias!)).toBe(false);
});

describe("filterBootstrapFilesForSession privacy", () => {
  it("prefers authoritative chat type over the session-key fallback", () => {
    const shared = filterForSession(mockFiles, {
      sessionKey: "agent:default:opaque:binding",
      chatType: "group",
    });
    const direct = filterForSession(mockFiles, {
      sessionKey: "agent:default:discord:channel:c1",
      chatType: "direct",
    });

    expect(shared).toStrictEqual(mockFiles.filter((file) => file.name !== "MEMORY.md"));
    expect(direct).toStrictEqual(mockFiles);
  });

  it("drops root memory path aliases while preserving nested memory in shared sessions", () => {
    const rootMemoryAlias = bootstrapFile("SOUL.md", "/w/private/../MEMORY.md");
    const nestedMemory = bootstrapFile("MEMORY.md", "/w/packages/core/MEMORY.md");

    const result = filterForSession([rootMemoryAlias, nestedMemory], {
      sessionKey: "agent:default:opaque:binding",
      chatType: "channel",
      workspaceDir: "/w",
    });

    expect(result).toStrictEqual([nestedMemory]);
  });

  it.each([
    ["subagent", "agent:default:subagent:task-1", "AGENTS.md"],
    ["cron", "agent:default:cron:daily-check", "SOUL.md"],
  ] as const)(
    "drops root memory path aliases before the %s allowlist",
    (_mode, sessionKey, name) => {
      const allowedFile = mockFiles.find((file) => file.name === name)!;
      const rootMemoryAlias = bootstrapFile(name, "/w/MEMORY.md");

      const result = filterForSession([allowedFile, rootMemoryAlias], {
        sessionKey,
        workspaceDir: "/w",
      });

      expect(result).toStrictEqual([allowedFile]);
    },
  );
});

describe("loadExtraBootstrapFilesWithDiagnostics", () => {
  it("loads recognized bootstrap files from glob patterns", async () => {
    const workspaceDir = await workspace({
      "packages/core/SOUL.md": "soul",
      "packages/core/README.md": "not bootstrap",
    });
    const packageDir = path.join(workspaceDir, "packages", "core");

    const { files } = await loadExtra(workspaceDir, ["./packages/*/*"]);

    expect(files).toStrictEqual([
      bootstrapFile("SOUL.md", path.join(packageDir, "SOUL.md"), "soul"),
    ]);
  });

  it("keeps path-traversal attempts outside workspace excluded", async () => {
    const rootDir = await workspace({ "outside/AGENTS.md": "outside" });
    const workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const { files } = await loadExtra(workspaceDir, ["../outside/AGENTS.md"]);

    expect(files).toHaveLength(0);
  });

  it.runIf(process.platform !== "win32")(
    "falls back to a shallow scan without entering unrelated unreadable branches",
    async () => {
      const workspaceDir = await workspace({
        "packages/blocked/node_modules/private/AGENTS.md": "irrelevant",
        "packages/readable/AGENTS.md": "readable",
      });
      const privateDir = path.join(workspaceDir, "packages", "blocked", "node_modules", "private");
      const readableDir = path.join(workspaceDir, "packages", "readable");
      await fs.chmod(privateDir, 0o000);
      const glob = vi.spyOn(fs, "glob").mockImplementation(() => {
        throw new Error("native glob failed");
      });
      const readDirectory = vi.spyOn(fs, "readdir");
      try {
        const result = await loadExtra(workspaceDir, ["packages/*/AGENTS.md"]);
        expect(result).toMatchObject({
          diagnostics: [],
          files: [{ path: path.join(readableDir, "AGENTS.md") }],
        });
        expect(readDirectory).not.toHaveBeenCalledWith(privateDir, expect.anything());
      } finally {
        readDirectory.mockRestore();
        glob.mockRestore();
        await fs.chmod(privateDir, 0o700);
      }
    },
  );
});
