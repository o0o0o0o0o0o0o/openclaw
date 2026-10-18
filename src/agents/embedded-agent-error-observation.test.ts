import { afterEach, describe, expect, it, vi } from "vitest";
import * as loggingConfigModule from "../logging/config.js";
import { sanitizeForConsole } from "./console-sanitize.js";
import {
  buildApiErrorObservationFields,
  buildTextObservationFields,
} from "./embedded-agent-error-observation.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function expectRequestRedacted(raw: string, requestId: string, preview: string) {
  const observed = buildApiErrorObservationFields(raw);
  expect(observed.rawErrorPreview).toContain(preview);
  expect(observed.rawErrorPreview).not.toContain(requestId);
  expect(observed.rawErrorFingerprint?.startsWith("sha256:")).toBe(true);
  expect(observed.requestIdHash?.startsWith("sha256:")).toBe(true);
  return observed;
}

describe("buildApiErrorObservationFields", () => {
  it("redacts request ids and exposes stable hashes instead of raw payloads", () => {
    const observed = expectRequestRedacted(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_overload"}',
      "req_overload",
      '"request_id":"sha256:',
    );

    expect(observed.rawErrorHash?.startsWith("sha256:")).toBe(true);
    expect(observed).toMatchObject({
      providerRuntimeFailureKind: "timeout",
      providerErrorType: "overloaded_error",
      providerErrorMessagePreview: "Overloaded",
    });
  });

  it("forces token redaction for observation previews", () => {
    const observed = buildApiErrorObservationFields(
      `Authorization: Bearer ${OBSERVATION_BEARER_TOKEN}`,
    );

    expect(observed.rawErrorPreview).not.toContain(OBSERVATION_BEARER_TOKEN);
    expect(observed.rawErrorHash).toMatch(/^sha256:/);
  });

  it("redacts observation-only header and cookie formats", () => {
    const observed = buildApiErrorObservationFields(
      `x-api-key: ${OBSERVATION_BEARER_TOKEN} Cookie: session=${OBSERVATION_COOKIE_VALUE}`,
    );

    expect(observed.rawErrorPreview).not.toContain(OBSERVATION_COOKIE_VALUE);
    expect(observed.rawErrorPreview).toContain("x-api-key: ***");
    expect(observed.rawErrorPreview).toContain("Cookie: session=");
  });

  it("masks a bare pass: credential in the provider message preview", () => {
    const observed = buildApiErrorObservationFields(
      '{"error":{"type":"invalid_request","message":"pass: opaque-pass-secret-1234567890 rejected"}}',
    );
    expect(observed.providerErrorMessagePreview).toBe("pass: opaque…7890 rejected");
  });

  it("redacts provider error types as well as message previews", () => {
    const observed = buildApiErrorObservationFields(
      '{"error":{"type":"x-api-key: sk-redact-test-token","message":"Request failed"}}',
    );
    expect(observed.providerErrorType).toBe("x-api-key: ***");
  });

  it("does not let cookie redaction consume unrelated fields on the same line", () => {
    const observed = buildApiErrorObservationFields(
      "Cookie: session=session-cookie-token status=503 request_id=req_cookie",
    );

    expect(observed.rawErrorPreview).toContain("Cookie: session=");
    expect(observed.rawErrorPreview).toContain("status=503");
    expect(observed.rawErrorPreview).toContain("request_id=sha256:");
  });

  it("builds sanitized generic text observation fields", () => {
    const observed = buildTextObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_prev"}',
    );

    expect(observed.textPreview).toContain('"request_id":"sha256:');
    expect(observed.textHash?.startsWith("sha256:")).toBe(true);
    expect(observed.textFingerprint?.startsWith("sha256:")).toBe(true);
    expect(observed.providerRuntimeFailureKind).toBe("timeout");
    expect(observed.providerErrorType).toBe("overloaded_error");
    expect(observed.providerErrorMessagePreview).toBe("Overloaded");
    expect(observed.requestIdHash?.startsWith("sha256:")).toBe(true);
    expect(observed.textPreview).not.toContain("req_prev");
  });

  it("redacts request ids in formatted plain-text errors", () => {
    expectRequestRedacted(
      "LLM error overloaded_error: Overloaded (request_id: req_plaintext_123)",
      "req_plaintext_123",
      "request_id: sha256:",
    );
  });

  it("keeps fingerprints stable across request ids for equivalent errors", () => {
    // Fingerprints intentionally ignore request ids, while raw hashes keep the
    // exact sanitized payload distinct.
    const first = buildApiErrorObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_001"}',
    );
    const second = buildApiErrorObservationFields(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_002"}',
    );

    expect(first.rawErrorFingerprint).toBe(second.rawErrorFingerprint);
    expect(first.rawErrorHash).not.toBe(second.rawErrorHash);
  });

  it("truncates oversized raw and provider previews", () => {
    const longMessage = `${"X".repeat(199)}🚀tail`;
    const observed = buildApiErrorObservationFields(
      `{"type":"error","error":{"type":"server_error","message":"${longMessage}"},"request_id":"req_long"}`,
    );

    expect(observed.rawErrorPreview).toBeTypeOf("string");
    expect(observed.providerErrorMessagePreview).toBe(`${"X".repeat(199)}…`);
    expect(observed.rawErrorPreview?.length).toBeLessThanOrEqual(401);
    expect(observed.providerErrorMessagePreview?.length).toBeLessThanOrEqual(201);
    expect(observed.providerErrorMessagePreview?.endsWith("…")).toBe(true);
  });

  it("caps oversized raw inputs before hashing and fingerprinting", () => {
    const bounded = "X".repeat(63_999);
    const observed = buildApiErrorObservationFields(`${bounded}🚀tail`);
    const boundedObserved = buildApiErrorObservationFields(bounded);
    expect(observed.rawErrorHash).toBe(boundedObserved.rawErrorHash);
    expect(observed.rawErrorFingerprint).toBe(boundedObserved.rawErrorFingerprint);
  });

  it("keeps fingerprint message bounds on a UTF-16 boundary", () => {
    const prefix = "X".repeat(7_999);
    const observed = buildApiErrorObservationFields(
      JSON.stringify({
        type: "error",
        error: { type: "server_error", message: `${prefix}🚀tail` },
      }),
    );
    const boundedObserved = buildApiErrorObservationFields(
      JSON.stringify({ type: "error", error: { type: "server_error", message: prefix } }),
    );

    expect(observed.rawErrorFingerprint).toBe(boundedObserved.rawErrorFingerprint);
  });

  it("returns empty observation fields for empty input", () => {
    expect(buildApiErrorObservationFields(undefined)).toStrictEqual({});
    expect(buildApiErrorObservationFields("")).toStrictEqual({});
    expect(buildApiErrorObservationFields("   ")).toStrictEqual({});
  });

  it("re-reads configured redact patterns on each call", () => {
    const readLoggingConfig = vi.spyOn(loggingConfigModule, "readLoggingConfig");
    readLoggingConfig.mockReturnValueOnce(undefined);
    readLoggingConfig.mockReturnValueOnce({
      redactPatterns: [String.raw`\bcustom-secret-[A-Za-z0-9]+\b`],
    });

    const first = buildApiErrorObservationFields("custom-secret-abc123");
    const second = buildApiErrorObservationFields("custom-secret-abc123");

    expect(first.rawErrorPreview).toContain("custom-secret-abc123");
    expect(second.rawErrorPreview).not.toContain("custom-secret-abc123");
    expect(second.rawErrorPreview).toContain("custom");
  });

  it("fails closed when observation sanitization throws", () => {
    vi.spyOn(loggingConfigModule, "readLoggingConfig").mockImplementation(() => {
      throw new Error("boom");
    });

    expect(buildApiErrorObservationFields("request_id=req_123")).toStrictEqual({});
    expect(buildTextObservationFields("request_id=req_123")).toEqual({
      textPreview: undefined,
      textHash: undefined,
      textFingerprint: undefined,
      httpCode: undefined,
      providerRuntimeFailureKind: undefined,
      providerErrorType: undefined,
      providerErrorMessagePreview: undefined,
      requestIdHash: undefined,
    });
  });

  it("ignores non-string configured redact patterns", () => {
    vi.spyOn(loggingConfigModule, "readLoggingConfig").mockReturnValue({
      redactPatterns: [
        123 as never,
        { bad: true } as never,
        String.raw`\bcustom-secret-[A-Za-z0-9]+\b`,
      ],
    });

    const observed = buildApiErrorObservationFields("custom-secret-abc123");

    expect(observed.rawErrorPreview).not.toContain("custom-secret-abc123");
    expect(observed.rawErrorPreview).toContain("custom");
  });

  it("keeps provider-less missing-scope auth payloads out of the codex-specific scope lane", () => {
    const observed = buildApiErrorObservationFields(
      '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}',
    );

    expect(observed.httpCode).toBe("401");
    expect(observed.providerRuntimeFailureKind).toBe("unclassified");
  });
});

describe("sanitizeForConsole", () => {
  it("strips control characters from console-facing values", () => {
    expect(sanitizeForConsole("run-1\nprovider\tmodel\rtest")).toBe("run-1 provider model test");
  });
});
