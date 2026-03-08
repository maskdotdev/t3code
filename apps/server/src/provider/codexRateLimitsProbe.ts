import { spawn } from "node:child_process";
import readline from "node:readline";

import { buildCodexInitializeParams } from "../codexAppServerManager";

const DEFAULT_TIMEOUT_MS = 5_000;
const ACCOUNT_READ_REQUEST_ID = 2;
const ACCOUNT_RATE_LIMITS_REQUEST_ID = 3;

interface CodexRateLimitsProbeOptions {
  readonly binaryPath?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homePath?: string;
  readonly timeoutMs?: number;
}

interface JsonRpcResponseEnvelope {
  readonly id?: string | number;
  readonly result?: unknown;
  readonly error?: {
    readonly message?: string;
  };
}

export async function readCodexRateLimitsSnapshot(
  options: CodexRateLimitsProbeOptions = {},
): Promise<unknown | null> {
  return await new Promise<unknown | null>((resolve, reject) => {
    const child = spawn(options.binaryPath ?? "codex", ["app-server"], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        ...(options.homePath ? { CODEX_HOME: options.homePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = readline.createInterface({ input: child.stdout });
    let settled = false;
    let stderr = "";

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stdout.close();
      fn();
    };

    const fail = (error: Error) => {
      settle(() => {
        child.kill("SIGTERM");
        reject(error);
      });
    };

    const timeout = setTimeout(() => {
      fail(new Error("Timed out while loading Codex rate limits."));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.once("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      const detail = stderr.trim();
      fail(
        new Error(
          detail.length > 0
            ? detail
            : `Codex app-server exited before returning rate limits (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    });

    stdout.on("line", (line) => {
      let parsed: JsonRpcResponseEnvelope;
      try {
        parsed = JSON.parse(line) as JsonRpcResponseEnvelope;
      } catch {
        return;
      }

      if (parsed.id === ACCOUNT_RATE_LIMITS_REQUEST_ID) {
        if (parsed.error?.message) {
          fail(new Error(parsed.error.message));
          return;
        }
        settle(() => {
          child.stdin.end();
          resolve(parsed.result ?? null);
        });
        return;
      }

      if (parsed.id === ACCOUNT_READ_REQUEST_ID && parsed.error?.message) {
        fail(new Error(parsed.error.message));
      }
    });

    const writeMessage = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    writeMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: buildCodexInitializeParams(),
    });
    writeMessage({
      jsonrpc: "2.0",
      method: "initialized",
    });
    writeMessage({
      jsonrpc: "2.0",
      id: ACCOUNT_READ_REQUEST_ID,
      method: "account/read",
      params: {
        refreshToken: true,
      },
    });
    writeMessage({
      jsonrpc: "2.0",
      id: ACCOUNT_RATE_LIMITS_REQUEST_ID,
      method: "account/rateLimits/read",
      params: null,
    });
  });
}
