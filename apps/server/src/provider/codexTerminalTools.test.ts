import { describe, expect, it, vi } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";

import {
  CODEX_TERMINAL_DYNAMIC_TOOL_SPECS,
  executeCodexTerminalDynamicTool,
} from "./codexTerminalTools";
import { type TerminalManagerShape } from "../terminal/Services/Manager";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function createTerminalManagerStub(
  overrides: Pick<TerminalManagerShape, "list" | "read">,
): TerminalManagerShape {
  return {
    open: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    restart: vi.fn(),
    close: vi.fn(),
    subscribe: vi.fn(),
    dispose: Effect.void,
    ...overrides,
  };
}

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
    const list = vi.fn().mockReturnValue(
      Effect.succeed([
        {
          threadId: "thread-1",
          terminalId: "default",
          label: "Terminal 1",
          ordinal: 1,
          cwd: "/tmp/project",
          status: "running",
          pid: 1234,
          hasRunningSubprocess: false,
          updatedAt: "2026-02-10T00:00:00.000Z",
        },
      ]),
    );

    const result = await executeCodexTerminalDynamicTool(
      "list_thread_terminals",
      {},
      {
        threadId: asThreadId("thread-1"),
        runWithTerminalManager: async (operation) =>
          Effect.runPromise(operation(createTerminalManagerStub({ list, read: vi.fn() }))),
      },
    );

    expect(list).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(result).toEqual({
      terminals: [
        expect.objectContaining({
          terminalId: "default",
          label: "Terminal 1",
        }),
      ],
    });
  });

  it("reads terminal content with decoded defaults", async () => {
    const read = vi.fn().mockReturnValue(
      Effect.succeed({
        threadId: "thread-1",
        terminalId: "default",
        label: "Terminal 1",
        ordinal: 1,
        cwd: "/tmp/project",
        status: "running",
        pid: 1234,
        hasRunningSubprocess: false,
        updatedAt: "2026-02-10T00:00:00.000Z",
        cols: 120,
        rows: 30,
        scope: "tail",
        maxLines: 25,
        grep: null,
        totalLines: 50,
        returnedLineCount: 25,
        text: "tail",
        lines: ["tail"],
      }),
    );

    const result = await executeCodexTerminalDynamicTool(
      "read_thread_terminal",
      { terminalId: "default", maxLines: 25 },
      {
        threadId: asThreadId("thread-1"),
        runWithTerminalManager: async (operation) =>
          Effect.runPromise(operation(createTerminalManagerStub({ list: vi.fn(), read }))),
      },
    );

    expect(read).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "default",
      maxLines: 25,
    });
    expect(result).toEqual(
      expect.objectContaining({
        terminalId: "default",
        scope: "tail",
        maxLines: 25,
      }),
    );
  });
});
