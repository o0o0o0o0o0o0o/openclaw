// Pairing CLI tests cover pairing command registration and pairing status output.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { runWithLocalStateOwner } from "./local-state-owner.js";
import { registerPairingCli } from "./pairing-cli.js";

const mocks = vi.hoisted(() => ({
  runWithLocalStateOwner: vi.fn<typeof runWithLocalStateOwner>(),
  listChannelPairingRequests: vi.fn(),
  approveChannelPairingCode: vi.fn(),
  notifyPairingApproved: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
  replaceConfigFile: vi.fn(),
  normalizeChannelId: vi.fn((raw: string) => {
    if (!raw) {
      return null;
    }
    if (raw === "imsg") {
      return "imessage";
    }
    if (["telegram", "discord", "imessage"].includes(raw)) {
      return raw;
    }
    return null;
  }),
  getPairingAdapter: vi.fn((channel: string) => ({
    idLabel: pairingIdLabels[channel] ?? "userId",
  })),
  listPairingChannels: vi.fn(() => ["telegram", "discord", "imessage"]),
}));

const {
  listChannelPairingRequests,
  approveChannelPairingCode,
  notifyPairingApproved,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
  listPairingChannels,
} = mocks;

const pairingIdLabels: Record<string, string> = {
  telegram: "telegramUserId",
  discord: "discordUserId",
};

function configSnapshot(ownerAllowFrom?: string[]) {
  const config = ownerAllowFrom ? { commands: { ownerAllowFrom } } : {};
  return {
    snapshot: {
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      issues: [],
      legacyIssues: [],
      sourceConfig: config,
      runtimeConfig: config,
    },
    writeOptions: {},
  };
}

vi.mock("../pairing/pairing-store.js", () => ({
  listChannelPairingRequests: mocks.listChannelPairingRequests,
  approveChannelPairingCode: mocks.approveChannelPairingCode,
}));

vi.mock("./local-state-owner.js", () => ({
  runWithLocalStateOwner: mocks.runWithLocalStateOwner,
}));

vi.mock("../channels/plugins/pairing.js", () => ({
  listPairingChannels: mocks.listPairingChannels,
  notifyPairingApproved: mocks.notifyPairingApproved,
  getPairingAdapter: mocks.getPairingAdapter,
}));

vi.mock("../channels/plugins/index.js", () => ({
  normalizeChannelId: mocks.normalizeChannelId,
}));

// mock-isolation: Pairing command fixtures own empty config and intercepted config writes.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn().mockReturnValue({}),
  loadConfig: vi.fn().mockReturnValue({}),
  captureRuntimeConfigAsyncReader: () => async () => ({}),
  readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
  replaceConfigFile: mocks.replaceConfigFile,
}));

