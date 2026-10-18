import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import type {
  ArtifactsDownloadResult,
  ArtifactsListResult,
} from "../../packages/gateway-protocol/src/schema/artifacts.js";
import { createOpenAiResponsesModelConfig } from "../../test/helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const attachment = Buffer.from("current-source attachment");
const captionCases = [
  { name: "ordinary", caption: "Attached proof." },
  {
    name: "internal-context",
    caption:
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  },
  {
    name: "delivery-metadata",
    caption:
      "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
  },
] as const;

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
    ): Scenario => ({ name, expected, caption: captionCases[1].caption, ...fields });
    const data = { buffer: attachment.toString("base64"), bytes: attachment };
    const buffered = (caption: (typeof captionCases)[number]) =>
      makeScenario(caption.name, "attachment", { ...caption, ...data });
    const cases: [Scenario, ...Scenario[]] = [
      buffered(captionCases[0]),
      ...captionCases.slice(1).map(buffered),
      ...[undefined, "", "  "].map((buffer, index) =>
        makeScenario(`empty-${index}`, "suppressed", {
          buffer,
          finalText: "No attachment was provided, so nothing was sent.",
        }),
      ),
      makeScenario("text-only", "text", { caption: "Attached proof." }),
      makeScenario("invalid", "error", {
        buffer: "%%%",
        error: /invalid base64 data/,
        finalText: "The attachment data is invalid, so it was not sent.",
      }),
      makeScenario("oversized", "error", {
        caption: captionCases[2].caption,
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
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("dist/extensions"),
    };
    const snapshot = captureEnv(Object.keys(environment));
    for (const [key, value] of Object.entries(environment)) {
      setTestEnvValue(key, value);
    }
    let selected = cases[0];
    let requests: Array<Record<string, unknown>> = [];
    const primaryRequests = () => requests.filter((request) => request.model === "buffer-proof");
    const provider = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body: unknown = await json(request);
        if (!isRecord(body)) {
          throw new Error("Invalid completion request");
        }
        requests.push(body);
        if (body.model !== "buffer-proof") {
          writeOpenAiResponsesText(response, {
            text: "Attachment requested.",
            messageId: `summary_${selected.name}`,
            responseId: `summary_response_${selected.name}`,
          });
          return;
        }
        if (primaryRequests().length === 1) {
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
          writeOpenAiResponsesSse(response, [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", arguments: "" },
            },
            {
              type: "response.function_call_arguments.done",
              item_id: item.id,
              output_index: 0,
              arguments: item.arguments,
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: `response_${selected.name}`,
                status: "completed",
                output: [item],
                usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
              },
            },
          ]);
        } else {
          writeOpenAiResponsesText(response, {
            text: selected.finalText ?? "NO_REPLY",
            messageId: `msg_${selected.name}`,
            responseId: `final_${selected.name}`,
          });
        }
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const listening = createDeferred();
      provider.once("error", listening.reject);
      provider.listen(0, "127.0.0.1", listening.resolve);
      await listening.promise;
      const address = provider.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing completion endpoint address");
      }
      const { models } = createOpenAiResponsesModelConfig({
        baseUrl: `http://127.0.0.1:${address.port}`,
        providerId: "openai",
        modelId: "buffer-proof",
        reasoning: false,
        toolProfile: "messaging",
      });
      const modelProvider = models!.providers!.openai;
      modelProvider.apiKey = "test";
      for (const model of modelProvider.models!) {
        model.contextWindow = 16000;
        model.maxTokens = 256;
      }
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            defaults: {
              workspace,
              mediaMaxMb: 1 / 1024,
              skipBootstrap: true,
              skills: [],
              model: { primary: "openai/buffer-proof", fallbacks: [] },
              models: { "openai/buffer-proof": { agentRuntime: { id: "openclaw" } } },
            },
            entries: { main: {} },
          },
          models,
          // This provider scripts direct message calls to prove buffer handling, not discovery.
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
        expect.soft(visibleText, scenario.name).toEqual(expectedText);
        const toolResults = history.messages.filter((message) => message.role === "toolResult");
        expect.soft(toolResults, scenario.name).toHaveLength(1);
        if (scenario.error) {
          expect.soft(toolResults[0], scenario.name).toMatchObject({ isError: true });
          expect.soft(JSON.stringify(toolResults), scenario.name).toMatch(scenario.error);
        }
        if (scenario.expected === "suppressed") {
          expect
            .soft(JSON.stringify(toolResults), scenario.name)
            .toContain("internal_runtime_context_echo");
        }
        expect.soft(completed.status, scenario.name).toBe("ok");
        expect
          .soft(listed.artifacts, scenario.name)
          .toHaveLength(scenario.expected === "attachment" ? 1 : 0);
        for (const artifact of listed.artifacts) {
          const downloaded = await gateway.client.request<ArtifactsDownloadResult>(
            "artifacts.download",
            { sessionKey, artifactId: artifact.id },
          );
          expect.soft(downloaded.artifact, scenario.name).toMatchObject({
            mimeType: "text/plain",
            title: "proof.txt",
          });
          if (!downloaded.url) {
            throw new Error("Managed artifact URL missing");
          }
          const response = await fetch(new URL(downloaded.url, `http://127.0.0.1:${gateway.port}`));
          expect(response.ok).toBe(true);
          expect
            .soft(Buffer.from(await response.arrayBuffer()), scenario.name)
            .toEqual(scenario.bytes);
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
        provider.closeAllConnections();
        const closed = createDeferred();
        provider.close(() => closed.resolve());
        await closed.promise;
        snapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    }
  },
);
