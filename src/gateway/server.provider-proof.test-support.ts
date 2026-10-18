import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";

export async function startProofProvider(
  onRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  const server = createServer((request, response) => {
    void onRequest(request, response).catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : undefined),
    );
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await promisify(server.close.bind(server))();
    },
  };
}

export function writeProofToolCall(
  response: ServerResponse,
  item: { id: string; arguments: string; status?: string } & Record<string, unknown>,
  responseId: string,
  argumentEvent: "done" | "delta",
  tokens = 1,
) {
  const indexed = { output_index: 0 };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      ...indexed,
      item: { ...item, ...(item.status ? { status: "in_progress" } : {}), arguments: "" },
    },
    {
      type: `response.function_call_arguments.${argumentEvent}`,
      ...indexed,
      item_id: item.id,
      [argumentEvent === "done" ? "arguments" : "delta"]: item.arguments,
    },
    { type: "response.output_item.done", ...indexed, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [item],
        usage: { input_tokens: tokens, output_tokens: tokens, total_tokens: 2 * tokens },
      },
    },
  ]);
}
