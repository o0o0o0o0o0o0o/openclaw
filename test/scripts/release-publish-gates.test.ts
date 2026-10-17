import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateReleaseBootstrapGate,
  evaluateReleasePublishGates,
} from "../../scripts/lib/release-publish-gates.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { expectGate } from "./release-publish.test-support.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const targetSha = "a".repeat(40);
const manifest = {
  workflowName: "Full Release Validation",
  targetSha,
  releaseProfile: "stable",
  rerunGroup: "all",
  runReleaseSoak: "true",
  controls: { performanceBlocking: true },
  childRuns: { productPerformance: { conclusion: "success" } },
  validationInputs: { coveragePolicy: "full" },
};
type GateInput = Parameters<typeof evaluateReleasePublishGates>[0];
function evaluate(changes: Record<string, unknown> = {}, input: Partial<GateInput> = {}) {
  return evaluateReleasePublishGates({
    manifest: { ...manifest, ...changes },
    releaseTag: "v2026.9.5",
    npmDistTag: "latest",
    consumer: "publisher",
    ...input,
  });
}
const failureIds = (gates: ReturnType<typeof evaluate>) =>
  gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id);
it.each([
  { releaseTag: "v2026.9.5-alpha.1", npmDistTag: "beta" },
  { releaseTag: "v2026.9.5", npmDistTag: "alpha" },
])("rejects retired alpha gate input %j", (input) => {
  expectGate(evaluate({}, input), {
    status: "FAIL",
    message: "Alpha releases are retired; use a beta prerelease instead.",
  });
});

