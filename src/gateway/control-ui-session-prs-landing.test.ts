import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as worktreeGit from "../agents/worktrees/git.js";
import { resolveBranchLanding } from "./control-ui-session-prs-landing.js";

const execFileAsync = promisify(execFile);

describe("resolveBranchLanding", () => {
  let root: string;

  const git = (...args: string[]) =>
    execFileAsync("git", ["-c", "user.email=test@openclaw.ai", "-c", "user.name=Test", ...args], {
      cwd: root,
    });
  const sha = async (ref: string) => (await git("rev-parse", ref)).stdout.trim();
  const land = (mergedHeads: Parameters<typeof resolveBranchLanding>[1]["mergedHeads"] = []) =>
    resolveBranchLanding(root, { branch: "feature", defaultBranch: "main", mergedHeads });
  const commitFile = async (file: string, text: string, message: string, append = false) => {
    await (append ? fs.appendFile : fs.writeFile)(path.join(root, file), text);
    await git("add", file);
    await git("commit", "-m", message);
  };
  const feature = async () => {
    await git("checkout", "-b", "feature");
    await commitFile("a.txt", "two\n", "feature work", true);
  };
  const expectedLanding = (base: string, pushedSha: string | null = null) => ({
    complete: true,
    pushedSha,
    defaultSha: base,
    statsBase: base,
    hasLandedPullRequest: false,
    provenNewPushedWork: false,
  });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prs-landing-")));
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    { scenario: "an unrelated descendant ref", mergedHeads: [], descendantRef: true },
    {
      scenario: "a merge into another base without a propagation commit",
      mergedHeads: [{ sha: "1".repeat(40), baseRef: "release" }],
      descendantRef: false,
    },
    {
      scenario: "an unavailable merged head",
      mergedHeads: [{ sha: "1".repeat(40), baseRef: "main" }],
      descendantRef: false,
      expected: { complete: false, hasLandedPullRequest: true },
    },
  ])(
    "resolves an unpublished branch with $scenario against captured revisions",
    async ({
      mergedHeads,
      descendantRef,
      expected = { complete: true, hasLandedPullRequest: false },
    }) => {
      const base = await sha("HEAD");
      await git("checkout", "-b", "feature");
      await fs.appendFile(path.join(root, "a.txt"), "two\n");
      await git("commit", "-am", "unpublished work");
      if (descendantRef) {
        await git("update-ref", "refs/remotes/origin/feature/child", "HEAD");
      }
      expect(await land(mergedHeads)).toEqual({ ...expectedLanding(base), ...expected });
    },
  );

  it.each(["malformed selected", "missing selected object"])(
    "preserves readable revisions with a %s ref without fetching objects",
    async (scenario) => {
      const base = await sha("HEAD");
      const missingObject = "1".repeat(base.length);
      const missingSelectedObject = scenario === "missing selected object";
      await fs.writeFile(
        path.join(root, ".git", "refs", "remotes", "origin", "feature"),
        `${missingSelectedObject ? missingObject : "not-an-object-id"}\n`,
      );
      await git("config", "extensions.partialClone", "origin");
      await git("config", "remote.origin.promisor", "true");
      await git("config", "remote.origin.url", path.join(root, "missing-remote"));
      const tracePath = path.join(root, "git-trace.jsonl");
      vi.stubEnv("GIT_TRACE2_EVENT", tracePath);
      try {
        await expect(land()).resolves.toEqual({
          ...expectedLanding(base),
          pushedSha: missingSelectedObject ? missingObject : null,
        });
        const trace = await fs.readFile(tracePath, "utf8");
        expect(trace.split("\n").filter((line) => line.includes('"event":"child_start"'))).toEqual(
          [],
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("preserves complete revisions when a batch exceeds its output limit", async () => {
    const base = await sha("HEAD");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const runGit = worktreeGit.runGit;
    vi.spyOn(worktreeGit, "runGit").mockImplementationOnce(async (...args) => ({
      ...(await runGit(...args)),
      stdout: "truncated ref output",
      stdoutTruncatedBytes: 1,
    }));
    await expect(land()).resolves.toEqual(expectedLanding(base, base));
  });

  it("marks a squash-landed tip and bases stats on the merged head", async () => {
    await feature();
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const mergedHead = await sha("HEAD");

    const landing = await land([{ sha: mergedHead, baseRef: "main" }]);

    expect(landing).toEqual({
      complete: true,
      pushedSha: mergedHead,
      defaultSha: await sha("refs/remotes/origin/main"),
      statsBase: mergedHead,
      hasLandedPullRequest: true,
      provenNewPushedWork: false,
    });
  });

  it.each(["duplicate", "distinct"])(
    "checks %s landing receipts per unique head",
    async (scenario) => {
      const base = await sha("HEAD");
      await feature();
      const mergedHead = await sha("HEAD");
      await git("checkout", "main");
      await commitFile("a.txt", "two\n", "squash land", true);
      const mergeCommit = await sha("HEAD");
      // A reset of main can land the same head without incorporating the older merge.
      const otherMerge =
        scenario === "distinct"
          ? (
              await git(
                "commit-tree",
                (await git("write-tree")).stdout.trim(),
                "-p",
                base,
                "-m",
                "another landing",
              )
            ).stdout.trim()
          : mergeCommit;
      await git("update-ref", "refs/remotes/origin/main", "HEAD");
      await git("checkout", "feature");
      await git("reset", "--hard", "refs/remotes/origin/main");
      await commitFile("b.txt", "second\n", "second PR work");
      await git("update-ref", "refs/remotes/origin/feature", "HEAD");
      const head = await sha("HEAD");
      const runGit = vi.spyOn(worktreeGit, "runGit");
      const landedHead = { sha: mergedHead, baseRef: "main", mergeCommitSha: mergeCommit };

      const landing = await land([landedHead, { ...landedHead, mergeCommitSha: otherMerge }]);

      expect(landing.provenNewPushedWork).toBe(scenario !== "distinct");
      // The first squash remains the baseline even when another landing is missing.
      expect(landing.statsBase).toBe(mergeCommit);
      expect(
        runGit.mock.calls.filter(
          ([, args]) =>
            args[0] === "merge-base" &&
            args[1] === "--is-ancestor" &&
            args[2] === mergedHead &&
            args[3] === head,
        ),
      ).toHaveLength(1);
    },
  );

  it("selects the newest of three related baselines via the batched path", async () => {
    // Linear chain: fork point (merge base) -> merged head 1 -> merged head 2
    // -> HEAD; the maximal published baseline is merged head 2.
    const base = await sha("HEAD");
    await git("checkout", "-b", "feature");
    await commitFile("a.txt", "two\n", "pr1 work", true);
    const head1 = await sha("HEAD");
    await commitFile("a.txt", "three\n", "pr2 work", true);
    const head2 = await sha("HEAD");
    await commitFile("c.txt", "wip\n", "follow-up");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const runGit = vi.spyOn(worktreeGit, "runGit");

    const landing = await land([
      { sha: head1, baseRef: "main" },
      { sha: head2, baseRef: "main" },
    ]);

    expect(landing.statsBase).toBe(head2);
    expect(landing.hasLandedPullRequest).toBe(true);
    expect(runGit).not.toHaveBeenCalledWith(root, ["merge-base", "--is-ancestor", base, head2]);
  });
});
