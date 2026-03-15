import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_ID,
  TerminalClearInput,
  TerminalOpenInput,
  TerminalReadInput,
  TerminalReadToolInput,
  TerminalThreadInput,
} from "./terminal";

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

describe("TerminalOpenInput", () => {
  it("defaults terminalId when missing", () => {
    const parsed = decodeSync(TerminalOpenInput, {
      threadId: "thread-1",
      cwd: "/tmp/project",
      cols: 100,
      rows: 24,
    });
    expect(parsed.terminalId).toBe(DEFAULT_TERMINAL_ID);
  });

  it("rejects invalid bounds and env keys", () => {
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        cols: 10,
        rows: 2,
      }),
    ).toBe(false);
    expect(
      decodes(TerminalOpenInput, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        cols: 100,
        rows: 24,
        env: {
          "bad-key": "1",
        },
      }),
    ).toBe(false);
  });
});

describe("TerminalThreadInput", () => {
  it("trims thread ids", () => {
    const parsed = decodeSync(TerminalThreadInput, { threadId: " thread-1 " });
    expect(parsed.threadId).toBe("thread-1");
  });
});

describe("TerminalClearInput", () => {
  it("defaults terminal id", () => {
    const parsed = decodeSync(TerminalClearInput, {
      threadId: "thread-1",
    });
    expect(parsed.terminalId).toBe(DEFAULT_TERMINAL_ID);
  });
});

describe("TerminalReadInput", () => {
  it("rejects invalid ordinal and scope values", () => {
    expect(
      decodes(TerminalReadInput, {
        threadId: "thread-1",
        ordinal: 0,
      }),
    ).toBe(false);
    expect(
      decodes(TerminalReadInput, {
        threadId: "thread-1",
        scope: "viewport",
      }),
    ).toBe(false);
  });
});

describe("TerminalReadToolInput", () => {
  it("defaults scope to tail", () => {
    const parsed = decodeSync(TerminalReadToolInput, {
      terminalId: "build",
      maxLines: 25,
    });
    expect(parsed.terminalId).toBe("build");
    expect(parsed.scope).toBe("tail");
  });
});
