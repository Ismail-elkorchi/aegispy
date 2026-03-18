import { makeAegisPyError } from "../../../aegispy-core/src/errors";
import { simulateRun } from "../../../aegispy-core/src/execution/simulated";
import {
  preflightRuntimeRequest,
  withRuntimeBoundaryAudit,
} from "../../../aegispy-core/src/runtime/preflight";
import {
  pyodideEngineAssetManifest,
  selectBrowserPackages,
  verifyBrowserEngineAssets,
} from "./browser-integrity";
import type {
  AegisPyRuntime,
  BrowserCapabilityState,
  BrowserCapabilityFamilies,
  CreateRuntimeOptions,
  RequestedNetworkCapability,
  RuntimeCapabilities,
  RunRequest,
  RunResult,
} from "@aegispy/core";
import type { Lockfile } from "../../../aegispy-pack/src/index";
import { BrowserWorkerSupervisor } from "./browser-worker-supervisor";

const utf8Encoder = new TextEncoder();

function browserNetworkState(): BrowserCapabilityState {
  return typeof process !== "undefined" && process.versions?.node
    ? "available_granted"
    : typeof globalThis.XMLHttpRequest === "function"
      ? "available_granted"
      : "unavailable";
}

function browserCapabilityFamilies(): BrowserCapabilityFamilies {
  return {
    storage: "unavailable",
    network: browserNetworkState(),
    fileAccess: "unavailable",
    worker: "available_granted",
    handles: "unavailable",
  };
}

function policyDeniedResult(
  message: string,
  startedTsMs: number,
  detail: Record<string, unknown>,
): RunResult {
  const endedTsMs = Date.now();
  return {
    status: "error",
    exitCode: 13,
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
      termination: "policy_denied",
      audit: [
        {
          seq: 1,
          tsMs: startedTsMs,
          kind: "policy_denied",
          detailJson:
            typeof detail.reason === "string" ? detail.reason : message,
        },
      ],
    },
    error: makeAegisPyError("AEG-POLICY-DENIED", message, detail),
  };
}

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
  return engineErrorResultWithDetail(message, startedTsMs, {
    host: "browser",
  });
}

function engineErrorResultWithDetail(
  message: string,
  startedTsMs: number,
  detail: Record<string, unknown>,
): RunResult {
  const terminalAuditDetail =
    typeof detail.reason === "string" ? detail.reason : "engine_error";
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
      audit: [
        {
          seq: 1,
          tsMs: startedTsMs,
          kind: "engine_error",
          detailJson: terminalAuditDetail,
        },
      ],
    },
    error: makeAegisPyError("AEG-ENGINE", message, detail),
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

function browserRequestedNetwork(
  req: RunRequest,
): RequestedNetworkCapability | undefined {
  if (req.host !== "browser") {
    return undefined;
  }
  return req.requestedCapabilities?.network;
}

function materializeBrowserNetworkPermissions(req: RunRequest): RunRequest {
  const network = browserRequestedNetwork(req);
  if (network === undefined || req.permissions.http !== null) {
    return req;
  }

  return {
    ...req,
    permissions: {
      ...req.permissions,
      http: {
        allowOrigins: [...network.allowOrigins],
        denyOrigins: [...(network.denyOrigins ?? [])],
        maxRequests: network.maxRequests,
        maxBytes: network.maxBytes,
      },
    },
  };
}

