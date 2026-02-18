import { makeAegisPyError } from "../../../aegispy-core/src/errors";
import { simulateRun } from "../../../aegispy-core/src/execution/simulated";
import type {
  AegisPyRuntime,
  CreateRuntimeOptions,
  RuntimeCapabilities,
  RunRequest,
  RunResult,
} from "@aegispy/core";

function timeoutResult(wallMs: number): RunResult {
  const started = Date.now();
  const ended = started + wallMs;
  return {
    status: "error",
    exitCode: 124,
    stdoutUtf8: "",
    stderrUtf8: "wall time reached",
    meta: {
      startedTsMs: started,
      endedTsMs: ended,
      durationMs: wallMs,
      cpuMs: Math.max(1, Math.floor(wallMs / 2)),
      memoryPeakBytes: 0,
      stdoutBytes: 0,
      stderrBytes: 16,
      termination: "timeout",
      audit: [],
    },
    error: makeAegisPyError("AEG-TIMEOUT", "wall time reached", {
      host: "browser",
      wallMs,
    }),
  };
}

function unsupportedCapabilitiesResult(unsupported: string[]): RunResult {
  const now = Date.now();
  const reason = unsupported.join(",");
  return {
    status: "error",
    exitCode: 2,
    stdoutUtf8: "",
    stderrUtf8: "unsupported browser capability request",
    meta: {
      startedTsMs: now,
      endedTsMs: now,
      durationMs: 0,
      cpuMs: 0,
      memoryPeakBytes: 0,
      stdoutBytes: 0,
      stderrBytes: 38,
      termination: "internal_error",
      audit: [],
    },
    error: makeAegisPyError(
      "AEG-UNSUPPORTED-HOST",
      "unsupported browser capability request",
      {
        host: "browser",
        unsupportedCapabilities: unsupported,
        profile: "browser-subset",
        reason,
      },
    ),
  };
}

export class BrowserRuntime implements AegisPyRuntime {
  public readonly host = "browser" as const;

  private closed = false;

  public capabilities(): RuntimeCapabilities {
    return {
      host: this.host,
      profile: "browser-subset",
      transport: "worker",
      capabilityChannel: "worker-timeout",
      fs: false,
      http: false,
      env: false,
      deterministic: true,
      hardened: false,
    };
  }

  public async run(req: RunRequest): Promise<RunResult> {
    if (this.closed) {
      return {
        status: "error",
        exitCode: 1,
        stdoutUtf8: "",
        stderrUtf8: "runtime closed",
        meta: {
          startedTsMs: Date.now(),
          endedTsMs: Date.now(),
          durationMs: 0,
          cpuMs: 0,
          memoryPeakBytes: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          termination: "internal_error",
          audit: [],
        },
        error: makeAegisPyError("AEG-INTERNAL", "runtime closed", {
          host: "browser",
        }),
      };
    }

    const unsupported: string[] = [];
    if (req.permissions.fs !== null) unsupported.push("fs");
    if (req.permissions.http !== null) unsupported.push("http");
    if (req.permissions.env !== null) unsupported.push("env");
    if (unsupported.length > 0) {
      return unsupportedCapabilitiesResult(unsupported);
    }

    const emulateLongTask =
      req.code.includes("while True") ||
      req.code.includes("#aegispy:loop=infinite");

    const executionPromise = new Promise<RunResult>((resolve) => {
      const delay = emulateLongTask ? req.limits.time.wallMs + 25 : 0;
      setTimeout(() => resolve(simulateRun(req)), delay);
    });

    const timeoutPromise = new Promise<RunResult>((resolve) => {
      setTimeout(
        () => resolve(timeoutResult(req.limits.time.wallMs)),
        req.limits.time.wallMs,
      );
    });

    return Promise.race([executionPromise, timeoutPromise]);
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

export async function createBrowserRuntime(
  opts: CreateRuntimeOptions,
): Promise<AegisPyRuntime> {
  if (opts.host !== "browser") {
    return new BrowserRuntime();
  }
  return new BrowserRuntime();
}
