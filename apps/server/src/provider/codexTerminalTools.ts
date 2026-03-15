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

export interface CodexTerminalDynamicToolErrorPayload {
  readonly tool: string;
  readonly code:
    | "UNSUPPORTED_TOOL"
    | "INVALID_ARGUMENTS"
    | "NO_TERMINALS"
    | "TERMINAL_NOT_FOUND"
    | "TOOL_EXECUTION_FAILED";
  readonly message: string;
  readonly hint: string;
}

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

function invalidArgumentsHint(tool: CodexTerminalDynamicToolName): string {
  switch (tool) {
    case "list_thread_terminals":
      return "Call list_thread_terminals with an empty object.";
    case "read_thread_terminal":
      return "Call read_thread_terminal with terminalId or ordinal, scope 'tail' or 'full', optional maxLines <= 5000, and optional grep.";
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export function toCodexTerminalDynamicToolErrorPayload(
  tool: string | undefined,
  error: unknown,
): CodexTerminalDynamicToolErrorPayload {
  if (!tool || !isCodexTerminalDynamicToolName(tool)) {
    return {
      tool: tool ?? "unknown",
      code: "UNSUPPORTED_TOOL",
      message: `Unsupported dynamic tool: ${tool ?? "unknown"}`,
      hint: `Supported dynamic tools: ${CODEX_TERMINAL_DYNAMIC_TOOL_SPECS.map((spec) => spec.name).join(", ")}.`,
    };
  }

  const message = errorMessage(error, "Dynamic tool execution failed.");
  const normalizedMessage = message.toLowerCase();

  if (
    normalizedMessage.includes("expected") ||
    normalizedMessage.includes("is forbidden") ||
    normalizedMessage.includes("is missing") ||
    normalizedMessage.includes("cannot decode")
  ) {
    return {
      tool,
      code: "INVALID_ARGUMENTS",
      message,
      hint: invalidArgumentsHint(tool),
    };
  }

  if (normalizedMessage.includes("no terminals found for thread")) {
    return {
      tool,
      code: "NO_TERMINALS",
      message,
      hint: "Call list_thread_terminals first. If the list is empty, open a terminal for this thread before retrying.",
    };
  }

  if (
    normalizedMessage.includes("unable to resolve terminal for thread") ||
    normalizedMessage.includes("unknown terminal thread")
  ) {
    return {
      tool,
      code: "TERMINAL_NOT_FOUND",
      message,
      hint: "Call list_thread_terminals to inspect valid terminalId and ordinal values, then retry with one of those selectors.",
    };
  }

  return {
    tool,
    code: "TOOL_EXECUTION_FAILED",
    message,
    hint: "Retry the tool call with valid arguments. If the terminal state changed, call list_thread_terminals first.",
  };
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
