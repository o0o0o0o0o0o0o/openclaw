import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { deleteSessionEntryLifecycle } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as gitWorker from "../infra/git-worker.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  githubJson,
  loadTestSessionPullRequests as loadPullRequests,
  pullListItem,
  requestUrl,
  testGitContext,
} from "./control-ui-session-prs.test-support.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils.js";

beforeEach(() => {
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

let state: OpenClawTestState;
const withState = (run: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
    state = fixture;
    try {
      await run();
    } finally {
      vi.useRealTimers();
    }
  });

function seedSession(
  sessionKey: string,
  entry: Parameters<typeof upsertSessionEntryCore>[1] = {},
  storePath?: string,
) {
  return upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId: sessionKey,
      updatedAt: 1,
      spawnedCwd: state.workspaceDir,
      ...entry,
    },
  );
}

function stubPulls(response: () => Response) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (!requestUrl(input).includes("/pulls?head=")) {
      throw new Error(`Unexpected request: ${requestUrl(input)}`);
    }
    return response();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const readWithGit = (sessionKey: string, resolveGitContext: () => Promise<typeof testGitContext>) =>
  loadPullRequests({ sessionKey }, { resolveGitContext });

function gatedRead(sessionKey: string, branch = testGitContext.branch) {
  const entered = createDeferred();
  const release = createDeferred();
  const load = () =>
    readWithGit(sessionKey, async () => {
      entered.resolve();
      await release.promise;
      return { ...testGitContext, branch };
    });
  const pending = load().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const ready = Promise.race([
    entered.promise,
    pending.then(() => {
      throw new Error("PR read settled before the Git-context barrier");
    }),
  ]);
  return { load, pending, ready, release };
}

it("marks retained PR data unavailable after a refresh fails, then recovers", async () => {
  await withState(async () => {
    await captureRuntimeConfigAsyncReader()();
    const sessionKey = "agent:main:stale-preview";
    await seedSession(sessionKey);
    vi.useFakeTimers();
    let failed = false;
    const fetchImpl = stubPulls(() =>
      failed
        ? githubJson({ message: "Unavailable" }, 503)
        : githubJson([pullListItem({ state: "closed", merged_at: "2026-09-01T00:00:00Z" })]),
    );
    const load = () =>
      readWithGit(sessionKey, async () => ({ ...testGitContext, branch: "stale-preview" }));
    const fresh = await load();
    expect(fresh.pullRequests[0]?.state).toBe("merged");
    failed = true;
    vi.advanceTimersByTime(91_000);
    const stale = await load();
    expect(stale).toMatchObject({
      pullRequests: fresh.pullRequests,
      status: "unavailable",
      rateLimited: false,
    });
    const calls = fetchImpl.mock.calls.length;
    expect(await load()).toEqual(stale);
    expect(fetchImpl.mock.calls).toHaveLength(calls);
    failed = false;
    vi.advanceTimersByTime(31_000);
    const recovered = await load();
    expect(recovered.status).not.toBe("unavailable");
    expect(recovered.pullRequests).toEqual(fresh.pullRequests);
  });
});

