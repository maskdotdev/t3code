import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerPendingTerminalContextChip } from "./ComposerPendingTerminalContexts";

const context = {
  id: "context-1",
  threadId: ThreadId.makeUnsafe("thread-1"),
  terminalId: "terminal-1",
  terminalLabel: "Terminal 1",
  lineStart: 1,
  lineEnd: 5,
  text: "echo test",
  createdAt: "2026-03-17T10:00:00.000Z",
} as const;

describe("ComposerPendingTerminalContextChip", () => {
  it("renders using the inline composer chip styling", () => {
    const html = renderToStaticMarkup(<ComposerPendingTerminalContextChip context={context} />);

    expect(html).toContain("rounded-md");
    expect(html).not.toContain("rounded-full");
    expect(html).toContain("Terminal 1 lines 1-5");
    expect(html).not.toContain("aria-label=");
  });
});
