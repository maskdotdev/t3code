import {
  TerminalListToolInput,
  TerminalReadInput,
  TerminalReadToolInput,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { TerminalError, type TerminalManagerShape } from "../terminal/Services/Manager";

const decodeTerminalListToolArgs = Schema.decodeUnknownSync(TerminalListToolInput);
const decodeTerminalReadToolArgs = Schema.decodeUnknownSync(TerminalReadToolInput);
type DecodedTerminalReadToolArgs = ReturnType<typeof decodeTerminalReadToolArgs>;

function toCodexToolInputJsonSchema(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return {
      ...document.schema,
      $defs: document.definitions,
    };
  }
  return document.schema;
}

export const CODEX_TERMINAL_DYNAMIC_TOOL_SPECS = [
  {
    name: "list_thread_terminals",
    description:
      "List the terminals known for the current thread. Use this to count terminals or identify which terminal to inspect.",
    inputSchema: toCodexToolInputJsonSchema(TerminalListToolInput),
  },
  {
    name: "read_thread_terminal",
    description:
      "Read rendered terminal content for the current thread. Supports the last N rendered lines or the full rendered scrollback, plus optional substring filtering.",
    inputSchema: toCodexToolInputJsonSchema(TerminalReadToolInput),
  },
] as const;

export type CodexTerminalDynamicToolName =
  (typeof CODEX_TERMINAL_DYNAMIC_TOOL_SPECS)[number]["name"];

export interface CodexTerminalDynamicToolExecutionContext {
  readonly threadId: ThreadId;
  readonly runWithTerminalManager: <A>(
    operation: (terminalManager: TerminalManagerShape) => Effect.Effect<A, TerminalError>,
  ) => Promise<A>;
}

export function isCodexTerminalDynamicToolName(
  tool: string | undefined,
): tool is CodexTerminalDynamicToolName {
  return CODEX_TERMINAL_DYNAMIC_TOOL_SPECS.some((spec) => spec.name === tool);
}

function buildTerminalReadToolInput(
  threadId: ThreadId,
  input: DecodedTerminalReadToolArgs,
): TerminalReadInput {
  return {
    threadId,
    ...(input.terminalId ? { terminalId: input.terminalId } : {}),
    ...(input.ordinal ? { ordinal: input.ordinal } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.maxLines ? { maxLines: input.maxLines } : {}),
    ...(input.grep ? { grep: input.grep } : {}),
  };
}

export async function executeCodexTerminalDynamicTool(
  tool: CodexTerminalDynamicToolName,
  rawArguments: Record<string, unknown>,
  context: CodexTerminalDynamicToolExecutionContext,
): Promise<unknown> {
  switch (tool) {
    case "list_thread_terminals":
      decodeTerminalListToolArgs(rawArguments);
      return {
        terminals: await context.runWithTerminalManager((terminalManager) =>
          terminalManager.list({ threadId: context.threadId }),
        ),
      };
    case "read_thread_terminal":
      return context.runWithTerminalManager((terminalManager) =>
        terminalManager.read(
          buildTerminalReadToolInput(context.threadId, decodeTerminalReadToolArgs(rawArguments)),
        ),
      );
  }
}