describe("release publication control admission", () => {
  it("rejects stable bootstrap approval that cannot cover the candidate package version", () => {
    const input = {
      releaseTag: "v2026.9.5",
      publishTag: "latest",
      releaseProfile: "stable",
      packageVersion: "2026.9.4",
    };
    expect(evaluateReleaseBootstrapGate(input).status).toBe("FAIL");
  });

  it.each([
    { name: "stable evidence", overrides: {}, failures: [] },
    {
      name: "waived advisory and soak",
      overrides: { controls: { performanceBlocking: false }, runReleaseSoak: "false" },
      waiver: "2026.9.5 Approved after infrastructure failure",
      failures: ["performance", "soak"],
    },
    {
      name: "missing performance evidence",
      overrides: { controls: {}, childRuns: {} },
      failures: ["performance"],
    },
  ])("evaluates every publication consumer for $name", ({ overrides, waiver, failures }) => {
    for (const consumer of ["publisher", "core-npm", "stable-closeout"] as const) {
      const gates = evaluate(overrides, {
        consumer,
        ...(waiver ? { stableSoakWaiver: waiver } : {}),
        expectedSha: targetSha,
      });
      expect(failureIds(gates)).toEqual(failures.map((id) => `${consumer}.${id}`));
    }
  });

  it("does not require deferred performance for beta tags published to beta", () => {
    const changes = {
      releaseProfile: "beta",
      controls: { performanceBlocking: false },
      childRuns: {},
    };
    for (const consumer of ["publisher", "core-npm"] as const) {
      expect(
        failureIds(
          evaluate(changes, {
            releaseTag: "v2026.9.5-beta.1",
            npmDistTag: "beta",
            consumer,
          }),
        ),
      ).toEqual([]);
    }
  });

  it("retains strict stable closeout soak evidence", () => {
    expect(failureIds(evaluate({ runReleaseSoak: true }))).toEqual([]);
    expect(
      failureIds(evaluate({ runReleaseSoak: true }, { consumer: "stable-closeout" })),
    ).not.toEqual([]);
  });

  it("reports independent identity and policy failures together", () => {
    const gates = evaluate(
      {
        workflowName: "Other",
        targetSha: "b".repeat(40),
        rerunGroup: "performance",
        runReleaseSoak: "false",
      },
      {
        expectedSha: targetSha,
        expectedReleaseProfile: "full",
      },
    );
    expect(failureIds(gates)).toEqual([
      "publisher.workflow",
      "publisher.target",
      "publisher.profile",
      "publisher.rerun-group",
      "publisher.soak",
    ]);
  });

  it.each(["publisher", "core-npm", "stable-closeout"] as const)(
    "rejects beta evidence for stable publication at %s even with historical waiver inputs",
    (consumer) => {
      const historicalInput = {
        consumer,
        manifest: {
          ...manifest,
          releaseProfile: "beta",
          runReleaseSoak: "false",
          controls: { performanceBlocking: false },
        },
        stableSoakWaiver: "2026.9.5 approved",
        laneWaiver: "2026.9.5 approved",
        publishAcceptedWaivers: {
          stableSoakWaiver: "2026.9.5 approved",
          laneWaiver: "2026.9.5 approved",
        },
      };
      expect(failureIds(evaluate({}, historicalInput))).toEqual([
        `${consumer}.performance`,
        `${consumer}.stable-profile`,
        `${consumer}.soak`,
      ]);
    },
  );

  it.each([
    { validationInputs: { laneWaiver: "2026.9.5 approved" } },
    { publishInputs: { stableSoakWaiver: "2026.9.5 approved" } },
    { validationInputs: { knownFlakyJobsJson: '["checks-windows-node-test-2"]' } },
    { advisoryJobs: [{ child: "normalCi", job: "tests", conclusion: "failure" }] },
  ])("rejects recorded waiver or unclassified advisory evidence: %j", (recorded) => {
    for (const releaseTag of ["v2026.9.5", "v2026.9.5-beta.1"]) {
      const gates = evaluate(recorded, {
        releaseTag,
        npmDistTag: releaseTag.includes("beta") ? "beta" : "latest",
      });
      expectGate(gates, { id: "publisher.selected-lanes", status: "FAIL" });
    }
  });

  it("rejects failed Windows child evidence even when its retired advisory row is removed", () => {
    const gates = evaluate({
      childEvidence: {
        normalCi: {
          runId: "42",
          jobs: [
            { name: "checks-windows-node-test-2", status: "completed", conclusion: "failure" },
          ],
        },
      },
      advisoryJobs: [],
    });
    expectGate(gates, { id: "publisher.selected-lanes", status: "FAIL" });
  });

  it.each([false, true])(
    "runs without installed dependencies and never emits waiver authority (waived=%s)",
    (waived) => {
      const root = tempRoots.make("release-publish-gates-");
      const manifestPath = join(root, "manifest.json");
      const output = join(root, "output");
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          sourceAdmission: {
            validationPurpose: "publish",
            publicationSelection: { npmDistTag: "latest" },
            projection: { packages: [] },
          },
          publishInputs: {
            version: 1,
            targetSha,
            npmDistTag: "latest",
            pluginSdkApiEvidenceDigest: "a".repeat(64),
            pluginSdkApiAcknowledgement: "aaaaaaaa",
            npmDecisions: [],
            ...(waived ? { stableSoakWaiver: "2026.9.5 approved" } : {}),
          },
        }),
      );
      const script = resolve("scripts/lib/release-publish-gates.mts");
      const result = spawnSync(
        process.execPath,
        [script, "--consumer", "publisher", "--manifest", manifestPath],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            RELEASE_TAG: "v2026.9.5",
            RELEASE_NPM_DIST_TAG: "latest",
            EXPECTED_SHA: targetSha,
            EXPECTED_RELEASE_PROFILE: "from-validation",
            GITHUB_OUTPUT: output,
          },
        },
      );
      if (waived) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("waivers are no longer supported");
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(output, "utf8").split("\n")).toEqual([
          "plugin_sdk_api_acknowledgement=aaaaaaaa",
          "npm_decisions=[]",
          "release_profile=stable",
          "coverage_policy=full",
          "",
        ]);
      }
    },
  );
});
