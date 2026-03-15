import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalListInput,
  TerminalOpenInput,
  TerminalReadInput,
  TerminalRenderedSnapshot,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
  type TerminalEvent,
  type TerminalSummary,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { Effect, Encoding, Layer, Path, Schema } from "effect";

import { createLogger } from "../../logger";
import { PtyAdapter, PtyAdapterShape, type PtyExitEvent, type PtyProcess } from "../Services/PTY";
import { runProcess } from "../../processRunner";
import { ServerConfig } from "../../config";
import {
  ShellCandidate,
  TerminalError,
  TerminalManager,
  TerminalManagerShape,
  TerminalSessionState,
  TerminalStartInput,
} from "../Services/Manager";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const DEFAULT_SCROLLBACK = 5_000;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);

const decodeTerminalOpenInput = Schema.decodeUnknownSync(TerminalOpenInput);
const decodeTerminalRestartInput = Schema.decodeUnknownSync(TerminalRestartInput);
const decodeTerminalWriteInput = Schema.decodeUnknownSync(TerminalWriteInput);
const decodeTerminalResizeInput = Schema.decodeUnknownSync(TerminalResizeInput);
const decodeTerminalClearInput = Schema.decodeUnknownSync(TerminalClearInput);
const decodeTerminalCloseInput = Schema.decodeUnknownSync(TerminalCloseInput);
const decodeTerminalListInput = Schema.decodeUnknownSync(TerminalListInput);
const decodeTerminalReadInput = Schema.decodeUnknownSync(TerminalReadInput);
const require = createRequire(import.meta.url);
type HeadlessTerminalInstance = import("@xterm/headless").Terminal;
const { Terminal: HeadlessTerminal } = require("@xterm/headless") as {
  Terminal: typeof import("@xterm/headless").Terminal;
};

type TerminalSubprocessChecker = (terminalPid: number) => Promise<boolean>;

function defaultShellResolver(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "bash";
}

