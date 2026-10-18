import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ClawHubSkillVerificationResponse } from "../infra/clawhub-skills.js";
import { registerSkillsCli } from "./skills-cli.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = vi.hoisted(() => {
  const runtimeStdout: string[] = [];
  const runtimeErrors: string[] = [];
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn((value: unknown) => {
      runtimeErrors.push(String(value));
    }),
    writeStdout: vi.fn((value: string) => {
      runtimeStdout.push(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      runtimeStdout.push(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    defaultRuntime,
    runtimeStdout,
    runtimeErrors,
    workspaceDir: "",
    verify: vi.fn(),
    card: vi.fn(),
    noopAsync: vi.fn(),
  };
});

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("./one-shot-exit.js", () => ({
  exitCliAfterOutput: (runtime: typeof mocks.defaultRuntime, exitCode: number) =>
    runtime.exit(exitCode),
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  CONFIG_DIR: "/tmp/openclaw-config",
}));

// mock-isolation: Skill verification uses an empty fixture config and isolated workspace.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  loadConfig: () => ({}),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveConfiguredAgentId: (_config: unknown, agentId: string) => agentId,
  resolveAgentIdByWorkspacePath: () => undefined,
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
}));

vi.mock("../infra/clawhub-skills.js", () => ({
  CLAWHUB_SKILLS_SH_REF_PREFIX: "skills-sh:",
  CLAWHUB_SKILLS_SH_TRUST_LABEL: "Not scanned by ClawHub",
  CLAWHUB_SKILLS_SH_TRUST_STATE: "not-scanned-by-clawhub",
  fetchClawHubSkillCard: mocks.card,
  fetchClawHubSkillDetail: mocks.noopAsync,
  fetchClawHubSkillVerification: mocks.verify,
  searchClawHubSkills: mocks.noopAsync,
}));

vi.mock("../infra/clawhub-artifacts.js", () => ({
  downloadClawHubSkillArchive: mocks.noopAsync,
}));

vi.mock("../infra/clawhub-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-client.js")>()),
  resolveClawHubBaseUrl: (baseUrl?: string) =>
    (baseUrl ?? "https://clawhub.ai").replace(/\/+$/, ""),
}));

const { ClawHubRequestError } = await import("../infra/clawhub-client.js");

