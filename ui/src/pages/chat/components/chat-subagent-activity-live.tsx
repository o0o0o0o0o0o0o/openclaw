import { createSignal, onSettled } from "solid-js";
import type { SessionObserverDigest } from "../../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayEventFrame } from "../../../api/gateway.ts";
import { pickFreshestObserverDigest } from "../../../lib/observer-digest.ts";
import { isSessionObserverDigest } from "../../../lib/protocol-validators.generated/activity.js";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeAgentId,
  resolveUiSessionRowAgentId,
} from "../../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import type { ChatSubagentActivity as ChatSubagentActivityRow } from "../chat-subagent-wait.ts";
import { SubagentActivity, type SubagentActivityProps } from "./chat-subagent-activity.ts";

function matchesRun(row: ChatSubagentActivityRow, digest: SessionObserverDigest): boolean {
  const session = row.session;
  return (
    row.status === "running" &&
    areUiSessionKeysEquivalent(row.key, digest.sessionKey) &&
    typeof digest.runId === "string" &&
    session.activeRunIds?.includes(digest.runId) === true &&
    (!digest.agentId ||
      normalizeAgentId(digest.agentId) === resolveUiSessionRowAgentId(session, "")) &&
    (!digest.sessionId || digest.sessionId === session.sessionId) &&
    (!digest.lifecycleRevision || digest.lifecycleRevision === session.lifecycleRevision)
  );
}

/** A view cache of the broad session observer stream, not a child-history subscriber. */
function SubagentActivityLive(props: SubagentActivityProps) {
  const context = useOptionalApplication();
  // The cache retains only digests belonging to the currently displayed runs.
  const [digests, setDigests] = createSignal<Map<string, SessionObserverDigest>>(
    (previous = new Map()) => {
      const rows = props.rows;
      return new Map(
        [...previous].filter(([key, digest]) =>
          rows.some((row) => row.key === key && matchesRun(row, digest)),
        ),
      );
    },
  );
  onSettled(() => {
    if (!context) {
      return undefined;
    }
    const gateway = context.gateway;
    let connection = gateway.snapshot.hello;
    // Clear prior-connection digests before the next observer frame can be accepted.
    const unsubscribe = gateway.subscribe(() => {
      if (connection !== gateway.snapshot.hello) {
        connection = gateway.snapshot.hello;
        setDigests(new Map());
      }
    });
    function onSessionObserver(event: GatewayEventFrame) {
      if (
        event.event !== "session.observer" ||
        !connection ||
        connection !== gateway.snapshot.hello ||
        !isSessionObserverDigest(event.payload)
      ) {
        return;
      }
      const digest = event.payload;
      const row = props.rows.find((candidate) => matchesRun(candidate, digest));
      if (!row) {
        return;
      }
      setDigests((previous) =>
        pickFreshestObserverDigest(previous.get(row.key), digest) === digest
          ? new Map(previous).set(row.key, digest)
          : previous,
      );
    }
    const unsubscribeEvents = gateway.subscribeEvents(onSessionObserver);
    return () => {
      unsubscribe();
      unsubscribeEvents();
    };
  });
  const rows = () => {
    const liveDigests = digests();
    return props.rows.map((row) => {
      const live = liveDigests.get(row.key);
      if (!live || !matchesRun(row, live)) {
        return row;
      }
      const stored = row.session.observerDigest;
      const digest = pickFreshestObserverDigest(
        live,
        stored?.runId === live.runId ? stored : undefined,
      );
      return {
        ...row,
        activity: digest?.headline.trim() || undefined,
        // Session rows omit plan steps, so only a winning live digest carries them.
        progress: digest === live && live.planProgress?.total ? live.planProgress : undefined,
      };
    });
  };
  return <SubagentActivity {...props} rows={rows()} />;
}

export const ChatSubagentActivity = defineSolidBridge<SubagentActivityProps>(
  "openclaw-chat-subagent-activity",
  (props) => <SubagentActivityLive {...props} />,
  {
    properties: {
      rows: { default: [], attribute: false },
      compact: { default: false },
      limit: { default: undefined, attribute: false },
      turnStartedAt: { default: undefined, attribute: false },
      onOpenSubagent: { default: undefined, attribute: false },
      onOpenSession: { default: undefined, attribute: false },
    },
    connected: (host) => {
      host.style.display = "contents";
    },
  },
);
type ChatSubagentActivityElement = SolidBridgeElement<SubagentActivityProps>;

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-subagent-activity": HTMLAttributes<ChatSubagentActivityElement> &
        Properties<ChatSubagentActivityElement> & {
          "prop:rows"?: SubagentActivityProps["rows"];
          "prop:compact"?: SubagentActivityProps["compact"];
          "prop:limit"?: SubagentActivityProps["limit"];
          "prop:turnStartedAt"?: SubagentActivityProps["turnStartedAt"];
          "prop:onOpenSubagent"?: SubagentActivityProps["onOpenSubagent"];
          "prop:onOpenSession"?: SubagentActivityProps["onOpenSession"];
        };
    }
  }
}