function normalizeShellCommand(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (process.platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function shellCandidateFromCommand(command: string | null): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = path.basename(command).toLowerCase();
  if (process.platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(shellResolver: () => string): ShellCandidate[] {
  const requested = shellCandidateFromCommand(normalizeShellCommand(shellResolver()));

  if (process.platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand(process.env.ComSpec ?? null),
      shellCandidateFromCommand("powershell.exe"),
      shellCandidateFromCommand("cmd.exe"),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(process.env.SHELL)),
    shellCandidateFromCommand("/bin/zsh"),
    shellCandidateFromCommand("/bin/bash"),
    shellCandidateFromCommand("/bin/sh"),
    shellCandidateFromCommand("zsh"),
    shellCandidateFromCommand("bash"),
    shellCandidateFromCommand("sh"),
  ]);
}

function isRetryableShellSpawnError(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      const cause = (current as { cause?: unknown }).cause;
      if (cause) {
        queue.push(cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

async function checkWindowsSubprocessActivity(terminalPid: number): Promise<boolean> {
  const command = [
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" -ErrorAction SilentlyContinue`,
    "if ($children) { exit 0 }",
    "exit 1",
  ].join("; ");
  try {
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

async function checkPosixSubprocessActivity(terminalPid: number): Promise<boolean> {
  try {
    const pgrepResult = await runProcess("pgrep", ["-P", String(terminalPid)], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    });
    if (pgrepResult.code === 0) {
      return pgrepResult.stdout.trim().length > 0;
    }
    if (pgrepResult.code === 1) {
      return false;
    }
  } catch {
    // Fall back to ps when pgrep is unavailable.
  }

  try {
    const psResult = await runProcess("ps", ["-eo", "pid=,ppid="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 262_144,
      outputMode: "truncate",
    });
    if (psResult.code !== 0) {
      return false;
    }

    for (const line of psResult.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      if (ppid === terminalPid) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function defaultSubprocessChecker(terminalPid: number): Promise<boolean> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return false;
  }
  if (process.platform === "win32") {
    return checkWindowsSubprocessActivity(terminalPid);
  }
  return checkPosixSubprocessActivity(terminalPid);
}

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function decodeBase64UrlValue(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function matchesRenderedLine(line: string, grep: string | undefined): boolean {
  if (!grep) {
    return true;
  }
  return line.toLocaleLowerCase().includes(grep.toLocaleLowerCase());
}

function trimTrailingEmptyRenderedLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end -= 1;
  }
  return lines.slice(0, end);
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return spawnEnv;
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerEvents {
  event: [event: TerminalEvent];
}

interface PersistedTerminalMetadata {
  threadId: string;
  terminalId: string;
  createdAt: string;
  cwd: string;
  cols: number;
  rows: number;
}

interface PersistedTerminalEntry {
  threadId: string;
  terminalId: string;
  createdAt: string;
  cwd: string;
  cols: number;
  rows: number;
  updatedAt: string;
}

interface TerminalListEntry extends PersistedTerminalEntry {
  status: TerminalSummary["status"];
  pid: number | null;
  hasRunningSubprocess: boolean;
}

interface TerminalMirrorState {
  terminal: HeadlessTerminalInstance;
  pending: Promise<void>;
}

interface TerminalManagerOptions {
  logsDir?: string;
  historyLineLimit?: number;
  ptyAdapter: PtyAdapterShape;
  shellResolver?: () => string;
  subprocessChecker?: TerminalSubprocessChecker;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
}

export class TerminalManagerRuntime extends EventEmitter<TerminalManagerEvents> {
  private readonly sessions = new Map<string, TerminalSessionState>();
  private readonly mirrors = new Map<string, TerminalMirrorState>();
  private readonly logsDir: string;
  private readonly historyLineLimit: number;
  private readonly ptyAdapter: PtyAdapterShape;
  private readonly shellResolver: () => string;
  private readonly persistQueues = new Map<string, Promise<void>>();
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingPersistHistory = new Map<string, string>();
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly persistDebounceMs: number;
  private readonly subprocessChecker: TerminalSubprocessChecker;
  private readonly subprocessPollIntervalMs: number;
  private readonly processKillGraceMs: number;
  private readonly maxRetainedInactiveSessions: number;
  private subprocessPollTimer: ReturnType<typeof setInterval> | null = null;
  private subprocessPollInFlight = false;
  private readonly killEscalationTimers = new Map<PtyProcess, ReturnType<typeof setTimeout>>();
  private readonly logger = createLogger("terminal");

  constructor(options: TerminalManagerOptions) {
    super();
    this.logsDir = options.logsDir ?? path.resolve(process.cwd(), ".logs", "terminals");
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.ptyAdapter = options.ptyAdapter;
    this.shellResolver = options.shellResolver ?? defaultShellResolver;
    this.persistDebounceMs = DEFAULT_PERSIST_DEBOUNCE_MS;
    this.subprocessChecker = options.subprocessChecker ?? defaultSubprocessChecker;
    this.subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
    this.processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    this.maxRetainedInactiveSessions =
      options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  async open(raw: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const input = decodeTerminalOpenInput(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      const existing = this.sessions.get(sessionKey);
      if (!existing) {
        await this.flushPersistQueue(input.threadId, input.terminalId);
        const metadata = await this.readMetadata(input.threadId, input.terminalId);
        const history = await this.readHistory(input.threadId, input.terminalId);
        const cols = input.cols ?? metadata?.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? metadata?.rows ?? DEFAULT_OPEN_ROWS;
        const createdAt = metadata?.createdAt ?? new Date().toISOString();
        const session: TerminalSessionState = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          createdAt,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history,
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          runtimeEnv: normalizedRuntimeEnv(input.env),
        };
        this.sessions.set(sessionKey, session);
        await this.persistMetadata(session);
        await this.rebuildMirror(session, history);
        this.evictInactiveSessionsIfNeeded();
        await this.startSession(session, { ...input, cols, rows }, "started");
        return this.snapshot(session);
      }

      const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
      const currentRuntimeEnv = existing.runtimeEnv;
      const targetCols = input.cols ?? existing.cols;
      const targetRows = input.rows ?? existing.rows;
      const runtimeEnvChanged =
        JSON.stringify(currentRuntimeEnv) !== JSON.stringify(nextRuntimeEnv);

      if (existing.cwd !== input.cwd || runtimeEnvChanged) {
        this.stopProcess(existing);
        existing.cwd = input.cwd;
        existing.runtimeEnv = nextRuntimeEnv;
        existing.history = "";
        await this.persistHistory(existing.threadId, existing.terminalId, existing.history);
        await this.persistMetadata(existing);
        await this.rebuildMirror(existing, existing.history);
      } else if (existing.status === "exited" || existing.status === "error") {
        existing.runtimeEnv = nextRuntimeEnv;
        existing.history = "";
        await this.persistHistory(existing.threadId, existing.terminalId, existing.history);
        await this.rebuildMirror(existing, existing.history);
      } else if (currentRuntimeEnv !== nextRuntimeEnv) {
        existing.runtimeEnv = nextRuntimeEnv;
      }

      if (!existing.process) {
        await this.startSession(
          existing,
          { ...input, cols: targetCols, rows: targetRows },
          "started",
        );
        return this.snapshot(existing);
      }

      if (existing.cols !== targetCols || existing.rows !== targetRows) {
        existing.cols = targetCols;
        existing.rows = targetRows;
        existing.process.resize(targetCols, targetRows);
        existing.updatedAt = new Date().toISOString();
        this.resizeMirror(existing);
        await this.persistMetadata(existing);
      }

      return this.snapshot(existing);
    });
  }

  async list(raw: TerminalListInput): Promise<ReadonlyArray<TerminalSummary>> {
    const input = decodeTerminalListInput(raw);
    const entries = await this.listTerminalEntries(input.threadId);
    return entries.map((entry, index) => this.toTerminalSummary(entry, index + 1));
  }

  async read(raw: TerminalReadInput): Promise<TerminalRenderedSnapshot> {
    const input = decodeTerminalReadInput(raw);
    const entries = await this.listTerminalEntries(input.threadId);
    if (entries.length === 0) {
      throw new Error(`No terminals found for thread: ${input.threadId}`);
    }

    const selected =
      (input.terminalId
        ? entries.find((entry) => entry.terminalId === input.terminalId)
        : undefined) ??
      (input.ordinal ? entries[input.ordinal - 1] : undefined) ??
      entries.find((entry) => entry.status === "running") ??
      entries[0];

    if (!selected) {
      throw new Error(`Unable to resolve terminal for thread: ${input.threadId}`);
    }

    const ordinal = entries.findIndex((entry) => entry.terminalId === selected.terminalId) + 1;
    const rendered = await this.readRenderedLines(selected.threadId, selected.terminalId);
    const scope = input.scope ?? "viewport";
    const nonViewportLines = trimTrailingEmptyRenderedLines(rendered.lines);
    const scopedLines =
      scope === "full"
        ? nonViewportLines
        : scope === "tail"
          ? nonViewportLines.slice(
              Math.max(0, nonViewportLines.length - (input.maxLines ?? selected.rows)),
            )
          : rendered.lines.slice(rendered.viewportStart, rendered.viewportEnd);
    const lines = scopedLines.filter((line) => matchesRenderedLine(line, input.grep));
    return {
      ...this.toTerminalSummary(selected, ordinal),
      cols: selected.cols,
      rows: selected.rows,
      scope,
      maxLines: input.maxLines ?? null,
      grep: input.grep ?? null,
      totalLines: rendered.lines.length,
      returnedLineCount: lines.length,
      text: lines.join("\n"),
      lines,
    };
  }

  async write(raw: TerminalWriteInput): Promise<void> {
    const input = decodeTerminalWriteInput(raw);
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      if (session.status === "exited") {
        return;
      }
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    session.process.write(input.data);
  }

  async resize(raw: TerminalResizeInput): Promise<void> {
    const input = decodeTerminalResizeInput(raw);
    const session = this.requireSession(input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    session.cols = input.cols;
    session.rows = input.rows;
    session.updatedAt = new Date().toISOString();
    session.process.resize(input.cols, input.rows);
    this.resizeMirror(session);
    await this.persistMetadata(session);
  }

  async clear(raw: TerminalClearInput): Promise<void> {
    const input = decodeTerminalClearInput(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      const session = this.requireSession(input.threadId, input.terminalId);
      session.history = "";
      session.updatedAt = new Date().toISOString();
      await this.persistHistory(input.threadId, input.terminalId, session.history);
      await this.rebuildMirror(session, session.history);
      this.emitEvent({
        type: "cleared",
        threadId: input.threadId,
        terminalId: input.terminalId,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async restart(raw: TerminalRestartInput): Promise<TerminalSessionSnapshot> {
    const input = decodeTerminalRestartInput(raw);
    return this.runWithThreadLock(input.threadId, async () => {
      await this.assertValidCwd(input.cwd);

      const sessionKey = toSessionKey(input.threadId, input.terminalId);
      let session = this.sessions.get(sessionKey);
      if (!session) {
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        session = {
          threadId: input.threadId,
          terminalId: input.terminalId,
          createdAt: new Date().toISOString(),
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          runtimeEnv: normalizedRuntimeEnv(input.env),
        };
        this.sessions.set(sessionKey, session);
        this.evictInactiveSessionsIfNeeded();
      } else {
        this.stopProcess(session);
        session.cwd = input.cwd;
        session.runtimeEnv = normalizedRuntimeEnv(input.env);
      }

      const cols = input.cols ?? session.cols;
      const rows = input.rows ?? session.rows;

      session.history = "";
      await this.persistHistory(input.threadId, input.terminalId, session.history);
      await this.persistMetadata(session);
      await this.rebuildMirror(session, session.history);
      await this.startSession(session, { ...input, cols, rows }, "restarted");
      return this.snapshot(session);
    });
  }

  async close(raw: TerminalCloseInput): Promise<void> {
    const input = decodeTerminalCloseInput(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      if (input.terminalId) {
        await this.closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
        return;
      }

      const threadSessions = this.sessionsForThread(input.threadId);
      for (const session of threadSessions) {
        this.stopProcess(session);
        this.sessions.delete(toSessionKey(session.threadId, session.terminalId));
      }
      await Promise.all(
        threadSessions.map((session) =>
          this.flushPersistQueue(session.threadId, session.terminalId),
        ),
      );

      if (input.deleteHistory) {
        await this.deleteAllHistoryForThread(input.threadId);
      }
      this.updateSubprocessPollingState();
    });
  }

  dispose(): void {
    this.stopSubprocessPolling();
    this.flushPendingPersistsSync();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.mirrors.clear();
    for (const session of sessions) {
      this.stopProcess(session);
    }
    for (const timer of this.killEscalationTimers.values()) {
      clearTimeout(timer);
    }
    this.killEscalationTimers.clear();
    this.pendingPersistHistory.clear();
    this.threadLocks.clear();
    this.persistQueues.clear();
  }

  private async startSession(
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ): Promise<void> {
    this.stopProcess(session);

    session.status = "starting";
    session.cwd = input.cwd;
    session.cols = input.cols;
    session.rows = input.rows;
    session.exitCode = null;
    session.exitSignal = null;
    session.hasRunningSubprocess = false;
    session.updatedAt = new Date().toISOString();
    this.resizeMirror(session);
    await this.persistMetadata(session);

    let ptyProcess: PtyProcess | null = null;
    let startedShell: string | null = null;
    try {
      const shellCandidates = resolveShellCandidates(this.shellResolver);
      const terminalEnv = createTerminalSpawnEnv(process.env, session.runtimeEnv);
      let lastSpawnError: unknown = null;

      const spawnWithCandidate = (candidate: ShellCandidate) =>
        Effect.runPromise(
          this.ptyAdapter.spawn({
            shell: candidate.shell,
            ...(candidate.args ? { args: candidate.args } : {}),
            cwd: session.cwd,
            cols: session.cols,
            rows: session.rows,
            env: terminalEnv,
          }),
        );

      const trySpawn = async (
        candidates: ShellCandidate[],
        index = 0,
      ): Promise<{ process: PtyProcess; shellLabel: string } | null> => {
        if (index >= candidates.length) {
          return null;
        }
        const candidate = candidates[index];
        if (!candidate) {
          return null;
        }

        try {
          const process = await spawnWithCandidate(candidate);
          return { process, shellLabel: formatShellCandidate(candidate) };
        } catch (error) {
          lastSpawnError = error;
          if (!isRetryableShellSpawnError(error)) {
            throw error;
          }
          return trySpawn(candidates, index + 1);
        }
      };

      const spawnResult = await trySpawn(shellCandidates);
      if (spawnResult) {
        ptyProcess = spawnResult.process;
        startedShell = spawnResult.shellLabel;
      }

      if (!ptyProcess) {
        const detail =
          lastSpawnError instanceof Error ? lastSpawnError.message : "Terminal start failed";
        const tried =
          shellCandidates.length > 0
            ? ` Tried shells: ${shellCandidates.map((candidate) => formatShellCandidate(candidate)).join(", ")}.`
            : "";
        throw new Error(`${detail}.${tried}`.trim());
      }

      session.process = ptyProcess;
      session.pid = ptyProcess.pid;
      session.status = "running";
      session.updatedAt = new Date().toISOString();
      session.unsubscribeData = ptyProcess.onData((data) => {
        this.onProcessData(session, data);
      });
      session.unsubscribeExit = ptyProcess.onExit((event) => {
        this.onProcessExit(session, event);
      });
      this.updateSubprocessPollingState();
      this.emitEvent({
        type: eventType,
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        snapshot: this.snapshot(session),
      });
    } catch (error) {
      if (ptyProcess) {
        this.killProcessWithEscalation(ptyProcess, session.threadId, session.terminalId);
      }
      session.status = "error";
      session.pid = null;
      session.process = null;
      session.hasRunningSubprocess = false;
      session.updatedAt = new Date().toISOString();
      this.evictInactiveSessionsIfNeeded();
      this.updateSubprocessPollingState();
      const message = error instanceof Error ? error.message : "Terminal start failed";
      this.emitEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        message,
      });
      this.logger.error("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: message,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  }

  private onProcessData(session: TerminalSessionState, data: string): void {
    session.history = capHistory(`${session.history}${data}`, this.historyLineLimit);
    session.updatedAt = new Date().toISOString();
    this.queuePersist(session.threadId, session.terminalId, session.history);
    this.queueMirrorWrite(session, data);
    this.emitEvent({
      type: "output",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      data,
    });
  }

  private onProcessExit(session: TerminalSessionState, event: PtyExitEvent): void {
    this.clearKillEscalationTimer(session.process);
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.status = "exited";
    session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
    session.exitSignal = Number.isInteger(event.signal) ? event.signal : null;
    session.updatedAt = new Date().toISOString();
    this.emitEvent({
      type: "exited",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
    });
    this.evictInactiveSessionsIfNeeded();
    this.updateSubprocessPollingState();
  }

  private stopProcess(session: TerminalSessionState): void {
    const process = session.process;
    if (!process) return;
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.status = "exited";
    session.updatedAt = new Date().toISOString();
    this.killProcessWithEscalation(process, session.threadId, session.terminalId);
    this.evictInactiveSessionsIfNeeded();
    this.updateSubprocessPollingState();
  }

  private cleanupProcessHandles(session: TerminalSessionState): void {
    session.unsubscribeData?.();
    session.unsubscribeData = null;
    session.unsubscribeExit?.();
    session.unsubscribeExit = null;
  }

  private clearKillEscalationTimer(process: PtyProcess | null): void {
    if (!process) return;
    const timer = this.killEscalationTimers.get(process);
    if (!timer) return;
    clearTimeout(timer);
    this.killEscalationTimers.delete(process);
  }

  private killProcessWithEscalation(
    process: PtyProcess,
    threadId: string,
    terminalId: string,
  ): void {
    this.clearKillEscalationTimer(process);
    try {
      process.kill("SIGTERM");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to kill terminal process", {
        threadId,
        terminalId,
        signal: "SIGTERM",
        error: message,
      });
      return;
    }

    const timer = setTimeout(() => {
      this.killEscalationTimers.delete(process);
      try {
        process.kill("SIGKILL");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("failed to force-kill terminal process", {
          threadId,
          terminalId,
          signal: "SIGKILL",
          error: message,
        });
      }
    }, this.processKillGraceMs);
    timer.unref?.();
    this.killEscalationTimers.set(process, timer);
  }

  private evictInactiveSessionsIfNeeded(): void {
    const inactiveSessions = [...this.sessions.values()].filter(
      (session) => session.status !== "running",
    );
    if (inactiveSessions.length <= this.maxRetainedInactiveSessions) {
      return;
    }

    inactiveSessions.sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.threadId.localeCompare(right.threadId) ||
        left.terminalId.localeCompare(right.terminalId),
    );
    const toEvict = inactiveSessions.length - this.maxRetainedInactiveSessions;
    for (const session of inactiveSessions.slice(0, toEvict)) {
      const key = toSessionKey(session.threadId, session.terminalId);
      this.sessions.delete(key);
      this.mirrors.delete(key);
      this.clearPersistTimer(session.threadId, session.terminalId);
      this.pendingPersistHistory.delete(key);
      this.persistQueues.delete(key);
      this.clearKillEscalationTimer(session.process);
    }
  }

  private queuePersist(threadId: string, terminalId: string, history: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.pendingPersistHistory.set(persistenceKey, history);
    this.schedulePersist(threadId, terminalId);
  }

  private async persistHistory(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);
    this.pendingPersistHistory.delete(persistenceKey);
    await this.enqueuePersistWrite(threadId, terminalId, history);
  }

  private enqueuePersistWrite(
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const task = async () => {
      await fs.promises.writeFile(this.historyPath(threadId, terminalId), history, "utf8");
    };
    const previous = this.persistQueues.get(persistenceKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.logger.warn("failed to persist terminal history", {
          threadId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.persistQueues.set(persistenceKey, next);
    const finalized = next.finally(() => {
      if (this.persistQueues.get(persistenceKey) === next) {
        this.persistQueues.delete(persistenceKey);
      }
      if (
        this.pendingPersistHistory.has(persistenceKey) &&
        !this.persistTimers.has(persistenceKey)
      ) {
        this.schedulePersist(threadId, terminalId);
      }
    });
    void finalized.catch(() => undefined);
    return finalized;
  }

  private schedulePersist(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    if (this.persistTimers.has(persistenceKey)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(persistenceKey);
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory === undefined) return;
      this.pendingPersistHistory.delete(persistenceKey);
      void this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
    }, this.persistDebounceMs);
    this.persistTimers.set(persistenceKey, timer);
  }

  private clearPersistTimer(threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(threadId, terminalId);
    const timer = this.persistTimers.get(persistenceKey);
    if (!timer) return;
    clearTimeout(timer);
    this.persistTimers.delete(persistenceKey);
  }

  private flushPendingPersistsSync(): void {
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();

    for (const [sessionKey, history] of this.pendingPersistHistory) {
      const [threadId, terminalId] = sessionKey.split("\u0000");
      if (!threadId || !terminalId) {
        continue;
      }

      try {
        fs.writeFileSync(this.historyPath(threadId, terminalId), history, "utf8");
      } catch (error) {
        this.logger.warn("failed to flush terminal history during dispose", {
          threadId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.pendingPersistHistory.clear();
  }

  private async readHistory(threadId: string, terminalId: string): Promise<string> {
    const nextPath = this.historyPath(threadId, terminalId);
    try {
      const raw = await fs.promises.readFile(nextPath, "utf8");
      const capped = capHistory(raw, this.historyLineLimit);
      if (capped !== raw) {
        await fs.promises.writeFile(nextPath, capped, "utf8");
      }
      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
    }

    const legacyPath = this.legacyHistoryPath(threadId);
    try {
      const raw = await fs.promises.readFile(legacyPath, "utf8");
      const capped = capHistory(raw, this.historyLineLimit);

      // Migrate legacy transcript filename to the terminal-scoped path.
      await fs.promises.writeFile(nextPath, capped, "utf8");
      try {
        await fs.promises.rm(legacyPath, { force: true });
      } catch (cleanupError) {
        this.logger.warn("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  private async deleteHistory(threadId: string, terminalId: string): Promise<void> {
    const deletions = [
      fs.promises.rm(this.historyPath(threadId, terminalId), { force: true }),
      fs.promises.rm(this.metadataPath(threadId, terminalId), { force: true }),
    ];
    if (terminalId === DEFAULT_TERMINAL_ID) {
      deletions.push(fs.promises.rm(this.legacyHistoryPath(threadId), { force: true }));
    }
    try {
      await Promise.all(deletions);
    } catch (error) {
      this.logger.warn("failed to delete terminal history", {
        threadId,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushPersistQueue(threadId: string, terminalId: string): Promise<void> {
    const persistenceKey = toSessionKey(threadId, terminalId);
    this.clearPersistTimer(threadId, terminalId);

    while (true) {
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory !== undefined) {
        this.pendingPersistHistory.delete(persistenceKey);
        await this.enqueuePersistWrite(threadId, terminalId, pendingHistory);
      }

      const pending = this.persistQueues.get(persistenceKey);
      if (!pending) {
        return;
      }
      await pending.catch(() => undefined);
    }
  }

  private createMirror(cols: number, rows: number): TerminalMirrorState {
    return {
      terminal: new HeadlessTerminal({
        allowProposedApi: true,
        cols,
        rows,
        scrollback: Math.max(DEFAULT_SCROLLBACK, this.historyLineLimit),
      }),
      pending: Promise.resolve(),
    };
  }

  private async rebuildMirror(
    session: Pick<TerminalSessionState, "threadId" | "terminalId" | "cols" | "rows">,
    history: string,
  ): Promise<void> {
    const key = toSessionKey(session.threadId, session.terminalId);
    const mirror = this.createMirror(session.cols, session.rows);
    this.mirrors.set(key, mirror);
    if (history.length > 0) {
      await this.writeMirror(mirror, history);
    }
  }

  private ensureMirror(
    session: Pick<TerminalSessionState, "threadId" | "terminalId" | "cols" | "rows">,
  ): TerminalMirrorState {
    const key = toSessionKey(session.threadId, session.terminalId);
    const existing = this.mirrors.get(key);
    if (existing) {
      return existing;
    }
    const mirror = this.createMirror(session.cols, session.rows);
    this.mirrors.set(key, mirror);
    return mirror;
  }

  private queueMirrorWrite(
    session: Pick<TerminalSessionState, "threadId" | "terminalId" | "cols" | "rows">,
    data: string,
  ): void {
    const mirror = this.ensureMirror(session);
    mirror.pending = mirror.pending
      .then(() => this.writeMirror(mirror, data))
      .catch((error) => {
        this.logger.warn("failed to update terminal mirror", {
          threadId: session.threadId,
          terminalId: session.terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async writeMirror(mirror: TerminalMirrorState, data: string): Promise<void> {
    await new Promise<void>((resolve) => {
      mirror.terminal.write(data, () => resolve());
    });
  }

  private resizeMirror(
    session: Pick<TerminalSessionState, "threadId" | "terminalId" | "cols" | "rows">,
  ): void {
    this.ensureMirror(session).terminal.resize(session.cols, session.rows);
  }

  private async readRenderedLines(
    threadId: string,
    terminalId: string,
  ): Promise<{
    lines: string[];
    viewportStart: number;
    viewportEnd: number;
  }> {
    const sessionKey = toSessionKey(threadId, terminalId);
    let session = this.sessions.get(sessionKey);

    if (!session) {
      const persisted = await this.readPersistedEntry(threadId, terminalId);
      if (!persisted) {
        throw new Error(`Unknown terminal thread: ${threadId}, terminal: ${terminalId}`);
      }
      await this.rebuildMirror(persisted, await this.readHistory(threadId, terminalId));
      session = {
        ...persisted,
        status: "exited",
        pid: null,
        history: "",
        exitCode: null,
        exitSignal: null,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        runtimeEnv: null,
      };
    } else if (!this.mirrors.has(sessionKey)) {
      await this.rebuildMirror(session, session.history);
    }

    const mirror = this.mirrors.get(sessionKey);
    if (!mirror) {
      return {
        lines: [],
        viewportStart: 0,
        viewportEnd: 0,
      };
    }
    await mirror.pending.catch(() => undefined);

    const buffer = mirror.terminal.buffer.active;
    const lines: string[] = [];
    for (let lineIndex = 0; lineIndex < buffer.length; lineIndex += 1) {
      const line = buffer.getLine(lineIndex);
      lines.push(line ? line.translateToString(false).trimEnd() : "");
    }
    const viewportStart = Math.max(0, buffer.baseY);
    const viewportEnd = Math.min(lines.length, viewportStart + session.rows);
    return {
      lines,
      viewportStart,
      viewportEnd,
    };
  }

  private async listTerminalEntries(threadId: string): Promise<TerminalListEntry[]> {
    const persistedByTerminalId = new Map<string, PersistedTerminalEntry>();
    for (const entry of await this.listPersistedEntries(threadId)) {
      persistedByTerminalId.set(entry.terminalId, entry);
    }

    for (const session of this.sessionsForThread(threadId)) {
      persistedByTerminalId.set(session.terminalId, {
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: session.createdAt,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        updatedAt: session.updatedAt,
      });
    }

    const entries = [...persistedByTerminalId.values()].map((entry) => {
      const live = this.sessions.get(toSessionKey(entry.threadId, entry.terminalId));
      return live
        ? {
            threadId: entry.threadId,
            terminalId: entry.terminalId,
            createdAt: entry.createdAt,
            cwd: live.cwd,
            cols: live.cols,
            rows: live.rows,
            updatedAt: live.updatedAt,
            status: live.status,
            pid: live.pid,
            hasRunningSubprocess: live.hasRunningSubprocess,
          }
        : {
            threadId: entry.threadId,
            terminalId: entry.terminalId,
            createdAt: entry.createdAt,
            cwd: entry.cwd,
            cols: entry.cols,
            rows: entry.rows,
            updatedAt: entry.updatedAt,
            status: "exited" as const,
            pid: null,
            hasRunningSubprocess: false,
          };
    });

    return entries.toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.terminalId.localeCompare(right.terminalId),
    );
  }

  private toTerminalSummary(entry: TerminalListEntry, ordinal: number): TerminalSummary {
    return {
      threadId: entry.threadId,
      terminalId: entry.terminalId,
      label: `Terminal ${ordinal}`,
      ordinal,
      cwd: entry.cwd,
      status: entry.status,
      pid: entry.pid,
      hasRunningSubprocess: entry.hasRunningSubprocess,
      updatedAt: entry.updatedAt,
    };
  }

  private async listPersistedEntries(threadId: string): Promise<PersistedTerminalEntry[]> {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    const threadBase = toSafeThreadId(threadId);
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(this.logsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const discovered = new Map<string, PersistedTerminalEntry>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".log")) {
        continue;
      }
      if (
        entry.name !== `${threadBase}.log` &&
        entry.name !== `${legacySafeThreadId(threadId)}.log` &&
        !entry.name.startsWith(threadPrefix)
      ) {
        continue;
      }

      const terminalId = this.terminalIdFromLogName(threadId, entry.name);
      if (!terminalId || discovered.has(terminalId)) {
        continue;
      }

      const metadata = await this.readMetadata(threadId, terminalId);
      const stats = await fs.promises.stat(path.join(this.logsDir, entry.name)).catch(() => null);
      discovered.set(terminalId, {
        threadId,
        terminalId,
        createdAt: metadata?.createdAt ?? stats?.mtime.toISOString() ?? new Date(0).toISOString(),
        cwd: metadata?.cwd ?? "",
        cols: metadata?.cols ?? DEFAULT_OPEN_COLS,
        rows: metadata?.rows ?? DEFAULT_OPEN_ROWS,
        updatedAt: stats?.mtime.toISOString() ?? metadata?.createdAt ?? new Date(0).toISOString(),
      });
    }

    for (const session of this.sessionsForThread(threadId)) {
      if (discovered.has(session.terminalId)) {
        continue;
      }
      discovered.set(session.terminalId, {
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: session.createdAt,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        updatedAt: session.updatedAt,
      });
    }

    return [...discovered.values()];
  }

  private async readPersistedEntry(
    threadId: string,
    terminalId: string,
  ): Promise<PersistedTerminalEntry | null> {
    const metadata = await this.readMetadata(threadId, terminalId);
    const stats =
      (await fs.promises.stat(this.historyPath(threadId, terminalId)).catch(() => null)) ??
      (terminalId === DEFAULT_TERMINAL_ID
        ? await fs.promises.stat(this.legacyHistoryPath(threadId)).catch(() => null)
        : null);
    if (!metadata && !stats) {
      return null;
    }

    return {
      threadId,
      terminalId,
      createdAt: metadata?.createdAt ?? stats?.mtime.toISOString() ?? new Date(0).toISOString(),
      cwd: metadata?.cwd ?? "",
      cols: metadata?.cols ?? DEFAULT_OPEN_COLS,
      rows: metadata?.rows ?? DEFAULT_OPEN_ROWS,
      updatedAt: stats?.mtime.toISOString() ?? metadata?.createdAt ?? new Date(0).toISOString(),
    };
  }

  private async persistMetadata(
    session: Pick<
      TerminalSessionState,
      "threadId" | "terminalId" | "createdAt" | "cwd" | "cols" | "rows"
    >,
  ): Promise<void> {
    const metadata: PersistedTerminalMetadata = {
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: session.createdAt,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
    };

    try {
      await fs.promises.writeFile(
        this.metadataPath(session.threadId, session.terminalId),
        JSON.stringify(metadata),
        "utf8",
      );
    } catch (error) {
      this.logger.warn("failed to persist terminal metadata", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async readMetadata(
    threadId: string,
    terminalId: string,
  ): Promise<PersistedTerminalMetadata | null> {
    try {
      const raw = await fs.promises.readFile(this.metadataPath(threadId, terminalId), "utf8");
      const decoded = JSON.parse(raw) as Partial<PersistedTerminalMetadata>;
      if (
        decoded.threadId !== threadId ||
        decoded.terminalId !== terminalId ||
        typeof decoded.createdAt !== "string" ||
        typeof decoded.cwd !== "string" ||
        !Number.isInteger(decoded.cols) ||
        !Number.isInteger(decoded.rows)
      ) {
        return null;
      }
      return {
        threadId,
        terminalId,
        createdAt: decoded.createdAt,
        cwd: decoded.cwd,
        cols: decoded.cols as number,
        rows: decoded.rows as number,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      this.logger.warn("failed to read terminal metadata", {
        threadId,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private terminalIdFromLogName(threadId: string, filename: string): string | null {
    const threadBase = toSafeThreadId(threadId);
    if (filename === `${threadBase}.log` || filename === `${legacySafeThreadId(threadId)}.log`) {
      return DEFAULT_TERMINAL_ID;
    }

    if (!filename.startsWith(`${threadBase}_`) || !filename.endsWith(".log")) {
      return null;
    }

    const encodedTerminalId = filename.slice(threadBase.length + 1, -4);
    try {
      return decodeBase64UrlValue(encodedTerminalId);
    } catch {
      return null;
    }
  }

  private updateSubprocessPollingState(): void {
    const hasRunningSessions = [...this.sessions.values()].some(
      (session) => session.status === "running" && session.pid !== null,
    );
    if (hasRunningSessions) {
      this.ensureSubprocessPolling();
      return;
    }
    this.stopSubprocessPolling();
  }

  private ensureSubprocessPolling(): void {
    if (this.subprocessPollTimer) return;
    this.subprocessPollTimer = setInterval(() => {
      void this.pollSubprocessActivity();
    }, this.subprocessPollIntervalMs);
    this.subprocessPollTimer.unref?.();
    void this.pollSubprocessActivity();
  }

  private stopSubprocessPolling(): void {
    if (!this.subprocessPollTimer) return;
    clearInterval(this.subprocessPollTimer);
    this.subprocessPollTimer = null;
  }

  private async pollSubprocessActivity(): Promise<void> {
    if (this.subprocessPollInFlight) return;

    const runningSessions = [...this.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );
    if (runningSessions.length === 0) {
      this.stopSubprocessPolling();
      return;
    }

    this.subprocessPollInFlight = true;
    try {
      await Promise.all(
        runningSessions.map(async (session) => {
          const terminalPid = session.pid;
          let hasRunningSubprocess = false;
          try {
            hasRunningSubprocess = await this.subprocessChecker(terminalPid);
          } catch (error) {
            this.logger.warn("failed to check terminal subprocess activity", {
              threadId: session.threadId,
              terminalId: session.terminalId,
              terminalPid,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          const liveSession = this.sessions.get(toSessionKey(session.threadId, session.terminalId));
          if (!liveSession || liveSession.status !== "running" || liveSession.pid !== terminalPid) {
            return;
          }
          if (liveSession.hasRunningSubprocess === hasRunningSubprocess) {
            return;
          }

          liveSession.hasRunningSubprocess = hasRunningSubprocess;
          liveSession.updatedAt = new Date().toISOString();
          this.emitEvent({
            type: "activity",
            threadId: liveSession.threadId,
            terminalId: liveSession.terminalId,
            createdAt: new Date().toISOString(),
            hasRunningSubprocess,
          });
        }),
      );
    } finally {
      this.subprocessPollInFlight = false;
    }
  }

  private async assertValidCwd(cwd: string): Promise<void> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Terminal cwd does not exist: ${cwd}`, { cause: error });
      }
      throw error;
    }
    if (!stats.isDirectory()) {
      throw new Error(`Terminal cwd is not a directory: ${cwd}`);
    }
  }

  private async closeSession(
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
  ): Promise<void> {
    const key = toSessionKey(threadId, terminalId);
    const session = this.sessions.get(key);
    if (session) {
      this.stopProcess(session);
      this.sessions.delete(key);
    }
    this.mirrors.delete(key);
    this.updateSubprocessPollingState();
    await this.flushPersistQueue(threadId, terminalId);
    if (deleteHistory) {
      await this.deleteHistory(threadId, terminalId);
    }
  }

  private sessionsForThread(threadId: string): TerminalSessionState[] {
    return [...this.sessions.values()].filter((session) => session.threadId === threadId);
  }

  private async deleteAllHistoryForThread(threadId: string): Promise<void> {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    try {
      const entries = await fs.promises.readdir(this.logsDir, { withFileTypes: true });
      const removals = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter(
          (name) =>
            name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix) ||
            name === `${toSafeThreadId(threadId)}.meta.json`,
        )
        .map((name) => fs.promises.rm(path.join(this.logsDir, name), { force: true }));
      await Promise.all(removals);
    } catch (error) {
      this.logger.warn("failed to delete terminal histories for thread", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requireSession(threadId: string, terminalId: string): TerminalSessionState {
    const session = this.sessions.get(toSessionKey(threadId, terminalId));
    if (!session) {
      throw new Error(`Unknown terminal thread: ${threadId}, terminal: ${terminalId}`);
    }
    return session;
  }

  private snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
    return {
      threadId: session.threadId,
      terminalId: session.terminalId,
      cwd: session.cwd,
      status: session.status,
      pid: session.pid,
      history: session.history,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      updatedAt: session.updatedAt,
    };
  }

  private emitEvent(event: TerminalEvent): void {
    this.emit("event", event);
  }

  private historyPath(threadId: string, terminalId: string): string {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(this.logsDir, `${threadPart}.log`);
    }
    return path.join(this.logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  }

  private metadataPath(threadId: string, terminalId: string): string {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(this.logsDir, `${threadPart}.meta.json`);
    }
    return path.join(this.logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.meta.json`);
  }

  private legacyHistoryPath(threadId: string): string {
    return path.join(this.logsDir, `${legacySafeThreadId(threadId)}.log`);
  }

  private async runWithThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.threadLocks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(threadId, current);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.threadLocks.get(threadId) === current) {
        this.threadLocks.delete(threadId);
      }
    }
  }
}

export const TerminalManagerLive = Layer.effect(
  TerminalManager,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const { join } = yield* Path.Path;
    const logsDir = join(stateDir, "logs", "terminals");

    const ptyAdapter = yield* PtyAdapter;
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => new TerminalManagerRuntime({ logsDir, ptyAdapter })),
      (r) => Effect.sync(() => r.dispose()),
    );

    return {
      open: (input) =>
        Effect.tryPromise({
          try: () => runtime.open(input),
          catch: (cause) => new TerminalError({ message: "Failed to open terminal", cause }),
        }),
      write: (input) =>
        Effect.tryPromise({
          try: () => runtime.write(input),
          catch: (cause) => new TerminalError({ message: "Failed to write to terminal", cause }),
        }),
      resize: (input) =>
        Effect.tryPromise({
          try: () => runtime.resize(input),
          catch: (cause) => new TerminalError({ message: "Failed to resize terminal", cause }),
        }),
      clear: (input) =>
        Effect.tryPromise({
          try: () => runtime.clear(input),
          catch: (cause) => new TerminalError({ message: "Failed to clear terminal", cause }),
        }),
      restart: (input) =>
        Effect.tryPromise({
          try: () => runtime.restart(input),
          catch: (cause) => new TerminalError({ message: "Failed to restart terminal", cause }),
        }),
      close: (input) =>
        Effect.tryPromise({
          try: () => runtime.close(input),
          catch: (cause) => new TerminalError({ message: "Failed to close terminal", cause }),
        }),
      list: (input) =>
        Effect.tryPromise({
          try: () => runtime.list(input),
          catch: (cause) => new TerminalError({ message: "Failed to list terminals", cause }),
        }),
      read: (input) =>
        Effect.tryPromise({
          try: () => runtime.read(input),
          catch: (cause) => new TerminalError({ message: "Failed to read terminal", cause }),
        }),
      subscribe: (listener) =>
        Effect.sync(() => {
          runtime.on("event", listener);
          return () => {
            runtime.off("event", listener);
          };
        }),
      dispose: Effect.sync(() => runtime.dispose()),
    } satisfies TerminalManagerShape;
  }),
);
