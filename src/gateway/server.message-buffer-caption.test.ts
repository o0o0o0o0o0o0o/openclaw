import fs from "node:fs/promises";
import path from "node:path";
import { json } from "node:stream/consumers";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import type {
  ArtifactsDownloadResult,
  ArtifactsListResult,
} from "../../packages/gateway-protocol/src/schema/artifacts.js";
import { createOpenAiResponsesModelConfig } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { startProofProvider, writeProofToolCall } from "./server.provider-proof.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import {
  configureManualGatewayBackgroundEnv,
  MANUAL_GATEWAY_ENV_KEYS,
} from "./test-helpers.manual-gateway-env.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const attachment = Buffer.from("current-source attachment");
const ordinaryCaption = "Attached proof.";
const internalCaption =
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const deliveryCaption =
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.";

it(
  "chat.send publishes sanitized message buffers through history and authorized artifacts.download",
  { timeout: 180_000 },
  async () => {
    const root = tempDirs.make("openclaw-message-buffer-");
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    await Promise.all([state, workspace].map((directory) => fs.mkdir(directory)));
    const explicitBytes = Buffer.from("explicit source wins");
    const explicitMedia = path.join(workspace, "explicit.txt");
    const deniedMedia = path.join(root, "private.txt");
    await fs.writeFile(explicitMedia, explicitBytes);
    await fs.writeFile(deniedMedia, "private file");
    type Scenario = {
      name: string;
      caption: string;
      buffer?: string;
      media?: string;
      expected: "attachment" | "suppressed" | "error" | "text";
      error?: RegExp;
      bytes?: Buffer;
      finalText?: string;
    };
    const makeScenario = (
      name: string,
      expected: Scenario["expected"],
      fields: Partial<Scenario> = {},
    ): Scenario => ({ name, expected, caption: internalCaption, ...fields });
    const data = { buffer: attachment.toString("base64"), bytes: attachment };
    const buffered = (name: string, caption: string) =>
      makeScenario(name, "attachment", { caption, ...data });
    const cases: [Scenario, ...Scenario[]] = [
      buffered("ordinary", ordinaryCaption),
      buffered("internal-context", internalCaption),
      buffered("delivery-metadata", deliveryCaption),
      ...[undefined, "", "  "].map((buffer, index) =>
        makeScenario(`empty-${index}`, "suppressed", {
          buffer,
          finalText: "No attachment was provided, so nothing was sent.",
        }),
      ),
      makeScenario("text-only", "text", { caption: ordinaryCaption }),
      makeScenario("invalid", "error", {
        buffer: "%%%",
        error: /invalid base64 data/,
        finalText: "The attachment data is invalid, so it was not sent.",
      }),
      makeScenario("oversized", "error", {
        caption: deliveryCaption,
        buffer: Buffer.alloc(2048).toString("base64"),
        error: /Media too large/,
        finalText: "The attachment exceeds the size limit, so it was not sent.",
      }),
      makeScenario("explicit", "attachment", {
        buffer: "%%%",
        media: explicitMedia,
        bytes: explicitBytes,
      }),
      makeScenario("denied", "error", {
        media: deniedMedia,
        error: /allowed directory|could not be staged/,
        finalText: "The attachment could not be accessed, so it was not sent.",
      }),
    ];
    const configPath = path.join(state, "openclaw.json");
    const environment = {
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
    };
    const snapshot = captureEnv([...MANUAL_GATEWAY_ENV_KEYS, ...Object.keys(environment)]);
    configureManualGatewayBackgroundEnv(root);
    for (const [key, value] of Object.entries(environment)) {
      setTestEnvValue(key, value);
    }
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("dist/extensions"));
    let selected = cases[0];
    let requests: Array<Record<string, unknown>> = [];
    const primaryRequests = () => requests.filter((request) => request.model === "buffer-proof");
    let provider: Awaited<ReturnType<typeof startProofProvider>> | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      provider = await startProofProvider(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body: unknown = await json(request);
        if (!isRecord(body)) {
          throw new Error("Invalid completion request");
        }
        requests.push(body);
        const summary = body.model !== "buffer-proof";
        if (!summary && primaryRequests().length === 1) {
          const item = {
            type: "function_call",
            id: `fc_${selected.name}`,
            call_id: `call_${selected.name}`,
            name: "message",
            arguments: JSON.stringify({
              action: "send",
              message: selected.caption,
              buffer: selected.buffer,
              media: selected.media,
              filename: "proof.txt",
              contentType: "text/plain",
            }),
            status: "completed",
          };
          writeProofToolCall(response, item, `response_${selected.name}`, "done", 10);
          return;
        }
        writeOpenAiResponsesText(response, {
          text: summary ? "Attachment requested." : (selected.finalText ?? "NO_REPLY"),
          messageId: `${summary ? "summary" : "msg"}_${selected.name}`,
          responseId: `${summary ? "summary_response" : "final"}_${selected.name}`,
        });
      });
      const fixture = createOpenAiResponsesModelConfig({
        baseUrl: provider.baseUrl,
        providerId: "openai",
        modelId: "buffer-proof",
        reasoning: false,
        toolProfile: "messaging",
      });
      const modelProvider = fixture.models!.providers!.openai;
      modelProvider.apiKey = "test";
      for (const model of modelProvider.models!) {
        model.contextWindow = 16000;
        model.maxTokens = 256;
      }
      gateway = await startGatewayWithClient({
        cfg: {
          ...fixture,
          agents: {
            defaults: {
              ...fixture.agents!.defaults,
              heartbeat: undefined,
              workspace,
              mediaMaxMb: 1 / 1024,
              model: { primary: "openai/buffer-proof", fallbacks: [] },
            },
            entries: { main: {} },
          },
          tools: { profile: "messaging", toolSearch: false },
          plugins: {
            allow: ["openai"],
            slots: { memory: "none" },
            entries: { openai: { enabled: true } },
          },
          logging: { file: path.join(root, "gateway.log") },
        },
        configPath,
        token: "buffer-proof-token",
      });
      const client = gateway.client;
      const wait = (runId: string) =>
        client.request<{ status: string }>(
          "agent.wait",
          { runId, timeoutMs: 60_000 },
          { timeoutMs: 65_000 },
        );
      const artifacts = (sessionKey: string) =>
        client.request<ArtifactsListResult>("artifacts.list", {
          sessionKey,
          messageRole: "assistant",
        });
      const send = (sessionKey: string, name: string) =>
        client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message: "Send the attachment in this conversation.",
          idempotencyKey: `buffer-${name}`,
        });
      for (const scenario of cases) {
        const check = (value: unknown) => expect.soft(value, scenario.name);
        selected = scenario;
        requests = [];
        const sessionKey = `agent:main:buffer-${scenario.name}`;
        const started = await send(sessionKey, scenario.name);
        const completed = await wait(started.runId);
        const history = await gateway.client.request<{ messages: Array<Record<string, unknown>> }>(
          "chat.history",
          { sessionKey, limit: 20 },
        );
        const listed = await artifacts(sessionKey);
        const visibleText = history.messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter(isRecord)
          .filter((block) => block.type === "text")
          .map((block) => block.text);
        const expectedText =
          scenario.name === "ordinary" || scenario.expected === "text" ? [scenario.caption] : [];
        if (scenario.finalText) {
          expectedText.push(scenario.finalText);
        }
        check(visibleText).toEqual(expectedText);
        const toolResults = history.messages.filter((message) => message.role === "toolResult");
        check(toolResults).toHaveLength(1);
        if (scenario.error) {
          check(toolResults[0]).toMatchObject({ isError: true });
          check(JSON.stringify(toolResults)).toMatch(scenario.error);
        }
        if (scenario.expected === "suppressed") {
          check(JSON.stringify(toolResults)).toContain("internal_runtime_context_echo");
        }
        check(completed.status).toBe("ok");
        check(listed.artifacts).toHaveLength(scenario.expected === "attachment" ? 1 : 0);
        for (const artifact of listed.artifacts) {
          const downloaded = await gateway.client.request<ArtifactsDownloadResult>(
            "artifacts.download",
            { sessionKey, artifactId: artifact.id },
          );
          check(downloaded.artifact).toMatchObject({
            mimeType: "text/plain",
            title: "proof.txt",
          });
          if (!downloaded.url) {
            throw new Error("Managed artifact URL missing");
          }
          const response = await fetch(new URL(downloaded.url, `http://127.0.0.1:${gateway.port}`));
          expect(response.ok).toBe(true);
          check(Buffer.from(await response.arrayBuffer())).toEqual(scenario.bytes);
        }
        const primaryCount = primaryRequests().length;
        const replay = await send(sessionKey, scenario.name);
        expect(replay.runId).toBe(started.runId);
        await wait(replay.runId);
        expect(await artifacts(sessionKey)).toEqual(listed);
        expect(primaryRequests()).toHaveLength(primaryCount);
      }
    } finally {
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close();
        }
      } finally {
        try {
          await provider?.close();
        } finally {
          snapshot.restore();
          clearRuntimeConfigSnapshot();
          clearConfigCache();
          clearSessionStoreCacheForTest();
        }
      }
    }
  },
);
