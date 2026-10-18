import { createServer, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { channelAvatarRevision } from "./channel-avatar-reference.js";
import { buildControlUiChannelAvatarUrl } from "./control-ui-contract.js";
import { finishFailedGatewayHttpResponse } from "./http-common.js";
import { HTTP_IMAGE_MAX_BYTES } from "./http-image-response.js";
import { APNG_BYTES } from "./http-image.test-support.js";
import { bindHttpResponseAuthority } from "./http-request-authority.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadEntry: vi.fn(),
  resolveReference: vi.fn(),
  readMedia: vi.fn(),
}));

vi.mock("./http-utils.js", () => ({
  authorizeControlUiSessionOwnerReadRequestOrReply: mocks.authorize,
}));

// mock-isolation: avatar HTTP tests use request-local config without loading operator state.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));

// mock-isolation: avatar authorization tests supply session ownership without a database worker.
vi.mock("./session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: mocks.loadEntry,
}));

vi.mock("../media/media-reference.js", () => ({
  resolveInboundMediaReference: mocks.resolveReference,
}));

vi.mock("../media/store.js", () => ({ readMediaBuffer: mocks.readMedia }));

const { handleChannelAvatarHttpRequest } = await import("./channel-avatar-http.js");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const AVATAR_REFERENCE = "/state/media/inbound/channel-avatar.png";

function avatarEntry(
  reference = AVATAR_REFERENCE,
  origin: { provider?: string; accountId?: string; from?: string; chatType?: "direct" } = {},
) {
  return {
    delivery: {
      kind: "external" as const,
      route: { channel: "discord", target: { to: "user:1" } },
      context: { channel: "discord", to: "user:1" },
      origin: { provider: "discord", to: "user:1", avatar: reference, ...origin },
    },
  };
}

function holdMediaRead(release = createDeferredCore()) {
  const reading = createDeferredCore();
  mocks.readMedia.mockImplementationOnce(async () => {
    reading.resolve();
    await release.promise;
    return { buffer: PNG_BYTES };
  });
  return { reading, release };
}

