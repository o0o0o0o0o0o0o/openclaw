// Preserve mock setup before modules that consume it.
// oxfmt-ignore
import { channelTurnMocks } from "./run-channel-turn.test-support.js";
import { vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";

export function resetTurnState() {
  vi.clearAllMocks();
  outboundMessageIdentities.clear();
  resetDiagnosticEventsForTest();
  resetLogger();
  setLoggerOverride({ level: "info" });
  channelTurnMocks.createMessageSentEmitter.mockImplementation(() => ({
    emitMessageSent: channelTurnMocks.emitMessageSent,
    hasMessageSentHooks: true,
  }));
  channelTurnMocks.getGlobalHookRunner.mockReturnValue(null);
}

export function resetTurnLogger() {
  setLoggerOverride(null);
  resetLogger();
}
