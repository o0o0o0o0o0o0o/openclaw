import { expect } from "vitest";
import type {
  AgentDatabaseExecutionScope,
  OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution-contract.js";

type ExecutionModule = typeof import("../../state/openclaw-agent-execution.js");
type Decorate = (worker: AgentDatabaseExecutionScope) => AgentDatabaseExecutionScope;

export const bindingWrites = (queries: readonly string[]) =>
  queries.filter((sql) =>
    /\b(?:delete\s+from|insert(?:\s+or\s+\w+)?\s+into)\s+["`]?plugin_state_entries\b/i.test(sql),
  );

export function expectNoSql(queries: readonly string[], pattern: RegExp) {
  expect(queries.filter((query) => pattern.test(query))).toEqual([]);
}

export function wrapAgentExecution(
  owner: OpenClawAgentDatabaseExecution,
  decorate: Decorate,
): OpenClawAgentDatabaseExecution {
  return {
    ...owner,
    get fileIdentity() {
      return owner.fileIdentity;
    },
    runExisting: (source, operation, options) =>
      owner.runExisting(source, (worker) => operation(decorate(worker)), options),
  };
}

// Keep both capture paths instrumented without changing the owner's lazy identity getter.
export function instrumentAgentExecutions(actual: ExecutionModule, decorate: Decorate) {
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<ExecutionModule["captureOpenClawAgentDatabaseExecution"]>
    ) => wrapAgentExecution(actual.captureOpenClawAgentDatabaseExecution(...args), decorate),
    captureOpenClawAgentDatabasePreparationExecution: (
      ...args: Parameters<ExecutionModule["captureOpenClawAgentDatabasePreparationExecution"]>
    ) =>
      wrapAgentExecution(
        actual.captureOpenClawAgentDatabasePreparationExecution(...args),
        decorate,
      ),
  };
}