async function read(url: string | URL, init?: RequestInit) {
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

describe("handleChannelAvatarHttpRequest", () => {
  let baseUrl: string;
  let server: ReturnType<typeof createServer>;
  let authorityCurrent = true;

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handleChannelAvatarHttpRequest(req, res, {
        auth: { mode: "token", token: "test-token", allowTailscale: false },
      })
        .then((handled) => {
          if (!handled) {
            res.statusCode = 418;
            res.end("unhandled");
          }
        })
        .catch(() => finishFailedGatewayHttpResponse(res));
    });
    baseUrl = await listenLoopback(server);
  });

  afterAll(() => closeHttpServer(server));

  afterEach(() => {
    memorySessionActorOwners.reset();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    authorityCurrent = true;
    mocks.authorize
      .mockReset()
      .mockImplementation(({ res }: { res: ServerResponse }) =>
        bindHttpResponseAuthority(
          { authMethod: "token", operatorScopes: ["operator.admin", "operator.read"] },
          res,
          () => authorityCurrent,
        ),
      );
    mocks.loadEntry.mockReset().mockResolvedValue({ entry: avatarEntry() });
    mocks.resolveReference.mockReset().mockResolvedValue({ id: "channel-avatar.png" });
    mocks.readMedia.mockReset().mockResolvedValue({ buffer: PNG_BYTES });
  });

  const avatarRoute = (sessionKey: string) =>
    `${baseUrl}${buildControlUiChannelAvatarUrl("", sessionKey, "test-revision")}`;

  it("serves current memory avatars and refuses bytes after the captured owner closes", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/channel-avatar");
    const owner = memorySessionActorOwners.get({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    const sessionKey = "agent:main:dashboard:incognito-avatar";
    const authority = { assertCurrent() {}, authorize() {} };
    const actor = await owner.acquire(
      { sessionKey, database: owner.identity },
      { assertCurrent() {}, assertReadable() {} },
    );
    const release = createDeferredCore();
    let pending: ReturnType<typeof read> | undefined;
    try {
      const entry = { ...avatarEntry(), sessionId: "private", updatedAt: 1, incognito: true };
      const created = await actor.storage!.mutate(
        { type: "session.entry.create", input: { entry } },
        authority,
      );
      expect(created.kind).toBe("committed");
      expect((await read(avatarRoute(sessionKey))).body).toEqual(PNG_BYTES);
      expect(mocks.loadEntry).not.toHaveBeenCalled();
      const next = avatarEntry("/state/media/inbound/private-2.png");
      const patched = await actor.storage!.mutate(
        {
          type: "session.entry.patch",
          input: { operation: { kind: "fields", patch: next } },
        },
        authority,
      );
      expect(patched.kind).toBe("committed");
      const { reading } = holdMediaRead(release);
      pending = read(avatarRoute(sessionKey));
      await reading.promise;
      memorySessionActorOwners.closeDatabase(owner);
      release.resolve();
      const response = await pending;
      expect(response.status).not.toBe(200);
      expect(response.headers["content-type"]).not.toBe("image/png");
    } finally {
      release.resolve();
      await pending;
      await actor.release();
    }
  });

  it("binds transcript avatar bytes to the exact native sender and media snapshot", async () => {
    mocks.loadEntry.mockReturnValue({
      entry: avatarEntry(AVATAR_REFERENCE, {
        provider: "telegram",
        accountId: "sample-bot",
        from: "telegram:1000000001",
        chatType: "direct",
      }),
    });
    const url = new URL(avatarRoute("agent:main:portrait-binding"));
    url.search = new URLSearchParams({
      v: channelAvatarRevision(AVATAR_REFERENCE),
      provider: "telegram",
      account: "sample-bot",
      sender: "1000000001",
    }).toString();
    expect((await fetch(url)).status).toBe(200);
    const reads = mocks.readMedia.mock.calls.length;
    for (const [key, value] of [
      ["sender", "1000000002"],
      ["account", "another-bot"],
      ["provider", "slack"],
      ["v", "stale-revision"],
    ] as const) {
      const stale = new URL(url);
      stale.searchParams.set(key, value);
      expect((await fetch(stale)).status).toBe(404);
    }
    expect(mocks.readMedia).toHaveBeenCalledTimes(reads);
  });

  it("rejects revoked authority while channel avatar bytes are loading", async () => {
    const { reading, release } = holdMediaRead();

    const pending = read(avatarRoute("agent:main:revoked"));
    await reading.promise;
    authorityCurrent = false;
    release.resolve();

    const response = await pending;
    expect(response.status).toBe(401);
    expect(response.headers.etag).toBeUndefined();
    expect(JSON.parse(response.body.toString())).toEqual({
      error: { message: "Unauthorized", type: "unauthorized" },
    });
  });

  it.each([
    { label: "PNG", buffer: PNG_BYTES },
    { label: "APNG", buffer: APNG_BYTES },
  ])(
    "serves and revalidates cached conversation $label bytes with sandboxed headers",
    async ({ label, buffer }) => {
      mocks.readMedia.mockResolvedValue({ buffer });
      const route = avatarRoute(`agent:main:discord:direct:${label}`);
      const response = await read(route);
      expect(response.body).toEqual(buffer);
      expect(response.status).toBe(200);
      expect(response.headers).toMatchObject({
        "content-type": "image/png",
        "content-length": String(buffer.byteLength),
        "cache-control": "private, max-age=3600",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
        "content-disposition": 'attachment; filename="channel-avatar"',
      });
      expect(response.headers["content-security-policy"]).toContain("sandbox");
      expect(mocks.resolveReference).toHaveBeenCalledWith(AVATAR_REFERENCE);
      expect(mocks.readMedia).toHaveBeenCalledWith(
        "channel-avatar.png",
        "inbound",
        HTTP_IMAGE_MAX_BYTES,
      );
      const etag = response.headers.etag;
      const revalidated = await read(route, { headers: { "If-None-Match": etag ?? "" } });
      expect(etag).toBeTruthy();
      expect(revalidated.status).toBe(304);
      expect(revalidated.body).toEqual(Buffer.alloc(0));
      expect(mocks.readMedia).toHaveBeenCalledTimes(1);
    },
  );

  it("shares one cold load across concurrent GET and HEAD requests", async () => {
    const arrived = createDeferredCore();
    const { release } = holdMediaRead();
    let readers = 0;
    mocks.loadEntry.mockImplementation(() => {
      if (++readers === 10) {
        arrived.resolve();
      }
      return { entry: avatarEntry() };
    });
    const requests = Array.from({ length: 10 }, (_, index) =>
      read(avatarRoute("agent:main:concurrent"), { method: index % 2 ? "HEAD" : "GET" }),
    );
    await arrived.promise;
    release.resolve();
    const responses = await Promise.all(requests);
    const etag = responses[0]?.headers.etag;
    expect(etag).toBeTruthy();
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(200);
      expect(response.headers).toMatchObject({
        etag,
        "content-type": "image/png",
        "content-length": String(PNG_BYTES.byteLength),
      });
      expect(response.body).toEqual(index % 2 ? Buffer.alloc(0) : PNG_BYTES);
    }
    expect(mocks.resolveReference).toHaveBeenCalledTimes(1);
    expect(mocks.readMedia).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", () => mocks.resolveReference.mockResolvedValueOnce(null)],
    ["failed", () => mocks.readMedia.mockRejectedValueOnce(new Error("media unavailable"))],
    [
      "invalid",
      () => mocks.readMedia.mockResolvedValueOnce({ buffer: Buffer.from("not an image") }),
    ],
  ] as const)("retries an avatar after a %s load settles", async (failure, failLoad) => {
    failLoad();
    const route = avatarRoute(`agent:main:recover:${failure}`);
    expect(await read(route)).toMatchObject({
      status: 404,
      headers: { "cache-control": "no-store" },
    });
    const recovered = await read(route);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toEqual(PNG_BYTES);
    expect(mocks.resolveReference).toHaveBeenCalledTimes(2);
  });

  it("releases superseded avatars without evicting another session's cached image", async () => {
    await read(avatarRoute("agent:main:stable-avatar"));

    for (let revision = 0; revision < 130; revision++) {
      const reference = `/state/media/inbound/rotating-avatar-${revision}.png`;
      const buffer = Buffer.concat([PNG_BYTES, Buffer.from(String(revision))]);
      mocks.loadEntry.mockReturnValue({ entry: avatarEntry(reference) });
      mocks.readMedia.mockResolvedValue({ buffer });
      expect((await read(avatarRoute("agent:main:rotating-avatar"))).body).toEqual(buffer);
    }

    mocks.loadEntry.mockReturnValue({ entry: avatarEntry() });
    mocks.readMedia.mockResolvedValue({ buffer: PNG_BYTES });
    const readsBeforeRevisit = mocks.readMedia.mock.calls.length;
    expect((await read(avatarRoute("agent:main:stable-avatar"))).body).toEqual(PNG_BYTES);
    expect(mocks.readMedia).toHaveBeenCalledTimes(readsBeforeRevisit);
  });

  it.each([
    ["agent:main:missing", undefined, false],
    ["agent:main:no-avatar", avatarEntry(""), false],
    ["/__openclaw__/channel-avatar/", avatarEntry(), true],
    ["/__openclaw__/channel-avatar/a/b", avatarEntry(), true],
  ] as const)("returns an uncacheable 404 for %s", async (route, entry, malformed) => {
    mocks.loadEntry.mockReturnValue({ entry });

    expect(await read(malformed ? `${baseUrl}${route}` : avatarRoute(route))).toMatchObject({
      status: 404,
      headers: { "cache-control": "no-store" },
    });
    expect(mocks.resolveReference).not.toHaveBeenCalled();
    if (malformed) {
      expect(mocks.loadEntry).not.toHaveBeenCalled();
    }
  });

  it("never reads session or media state when authentication or owner access is denied", async () => {
    for (const statusCode of [401, 403]) {
      mocks.authorize.mockImplementation(async ({ res }: { res: ServerResponse }) => {
        res.statusCode = statusCode;
        res.end();
        return null;
      });
      const response = await fetch(avatarRoute("agent:main:hidden"));
      expect(response.status).toBe(statusCode);
      expect(mocks.loadEntry).not.toHaveBeenCalled();
      expect(mocks.resolveReference).not.toHaveBeenCalled();
    }
  });

  it("rejects non-read methods and leaves unrelated paths unhandled", async () => {
    expect(await read(avatarRoute("agent:main:one"), { method: "POST" })).toMatchObject({
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
    expect((await read(`${baseUrl}/__openclaw__/workspace-icon/one`)).status).toBe(418);
  });
});
