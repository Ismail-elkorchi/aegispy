import { makeAegisPyError } from "../../../aegispy-core/src/errors";
import { simulateRun } from "../../../aegispy-core/src/execution/simulated";
import {
  preflightRuntimeRequest,
  withRuntimeBoundaryAudit,
} from "../../../aegispy-core/src/runtime/preflight";
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
    const capabilities = this.capabilities();
    const preflight = preflightRuntimeRequest(
      {
        runtimeHost: this.host,
        capabilities,
        closed: this.closed,
      },
      req,
    );
    if (!preflight.ok) {
      return preflight.result;
    }

    if (requiresRuntimeBoundaryFallback(preflight.request.code)) {
      return withRuntimeBoundaryAudit(
        capabilities,
        simulateRun(preflight.request),
      );
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
        preflight.request.limits.time.wallMs,
      )
      .then((result) => {
        if (result.status === "ok") {
          return withRuntimeBoundaryAudit(
            capabilities,
            okResult(result.stdoutUtf8, result.stderrUtf8, startedTsMs),
          );
        }

        if (result.errorMessage === "wall time reached") {
          return withRuntimeBoundaryAudit(
            capabilities,
            timeoutResult(preflight.request.limits.time.wallMs),
          );
        }

        return withRuntimeBoundaryAudit(capabilities, {
          ...engineErrorResult(
            result.stderrUtf8 || result.errorMessage,
            startedTsMs,
          ),
          stdoutUtf8: result.stdoutUtf8,
        });
      })
      .catch((error) => {
        return withRuntimeBoundaryAudit(
          capabilities,
          engineErrorResult(
            error instanceof Error ? error.message : "browser worker failure",
            startedTsMs,
          ),
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
