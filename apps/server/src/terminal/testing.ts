import {
  DEFAULT_TERMINAL_ID,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalListInput,
  type TerminalOpenInput,
  type TerminalReadInput,
  type TerminalRenderedSnapshot,
  type TerminalResizeInput,
  type TerminalSessionSnapshot,
  type TerminalSummary,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { TerminalManager, type TerminalManagerShape } from "./Services/Manager";

function unusedTerminalManagerMethod(label: string, method: keyof TerminalManagerShape): never {
  throw new Error(`TerminalManager.${String(method)} is not used in ${label}`);
}

export function createTerminalManagerStub(
  label: string,
  overrides: Partial<TerminalManagerShape> = {},
): TerminalManagerShape {
  return {
    open: () => Effect.sync(() => unusedTerminalManagerMethod(label, "open")),
    write: () => Effect.sync(() => unusedTerminalManagerMethod(label, "write")),
    resize: () => Effect.sync(() => unusedTerminalManagerMethod(label, "resize")),
    clear: () => Effect.sync(() => unusedTerminalManagerMethod(label, "clear")),
    restart: () => Effect.sync(() => unusedTerminalManagerMethod(label, "restart")),
    close: () => Effect.sync(() => unusedTerminalManagerMethod(label, "close")),
    list: () => Effect.succeed([]),
    read: () => Effect.sync(() => unusedTerminalManagerMethod(label, "read")),
    subscribe: () => Effect.succeed(() => undefined),
    dispose: Effect.void,
    ...overrides,
  } satisfies TerminalManagerShape;
}

export function makeTerminalManagerTestLayer(
  label: string,
  overrides: Partial<TerminalManagerShape> = {},
) {
  return Layer.succeed(TerminalManager, createTerminalManagerStub(label, overrides));
}

export class MockTerminalManager implements TerminalManagerShape {
  private readonly sessions = new Map<string, TerminalSessionSnapshot>();
  private readonly listeners = new Set<(event: TerminalEvent) => void>();

  private key(threadId: string, terminalId: string): string {
    return `${threadId}\u0000${terminalId}`;
  }

  emitEvent(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscriptionCount(): number {
    return this.listeners.size;
  }

  readonly open: TerminalManagerShape["open"] = (input: TerminalOpenInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const snapshot: TerminalSessionSnapshot = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        status: "running",
        pid: 4242,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: now,
      };
      this.sessions.set(this.key(input.threadId, terminalId), snapshot);
      queueMicrotask(() => {
        this.emitEvent({
          type: "started",
          threadId: input.threadId,
          terminalId,
          createdAt: now,
          snapshot,
        });
      });
      return snapshot;
    });

  readonly write: TerminalManagerShape["write"] = (input: TerminalWriteInput) =>
    Effect.sync(() => {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const existing = this.sessions.get(this.key(input.threadId, terminalId));
      if (!existing) {
        throw new Error(`Unknown terminal thread: ${input.threadId}`);
      }
      queueMicrotask(() => {
        this.emitEvent({
          type: "output",
          threadId: input.threadId,
          terminalId,
          createdAt: new Date().toISOString(),
          data: input.data,
        });
      });
    });

  readonly resize: TerminalManagerShape["resize"] = (_input: TerminalResizeInput) => Effect.void;

  readonly clear: TerminalManagerShape["clear"] = (input: TerminalClearInput) =>
    Effect.sync(() => {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      queueMicrotask(() => {
        this.emitEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          createdAt: new Date().toISOString(),
        });
      });
    });

  readonly restart: TerminalManagerShape["restart"] = (input: TerminalOpenInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const snapshot: TerminalSessionSnapshot = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        status: "running",
        pid: 5252,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: now,
      };
      this.sessions.set(this.key(input.threadId, terminalId), snapshot);
      queueMicrotask(() => {
        this.emitEvent({
          type: "restarted",
          threadId: input.threadId,
          terminalId,
          createdAt: now,
          snapshot,
        });
      });
      return snapshot;
    });

  readonly close: TerminalManagerShape["close"] = (input: TerminalCloseInput) =>
    Effect.sync(() => {
      if (input.terminalId) {
        this.sessions.delete(this.key(input.threadId, input.terminalId));
        return;
      }
      for (const key of this.sessions.keys()) {
        if (key.startsWith(`${input.threadId}\u0000`)) {
          this.sessions.delete(key);
        }
      }
    });

  readonly list: TerminalManagerShape["list"] = (input: TerminalListInput) =>
    Effect.sync(() =>
      [...this.sessions.values()]
        .filter((session) => session.threadId === input.threadId)
        .toSorted((left, right) => left.terminalId.localeCompare(right.terminalId))
        .map(
          (session, index): TerminalSummary => ({
            threadId: session.threadId,
            terminalId: session.terminalId,
            label: `Terminal ${index + 1}`,
            ordinal: index + 1,
            cwd: session.cwd,
            status: session.status,
            pid: session.pid,
            hasRunningSubprocess: false,
            updatedAt: session.updatedAt,
          }),
        ),
    );

  readonly read: TerminalManagerShape["read"] = (input: TerminalReadInput) =>
    Effect.sync(() => {
      const summaries = [...this.sessions.values()]
        .filter((session) => session.threadId === input.threadId)
        .toSorted((left, right) => left.terminalId.localeCompare(right.terminalId))
        .map(
          (session, index): TerminalRenderedSnapshot => ({
            threadId: session.threadId,
            terminalId: session.terminalId,
            label: `Terminal ${index + 1}`,
            ordinal: index + 1,
            cwd: session.cwd,
            status: session.status,
            pid: session.pid,
            hasRunningSubprocess: false,
            updatedAt: session.updatedAt,
            cols: 120,
            rows: 30,
            scope: input.scope ?? "tail",
            maxLines: input.maxLines ?? null,
            grep: input.grep ?? null,
            totalLines: session.history.length > 0 ? session.history.split(/\r?\n/g).length : 0,
            returnedLineCount:
              session.history.length > 0 ? session.history.split(/\r?\n/g).length : 0,
            text: session.history,
            lines: session.history.length > 0 ? session.history.split(/\r?\n/g) : [],
          }),
        );
      const selected =
        (input.terminalId
          ? summaries.find((entry) => entry.terminalId === input.terminalId)
          : undefined) ??
        (input.ordinal ? summaries[input.ordinal - 1] : undefined) ??
        summaries[0];
      if (!selected) {
        throw new Error(`Unknown terminal thread: ${input.threadId}`);
      }
      return selected;
    });

  readonly subscribe: TerminalManagerShape["subscribe"] = (listener) =>
    Effect.sync(() => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    });

  readonly dispose: TerminalManagerShape["dispose"] = Effect.void;
}
