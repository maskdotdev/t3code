import { describe, expect, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";

import {
  CODEX_TERMINAL_DYNAMIC_TOOL_SPECS,
  executeCodexTerminalDynamicTool,
  toCodexTerminalDynamicToolErrorPayload,
} from "./codexTerminalTools";
import { createTerminalManagerStub } from "../terminal/testing";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

describe("CODEX_TERMINAL_DYNAMIC_TOOL_SPECS", () => {
  it("exposes terminal list and read tools", () => {
    expect(CODEX_TERMINAL_DYNAMIC_TOOL_SPECS.map((spec) => spec.name)).toEqual([
      "list_thread_terminals",
      "read_thread_terminal",
    ]);
  });
});

describe("executeCodexTerminalDynamicTool", () => {
  it("lists thread terminals", async () => {
    const terminalSummary = {
      threadId: "thread-1",
      terminalId: "default",
      label: "Terminal 1",
      ordinal: 1,
      cwd: "/tmp/project",
      status: "running" as const,
      pid: 1234,
      hasRunningSubprocess: false,
      updatedAt: "2026-02-10T00:00:00.000Z",
    };

    const result = await executeCodexTerminalDynamicTool(
      "list_thread_terminals",
      {},
      {
        threadId: asThreadId("thread-1"),
        runWithTerminalManager: async (operation) =>
          Effect.runPromise(
            operation(
              createTerminalManagerStub("codexTerminalTools.test.ts", {
                list: () => Effect.succeed([terminalSummary]),
                read: () => Effect.die("read should not be used"),
              }),
            ),
          ),
      },
    );

    expect(result).toEqual({
      terminals: [terminalSummary],
    });
  });

  it("decodes read arguments and defaults scope to tail", async () => {
    const result = await executeCodexTerminalDynamicTool(
      "read_thread_terminal",
      { terminalId: "default", maxLines: 25 },
      {
        threadId: asThreadId("thread-1"),
        runWithTerminalManager: async (operation) =>
          Effect.runPromise(
            operation(
              createTerminalManagerStub("codexTerminalTools.test.ts", {
                list: () => Effect.die("list should not be used"),
                read: (input) =>
                  Effect.succeed({
                    threadId: input.threadId,
                    terminalId: input.terminalId ?? "default",
                    label: "Terminal 1",
                    ordinal: input.ordinal ?? 1,
                    cwd: "/tmp/project",
                    status: "running",
                    pid: 1234,
                    hasRunningSubprocess: false,
                    updatedAt: "2026-02-10T00:00:00.000Z",
                    cols: 120,
                    rows: 30,
                    scope: input.scope ?? "tail",
                    maxLines: input.maxLines ?? null,
                    grep: input.grep ?? null,
                    totalLines: 50,
                    returnedLineCount: 25,
                    text: "tail",
                    lines: ["tail"],
                  }),
              }),
            ),
          ),
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        terminalId: "default",
        scope: "tail",
        maxLines: 25,
        grep: null,
      }),
    );
  });

  it("preserves explicit read selectors and filters", async () => {
    const result = await executeCodexTerminalDynamicTool(
      "read_thread_terminal",
      { ordinal: 2, scope: "full", grep: "error" },
      {
        threadId: asThreadId("thread-1"),
        runWithTerminalManager: async (operation) =>
          Effect.runPromise(
            operation(
              createTerminalManagerStub("codexTerminalTools.test.ts", {
                list: () => Effect.die("list should not be used"),
                read: (input) =>
                  Effect.succeed({
                    threadId: input.threadId,
                    terminalId: input.terminalId ?? "build",
                    label: "Terminal 2",
                    ordinal: input.ordinal ?? 1,
                    cwd: "/tmp/project",
                    status: "running",
                    pid: 2222,
                    hasRunningSubprocess: true,
                    updatedAt: "2026-02-10T00:00:00.000Z",
                    cols: 120,
                    rows: 30,
                    scope: input.scope ?? "tail",
                    maxLines: input.maxLines ?? null,
                    grep: input.grep ?? null,
                    totalLines: 12,
                    returnedLineCount: 1,
                    text: "build error",
                    lines: ["build error"],
                  }),
              }),
            ),
          ),
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        terminalId: "build",
        ordinal: 2,
        scope: "full",
        grep: "error",
      }),
    );
  });
});

describe("toCodexTerminalDynamicToolErrorPayload", () => {
  it("guides the model on invalid read arguments", () => {
    const payload = toCodexTerminalDynamicToolErrorPayload(
      "read_thread_terminal",
      new Error("scope is forbidden"),
    );

    expect(payload).toEqual({
      tool: "read_thread_terminal",
      code: "INVALID_ARGUMENTS",
      message: "scope is forbidden",
      hint: "Call read_thread_terminal with terminalId or ordinal, scope 'tail' or 'full', optional maxLines <= 5000, and optional grep.",
    });
  });

  it("guides the model to list terminals when selection fails", () => {
    const payload = toCodexTerminalDynamicToolErrorPayload(
      "read_thread_terminal",
      new Error("Unable to resolve terminal for thread: thread-1"),
    );

    expect(payload).toEqual({
      tool: "read_thread_terminal",
      code: "TERMINAL_NOT_FOUND",
      message: "Unable to resolve terminal for thread: thread-1",
      hint: "Call list_thread_terminals to inspect valid terminalId and ordinal values, then retry with one of those selectors.",
    });
  });

  it("returns supported tools for unknown tool calls", () => {
    const payload = toCodexTerminalDynamicToolErrorPayload("bad_tool", new Error("nope"));

    expect(payload).toEqual({
      tool: "bad_tool",
      code: "UNSUPPORTED_TOOL",
      message: "Unsupported dynamic tool: bad_tool",
      hint: "Supported dynamic tools: list_thread_terminals, read_thread_terminal.",
    });
  });
});