describe("skills verify CLI", () => {
  beforeEach(() => {
    mocks.runtimeStdout.length = 0;
    mocks.runtimeErrors.length = 0;
    mocks.workspaceDir = tempDirs.make("openclaw-skill-verify-cli-");
    mocks.verify.mockReset();
    mocks.card.mockReset();
    for (const mock of Object.values(mocks.defaultRuntime)) {
      mock.mockClear();
    }
  });

  async function runCommand(...argv: string[]) {
    const program = new Command().exitOverride();
    registerSkillsCli(program);
    await program.parseAsync(["skills", "verify", ...argv], { from: "user" });
  }

  function payload(): {
    ok?: boolean;
    openclaw?: { trust?: { state?: string; label?: string }; verifiedSourceUrl?: string };
    artifact?: unknown;
  } {
    return JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}");
  }
  function expectSuccess() {
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.runtimeErrors).toStrictEqual([]);
  }
  function expectVerification(options: Record<string, unknown>) {
    expect(mocks.verify).toHaveBeenCalledWith({
      version: undefined,
      tag: undefined,
      baseUrl: "https://private.example.com/clawhub",
      ...options,
    });
  }

  function mockVerification(overrides: Partial<ClawHubSkillVerificationResponse> = {}) {
    mocks.verify.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "agentreceipt" },
      publisher: { handle: "openclaw" },
      version: { version: "1.0.0" },
      card: { available: true },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
      ...overrides,
    });
  }

  async function writeInstalledSkill(slug: string, requestedReference?: string) {
    const skillDir = path.join(mocks.workspaceDir, "skills", slug);
    const metadata = {
      version: 1,
      registry: "https://private.example.com/clawhub",
      slug,
      installedVersion: requestedReference ? "a".repeat(40) : "1.2.3",
      installedAt: 123,
      ...(requestedReference ? { requestedReference, trustState: "not-scanned-by-clawhub" } : {}),
    };
    await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${slug}\n`);
    await fs.writeFile(path.join(skillDir, ".clawhub", "origin.json"), JSON.stringify(metadata));
    await fs.mkdir(path.join(mocks.workspaceDir, ".clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(mocks.workspaceDir, ".clawhub", "lock.json"),
      JSON.stringify({
        version: 1,
        skills: { [slug]: { ...metadata, version: metadata.installedVersion } },
      }),
    );
    return skillDir;
  }

  it("verifies an installed skills.sh skill by its exact reference without a version selector", async () => {
    const requestedReference = "skills-sh:patrick-erichsen/skills/html";
    await writeInstalledSkill("html", requestedReference);
    mockVerification({
      decision: "unscanned",
      reasons: ["security.not_scanned_by_clawhub"],
      skill: { slug: "html" },
      publisher: { handle: "patrick-erichsen" },
      version: { version: "a".repeat(40) },
      security: { status: "not-scanned", passed: false },
    });

    await expect(runCommand(requestedReference)).rejects.toThrow("__exit__:1");

    expectVerification({ slug: "html", requestedReference });
    expect(payload().openclaw?.trust).toEqual({
      state: "not-scanned-by-clawhub",
      label: "Not scanned by ClawHub",
    });
  });

  it("rejects an installed skills.sh reference from another owner in JSON", async () => {
    await writeInstalledSkill("html", "skills-sh:owner-a/repo-a/html");
    await expect(runCommand("skills-sh:owner-b/repo-b/html", "--json")).rejects.toThrow(
      "__exit__:1",
    );
    expect(payload()).toEqual({
      ok: false,
      error: {
        type: "cli_error",
        message: 'Skill "html" is not tracked from skills-sh:owner-b/repo-b/html.',
      },
    });
    expect(mocks.runtimeErrors).toStrictEqual([]);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("reports workspace resolution exceptions as JSON", async () => {
    await expect(runCommand("weather", "--agent", " ")).rejects.toThrow("__exit__:1");
    expect(payload()).toEqual({
      ok: false,
      error: { type: "cli_error", message: "--agent must not be blank" },
    });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("maps registry failures to a human domain error without leaking upstream details", async () => {
    mocks.verify.mockRejectedValueOnce(
      new ClawHubRequestError({
        path: "/api/v1/skills/nonexistent-skill-xyz/verify",
        status: 404,
        body: "remote-controlled not-found detail",
      }),
    );
    await expect(runCommand("nonexistent-skill-xyz", "--card")).rejects.toThrow("__exit__:1");
    expect(mocks.runtimeStdout).toStrictEqual([]);
    expect(mocks.runtimeErrors).toStrictEqual([
      'Skill "nonexistent-skill-xyz" not found on ClawHub. Run `openclaw skills search nonexistent-skill-xyz` to find the right skill reference.',
    ]);
    expect(mocks.runtimeErrors.join("\n")).not.toMatch(/\/api\/v1\/|\(404\)|remote-controlled/u);
  });

  it("does not reject an installed bundle just because ClawHub generated skill-card.md", async () => {
    const skillDir = await writeInstalledSkill("agentreceipt");
    await fs.writeFile(
      path.join(skillDir, "skill-card.md"),
      "# Generated Skill Card\nClawHub bundle metadata.\n",
    );
    mockVerification({
      provenance: {
        source: "server-resolved-github-import",
        kind: "github",
        url: "https://github.com/openclaw/skills/tree/main/agentreceipt",
        repo: "openclaw/skills",
        ref: "main",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "agentreceipt",
      },
      version: { version: "1.2.3" },
      artifact: {
        sourceFingerprint: "publisher-source-fingerprint-without-generated-card",
        bundleFingerprints: ["generated-bundle-fingerprint-with-skill-card"],
      },
    });

    await runCommand("agentreceipt", "--json");

    expectVerification({ slug: "agentreceipt", version: "1.2.3" });
    const result = payload();
    expect(result.ok).toBe(true);
    expect(result.openclaw).toMatchObject({
      verifiedSourceUrl:
        "https://github.com/openclaw/skills/tree/0123456789abcdef0123456789abcdef01234567/agentreceipt",
    });
    expect(result.artifact).toEqual({
      sourceFingerprint: "publisher-source-fingerprint-without-generated-card",
      bundleFingerprints: ["generated-bundle-fingerprint-with-skill-card"],
    });
    expectSuccess();
  });

  it("prints cards for owner-qualified tag verification", async () => {
    mockVerification({
      skill: { slug: "weather" },
      publisher: { handle: "demo-owner" },
      version: { version: "2.0.0" },
      card: {
        available: true,
        url: "https://cards.example.test/generated/weather.md",
      },
    });
    mocks.card.mockResolvedValueOnce("# Weather\n");

    await runCommand("@demo-owner/weather", "--tag", "latest", "--card");

    expectVerification({
      slug: "weather",
      ownerHandle: "demo-owner",
      tag: "latest",
      baseUrl: "https://clawhub.ai",
    });
    expect(mocks.card).toHaveBeenCalledWith({
      url: "https://cards.example.test/generated/weather.md",
      baseUrl: "https://clawhub.ai",
    });
    expect(mocks.runtimeStdout.at(-1)).toBe("# Weather");
    expectSuccess();
  });

  it("does not promote unavailable provenance URLs in verify JSON", async () => {
    mockVerification({
      provenance: {
        source: "unavailable",
        url: "https://github.com/openclaw/skills/tree/unverified/agentreceipt",
      },
    });

    await runCommand("agentreceipt");

    expect(payload().openclaw?.verifiedSourceUrl).toBeUndefined();
    expectSuccess();
  });
});
