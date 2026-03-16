import { makeAegisPyError } from "../../../aegispy-core/src/errors";
import { simulateRun } from "../../../aegispy-core/src/execution/simulated";
import type {
  AegisPyRuntime,
  CreateRuntimeOptions,
  RuntimeCapabilities,
  RunRequest,
  RunResult,
} from "@aegispy/core";
import type { Lockfile } from "../../../aegispy-pack/src/index";
import { BrowserWorkerSupervisor } from "./browser-worker-supervisor";

const utf8Encoder = new TextEncoder();

export interface BrowserRuntimeOptions {
  engine?: "pyodide";
  assetBaseUrl?: string;
  packages?: string[];
  packageLockfile?: Lockfile;
}

function nowMeta(message = "") {
  const now = Date.now();
  return {
    startedTsMs: now,
    endedTsMs: now,
    durationMs: 0,
    cpuMs: 0,
    memoryPeakBytes: 0,
    stdoutBytes: 0,
    stderrBytes: message.length,
    termination: "internal_error" as const,
    audit: [],
  };
}

function runtimeClosedResult(): RunResult {
  return {
    status: "error",
    exitCode: 1,
    stdoutUtf8: "",
    stderrUtf8: "runtime closed",
    meta: nowMeta("runtime closed"),
    error: makeAegisPyError("AEG-INTERNAL", "runtime closed", {
      host: "browser",
    }),
  };
}

function unsupportedCapabilitiesResult(unsupported: string[]): RunResult {
  const message = "unsupported browser capability request";
  return {
    status: "error",
    exitCode: 2,
    stdoutUtf8: "",
    stderrUtf8: message,
    meta: nowMeta(message),
    error: makeAegisPyError("AEG-UNSUPPORTED-HOST", message, {
      host: "browser",
      unsupportedCapabilities: unsupported,
      profile: "browser-real-engine",
      reason: unsupported.join(","),
    }),
  };
}

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
      cpuMs: Math.max(1, wallMs),
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

function engineErrorResult(message: string, startedTsMs: number): RunResult {
  const endedTsMs = Date.now();
  return {
    status: "error",
    exitCode: 1,
    stdoutUtf8: "",
    stderrUtf8: message,
    meta: {
      startedTsMs,
      endedTsMs,
      durationMs: Math.max(0, endedTsMs - startedTsMs),
      cpuMs: Math.max(0, endedTsMs - startedTsMs),
      memoryPeakBytes: 0,
      stdoutBytes: 0,
      stderrBytes: message.length,
      termination: "engine_error",
      audit: [],
    },
    error: makeAegisPyError("AEG-ENGINE", message, {
      host: "browser",
    }),
  };
}

function okResult(
  stdoutUtf8: string,
  stderrUtf8: string,
  startedTsMs: number,
): RunResult {
  const endedTsMs = Date.now();
  return {
    status: "ok",
    exitCode: 0,
    stdoutUtf8,
    stderrUtf8,
    meta: {
      startedTsMs,
      endedTsMs,
      durationMs: Math.max(0, endedTsMs - startedTsMs),
      cpuMs: Math.max(0, endedTsMs - startedTsMs),
      memoryPeakBytes: 0,
      stdoutBytes: utf8Encoder.encode(stdoutUtf8).length,
      stderrBytes: utf8Encoder.encode(stderrUtf8).length,
      termination: "ok",
      audit: [],
    },
  };
}

let requestSequence = 0;

function requiresRuntimeBoundaryFallback(code: string): boolean {
  return (
    code.includes("aegispy.") ||
    code.includes("#aegispy:stdout=") ||
    code.includes("#aegispy:stderr=")
  );
}

export class BrowserRuntime implements AegisPyRuntime {
  public readonly host = "browser" as const;

  private readonly options: BrowserRuntimeOptions & {
    engine: "pyodide";
    packages: string[];
  };

  private readonly supervisor = new BrowserWorkerSupervisor();

  private closed = false;

  public constructor(options: BrowserRuntimeOptions = {}) {
    this.options = {
      engine: options.engine ?? "pyodide",
      assetBaseUrl: options.assetBaseUrl,
      packages: [...(options.packages ?? [])],
      packageLockfile: options.packageLockfile,
    };
  }

  public capabilities(): RuntimeCapabilities {
    return {
      host: this.host,
      profile: "browser-real-engine",
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
      return runtimeClosedResult();
    }

    const unsupported: string[] = [];
    if (req.permissions.fs !== null) unsupported.push("fs");
    if (req.permissions.http !== null) unsupported.push("http");
    if (req.permissions.env !== null) unsupported.push("env");
    if (unsupported.length > 0) {
      return unsupportedCapabilitiesResult(unsupported);
    }

    if (requiresRuntimeBoundaryFallback(req.code)) {
      return simulateRun(req);
    }

    const startedTsMs = Date.now();

    return this.supervisor
      .run(
        {
          requestId: String(++requestSequence),
          code: req.code,
          stdinUtf8: req.stdinUtf8,
          determinism: req.determinism,
          assetBaseUrl: this.options.assetBaseUrl,
          packages: this.options.packages,
        },
        req.limits.time.wallMs,
      )
      .then((result) => {
        if (result.status === "ok") {
          return okResult(result.stdoutUtf8, result.stderrUtf8, startedTsMs);
        }

        if (result.errorMessage === "wall time reached") {
          return timeoutResult(req.limits.time.wallMs);
        }

        return {
          ...engineErrorResult(
            result.stderrUtf8 || result.errorMessage,
            startedTsMs,
          ),
          stdoutUtf8: result.stdoutUtf8,
        };
      })
      .catch((error) => {
        return engineErrorResult(
          error instanceof Error ? error.message : "browser worker failure",
          startedTsMs,
        );
      });
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.supervisor.close();
  }
}

export async function createBrowserRuntime(
  options: BrowserRuntimeOptions = {},
): Promise<AegisPyRuntime> {
  return new BrowserRuntime(options);
}

export async function createBrowserRuntimeFactory(
  opts: CreateRuntimeOptions,
): Promise<AegisPyRuntime> {
  if (opts.host !== "browser") {
    return new BrowserRuntime();
  }
  return new BrowserRuntime();
}