it.each(["replacement", "metadata"] as const)(
  "keeps PR reads and warm caches bound to the session across %s updates",
  async (change) => {
    await withState(async () => {
      await captureRuntimeConfigAsyncReader()();
      const replaced = change === "replacement";
      const owner = replaced ? ensureProfileForEmail("original-pr-reader@example.test") : undefined;
      const replacementOwner = replaced
        ? ensureProfileForEmail("replacement-pr-reader@example.test")
        : undefined;
      const sessionKey = `agent:main:${change}-pr-snapshot`;
      const scope = { agentId: "main", sessionKey };
      await seedSession(
        sessionKey,
        owner
          ? {
              visibility: "shared" as const,
              createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
            }
          : {},
      );
      let title = replaced ? "Retired session result" : "Current session result";
      const fetchImpl = stubPulls(() =>
        githubJson([pullListItem({ title, state: "closed", merged_at: "2026-09-01T00:00:00Z" })]),
      );
      const { load, pending, ready, release } = gatedRead(sessionKey, `${change}-pr-snapshot`);
      try {
        await ready;
        if (replacementOwner) {
          const original = await loadGatewaySessionEntryReadOnlyAsync(sessionKey, {
            agentId: "main",
          });
          await expect(
            deleteSessionEntryLifecycle({
              agentId: "main",
              storePath: original.storePath,
              target: { canonicalKey: original.canonicalKey, storeKeys: original.storeKeys },
              expectedSessionId: sessionKey,
              archiveTranscript: false,
            }),
          ).resolves.toMatchObject({ deleted: true });
          await seedSession(sessionKey, {
            sessionId: "replacement-pr-session",
            updatedAt: 2,
            visibility: "draft",
            createdActor: { type: "human", source: "profile", id: replacementOwner.id },
          });
        } else {
          await upsertSessionEntryCore(scope, { updatedAt: 2, label: "Still the same session" });
        }
        release.resolve();
        const result = await pending;
        expect.soft(result.ok).toBe(!replaced);
        if (replaced) {
          expect.soft(fetchImpl).not.toHaveBeenCalled();
          title = "Replacement session result";
        }
        const current = result.ok ? result.value : await load();
        expect(current.pullRequests[0]?.title).toBe(title);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(await load()).toEqual(current);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await pending;
      }
    });
  },
);

it("retires a repository-only target without falling back to its local workspace", async () => {
  await withState(async () => {
    await captureRuntimeConfigAsyncReader()();
    const sessionKey = "agent:main:repository-only";
    const repositories = getSessionRepositoryWorkspaceStore();
    const repository = await repositories.create({
      agentId: "main",
      sessionKey,
      url: "https://github.com/openclaw/openclaw",
      branch: "repository-only",
      assertCurrent: () => {},
    });
    await seedSession(sessionKey, { repositoryWorkspaceId: repository.workspaceId });
    const fetchImpl = stubPulls(() => githubJson([pullListItem({ state: "closed", head: {} })]));
    const git = vi.spyOn(gitWorker, "runGitWorkerOperation");
    try {
      const result = await loadPullRequests({ sessionKey });
      expect(result.pullRequests).toMatchObject([{ number: 103469, state: "closed" }]);
      expect(new URL(requestUrl(fetchImpl.mock.calls[0]?.[0])).searchParams.get("head")).toBe(
        "openclaw:repository-only",
      );
      expect(git).not.toHaveBeenCalled();
      const fetched = fetchImpl.mock.calls.length;
      await repositories.delete({ workspaceId: repository.workspaceId, assertCurrent: () => {} });
      expect(await loadPullRequests({ sessionKey })).toEqual({
        pullRequests: [],
        rateLimited: false,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(fetched);
      expect(git).not.toHaveBeenCalled();
    } finally {
      git.mockRestore();
    }
  });
});

it("discards pending PR work after same-file reopen even when persisted rows are identical", async () => {
  await withState(async () => {
    const sessionKey = "agent:main:physical-pr-source";
    const original = state.statePath("original", "sessions.sqlite");
    const aliasDirectory = state.statePath("selected");
    const alias = state.statePath("selected", "sessions.sqlite");
    await seedSession(sessionKey, {}, original);
    await closeOpenClawAgentDatabaseByPathAsync(original);
    fs.symlinkSync(state.statePath("original"), aliasDirectory, "junction");
    const cfg = {
      session: { store: alias },
      agents: { entries: { main: { workspace: state.workspaceDir } } },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);
    const { pending, ready, release } = gatedRead(sessionKey);
    try {
      await ready;
      await closeOpenClawAgentDatabaseByPathAsync(original);
      openOpenClawAgentDatabase({ agentId: "main", path: original });
      release.resolve();
      expect((await pending).ok).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending;
    }
  });
});