function requiresRuntimeBoundaryFallback(
  req: RunRequest,
  capabilities: RuntimeCapabilities,
): boolean {
  const code = req.code;
  if (code.includes("#aegispy:stdout=") || code.includes("#aegispy:stderr=")) {
    return true;
  }

  if (/aegispy\.(fs_read|fs_write|env_get)\s*\(/u.test(code)) {
    return true;
  }

  if (code.includes("aegispy.http_get(")) {
    return !(
      browserRequestedNetwork(req) !== undefined &&
      capabilities.capabilityFamilies?.network === "available_granted"
    );
  }

  return false;
}

export class BrowserRuntime implements AegisPyRuntime {
  public readonly host = "browser" as const;

  private readonly options: BrowserRuntimeOptions & {
    engine: "pyodide";
    packages: string[];
  };

  private readonly supervisor = new BrowserWorkerSupervisor();

  private closed = false;

  private integrityPromise: Promise<
    | {
        ok: true;
        packages: string[];
      }
    | {
        ok: false;
        message: string;
        detail: Record<string, unknown>;
      }
  > | null = null;

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
      capabilityFamilies: browserCapabilityFamilies(),
      fs: false,
      http: false,
      env: false,
      deterministic: true,
      hardened: false,
    };
  }

  private ensureIntegrity(): Promise<
    | {
        ok: true;
        packages: string[];
      }
    | {
        ok: false;
        message: string;
        detail: Record<string, unknown>;
      }
  > {
    if (this.integrityPromise !== null) {
      return this.integrityPromise;
    }

    this.integrityPromise = selectBrowserPackages(
      this.options.packages,
      this.options.packageLockfile,
    )
      .then((selection) => {
        if (!selection.ok) {
          return {
            ok: false as const,
            message: "browser package integrity check failed",
            detail: {
              host: "browser",
              reason: selection.failures[0] ?? "package_lockfile_invalid",
              failures: selection.failures,
            },
          };
        }

        if (!this.options.assetBaseUrl) {
          return {
            ok: true as const,
            packages: selection.packages,
          };
        }

        return verifyBrowserEngineAssets(
          this.options.assetBaseUrl,
          pyodideEngineAssetManifest,
        ).then((assetVerification) => {
          if (!assetVerification.ok) {
            return {
              ok: false as const,
              message: "browser engine integrity check failed",
              detail: {
                host: "browser",
                assetBaseUrl: this.options.assetBaseUrl,
                reason:
                  assetVerification.failures[0] ??
                  "engine_asset_verification_failed",
                failures: assetVerification.failures,
              },
            };
          }

          return {
            ok: true as const,
            packages: selection.packages,
          };
        });
      })
      .catch((error) => {
        return {
          ok: false as const,
          message: "browser engine integrity check failed",
          detail: {
            host: "browser",
            reason: "engine_asset_verification_failed",
            cause:
              error instanceof Error
                ? error.message
                : "browser integrity error",
          },
        };
      });

    return this.integrityPromise;
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
    const executableRequest = materializeBrowserNetworkPermissions(
      preflight.request,
    );

    const startedTsMs = Date.now();
    const integrity = await this.ensureIntegrity();
    if (!integrity.ok) {
      return withRuntimeBoundaryAudit(
        capabilities,
        engineErrorResultWithDetail(
          integrity.message,
          startedTsMs,
          integrity.detail,
        ),
      );
    }

    if (requiresRuntimeBoundaryFallback(preflight.request, capabilities)) {
      return withRuntimeBoundaryAudit(
        capabilities,
        simulateRun(executableRequest),
      );
    }

    return this.supervisor
      .run(
        {
          requestId: String(++requestSequence),
          code: executableRequest.code,
          stdinUtf8: executableRequest.stdinUtf8,
          determinism: executableRequest.determinism,
          assetBaseUrl: this.options.assetBaseUrl,
          packages: integrity.packages,
          network: browserRequestedNetwork(executableRequest),
        },
        executableRequest.limits.time.wallMs,
      )
      .then((result) => {
        if (result.status === "ok") {
          return withRuntimeBoundaryAudit(
            capabilities,
            okResult(result.stdoutUtf8, result.stderrUtf8, startedTsMs),
          );
        }

        if (
          result.errorCode === "AEG-POLICY-DENIED" ||
          result.termination === "policy_denied"
        ) {
          return withRuntimeBoundaryAudit(
            capabilities,
            policyDeniedResult(
              result.errorMessage || result.stderrUtf8 || "policy denied",
              startedTsMs,
              {
                host: "browser",
                reason: result.errorMessage || "policy_denied",
              },
            ),
          );
        }

        if (result.errorMessage === "wall time reached") {
          return withRuntimeBoundaryAudit(
            capabilities,
            timeoutResult(executableRequest.limits.time.wallMs),
          );
        }

        return withRuntimeBoundaryAudit(capabilities, {
          ...engineErrorResultWithDetail(
            result.stderrUtf8 || result.errorMessage,
            startedTsMs,
            {
              host: "browser",
              reason: result.errorMessage || "browser_worker_failure",
            },
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
  return new BrowserRuntime({
    packages: opts.packages,
    packageLockfile: opts.packageLockfile,
  });
}