describe("pairing cli", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runWithLocalStateOwner.mockReset().mockImplementation(async ({ runLocal }) =>
      runLocal({
        env: process.env,
        config: {},
        signal: new AbortController().signal,
        assertCurrent() {},
      }),
    );
    listChannelPairingRequests.mockResolvedValue([]);
    approveChannelPairingCode.mockResolvedValue({
      id: "123",
      entry: {
        id: "123",
        code: "ABCDEFGH",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
      },
    });
    readConfigFileSnapshotForWrite.mockResolvedValue(configSnapshot());
    replaceConfigFile.mockResolvedValue(undefined);
    notifyPairingApproved.mockResolvedValue(undefined);
  });

  async function runPairing(command: "list" | "approve", ...args: string[]) {
    const program = new Command();
    program.name("test");
    registerPairingCli(program);
    await program.parseAsync(["pairing", command, ...args], { from: "user" });
  }

  it("labels sender ids using the channel's pairing adapter", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    listChannelPairingRequests.mockResolvedValueOnce([
      {
        id: "123",
        code: "ABC123",
        createdAt: "2026-01-08T00:00:00Z",
        lastSeenAt: "2026-01-08T00:00:00Z",
        meta: { username: "peter" },
      },
    ]);

    await runPairing("list", "--channel", "telegram");
    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("telegramUserId");
    expect(output).toContain("123");
  });

  it("rejects conflicting positional and option channels for list", async () => {
    await expect(runPairing("list", "discord", "--channel", "telegram")).rejects.toThrow(
      'Conflicting pairing channels: "telegram" and "discord". Pass the channel either positionally or with --channel.',
    );

    expect(listChannelPairingRequests).not.toHaveBeenCalled();
  });

  it("forwards --account for list", async () => {
    await runPairing("list", "--channel", "telegram", "--account", "yy");

    expect(listChannelPairingRequests).toHaveBeenCalledWith(
      "telegram",
      process.env,
      "yy",
      expect.any(Function),
    );
  });

  it("defaults list to the sole available channel", async () => {
    listPairingChannels.mockReturnValueOnce(["slack"]);
    await runPairing("list");

    expect(listChannelPairingRequests).toHaveBeenCalledWith(
      "slack",
      process.env,
      undefined,
      expect.any(Function),
    );
  });

  it("redirects to openclaw devices when no pairing channels are configured", async () => {
    listPairingChannels.mockReturnValueOnce([]);

    const error = await runPairing("list").then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("openclaw devices");
    // Must not leak the empty enum that originally read like a bug.
    expect(message).not.toContain("expected one of: )");
    expect(message).not.toContain("()");
    expect(listChannelPairingRequests).not.toHaveBeenCalled();
  });

  it("lists supported channels when one is required but omitted", async () => {
    // Multiple channels configured (default mock) + no channel argument.
    await expect(runPairing("list")).rejects.toThrow(
      "expected one of: telegram, discord, imessage",
    );
  });

  it("accepts channel as positional for approve (npm-run compatible)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runPairing("approve", "telegram", "ABCDEFGH");

    expect(approveChannelPairingCode).toHaveBeenCalledWith({
      channel: "telegram",
      code: "ABCDEFGH",
      env: process.env,
      assertCurrent: expect.any(Function),
    });
    expect(replaceConfigFile.mock.calls[0]?.[0]).toMatchObject({
      sourceConfig: { commands: { ownerAllowFrom: ["telegram:123"] } },
    });
    expect(log.mock.calls).toEqual([
      [`${theme.success("Approved")} ${theme.muted("telegram")} sender ${theme.command("123")}.`],
      [
        `${theme.success("Command owner configured")} ${theme.command("telegram:123")} ${theme.muted("(commands.ownerAllowFrom was empty).")}`,
      ],
    ]);
  });

  it("does not overwrite an existing command owner when approving pairing", async () => {
    readConfigFileSnapshotForWrite.mockResolvedValueOnce(configSnapshot(["discord:999"]));

    await runPairing("approve", "telegram", "ABCDEFGH");

    expect(replaceConfigFile).not.toHaveBeenCalled();
  });

  it("forwards --account for approve", async () => {
    await runPairing("approve", "--channel", "telegram", "--account", "yy", "ABCDEFGH");

    expect(approveChannelPairingCode).toHaveBeenCalledWith({
      channel: "telegram",
      code: "ABCDEFGH",
      accountId: "yy",
      env: process.env,
      assertCurrent: expect.any(Function),
    });
  });

  it("rejects a whitespace-only --account for approve", async () => {
    await expect(
      runPairing("approve", "--channel", "telegram", "--account", "   ", "ABCDEFGH"),
    ).rejects.toThrow("--account must not be blank");

    expect(approveChannelPairingCode).not.toHaveBeenCalled();
    expect(readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(replaceConfigFile).not.toHaveBeenCalled();
  });

  it("defaults approve to the sole available channel when only code is provided", async () => {
    listPairingChannels.mockReturnValueOnce(["slack"]);

    await runPairing("approve", "ABCDEFGH");

    expect(approveChannelPairingCode).toHaveBeenCalledWith({
      channel: "slack",
      code: "ABCDEFGH",
      env: process.env,
      assertCurrent: expect.any(Function),
    });
  });

  it("keeps approve usage error when multiple channels exist and channel is omitted", async () => {
    await expect(runPairing("approve", "ABCDEFGH")).rejects.toThrow("Usage:");
  });

  it.each(["OUTCOME_UNKNOWN"])(
    "does not bootstrap, notify, or approve locally after %s",
    async (reason) => {
      mocks.runWithLocalStateOwner.mockRejectedValueOnce(new Error(reason));

      await expect(runPairing("approve", "telegram", "ABCDEFGH", "--notify")).rejects.toThrow(
        reason,
      );

      expect(approveChannelPairingCode).not.toHaveBeenCalled();
      expect(replaceConfigFile).not.toHaveBeenCalled();
      expect(notifyPairingApproved).not.toHaveBeenCalled();
    },
  );
});
