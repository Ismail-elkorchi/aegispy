import { makeAegisPyError } from "../../aegispy-core/src/errors";
import { preflightRuntimeRequest } from "../../aegispy-core/src/runtime/preflight";
import type {
  AegisPyRuntime,
  CreateRuntimeOptions,
  RuntimeCapabilities,
  RunRequest,
  RunResult,
} from "@aegispy/core";
import { InProcessTransport } from "../../aegispy-node/src/runtime/in-process-transport";
import type { IsolationProfile } from "../../aegispy-node/src/runtime/isolation-profile";
import { RustWorkerTransport } from "../../aegispy-node/src/runtime/rust-worker-transport";
import {
  resolveCurrentServerBundle,
  type ServerBundleRecord,
} from "../../aegispy-node/src/runtime/server-bundle-manifest";
import { createServerRuntimeCapabilities } from "../../aegispy-node/src/runtime/server-runtime-capabilities";
import type { WorkerTransport } from "../../aegispy-node/src/runtime/worker-transport";
import type {
  WorkerExecutionBackendInfo,
  WorkerExecutionMode,
} from "../../aegispy-node/src/runtime/worker-execution-mode";

function engineErrorResult(message: string): RunResult {
  const now = Date.now();
  return {
    status: "error",
    exitCode: 1,
    stdoutUtf8: "",
    stderrUtf8: message,
    meta: {
      startedTsMs: now,
      endedTsMs: now,
      durationMs: 0,
      cpuMs: 0,
      memoryPeakBytes: 0,
      stdoutBytes: 0,
      stderrBytes: message.length,
      termination: "engine_error",
      audit: [],
    },
    error: makeAegisPyError("AEG-ENGINE", message, {
      subsystem: "deno-runtime",
    }),
  };
}

export type DenoTransportMode = "process" | "simulation";

interface TransportSelection {
  transport: WorkerTransport;
  mode: DenoTransportMode;
  bundle: ServerBundleRecord;
  isolationProfile: IsolationProfile | null;
  executionMode: WorkerExecutionMode | null;
  executionBackend: WorkerExecutionBackendInfo | null;
}

export function resolveDenoTransportMode(
  env: NodeJS.ProcessEnv = process.env,
): DenoTransportMode {
  const raw = (env.AEGISPY_DENO_TRANSPORT ?? "process").trim().toLowerCase();
  if (raw === "process") return "process";
  if (raw === "simulation") return "simulation";
  throw new Error(
    "invalid AEGISPY_DENO_TRANSPORT value, expected process or simulation",
  );
}

function createTransport(opts: CreateRuntimeOptions): TransportSelection {
  const mode = resolveDenoTransportMode();
  if (mode === "process") {
    const transport = new RustWorkerTransport({
      projectRoots: opts.projectRoots,
      tempRoot: opts.tempRoot,
    });
    return {
      transport,
      mode,
      bundle: transport.bundle,
      isolationProfile: transport.isolationProfile,
      executionMode: transport.executionMode,
      executionBackend: transport.executionBackend,
    };
  }
  return {
    transport: new InProcessTransport(),
    mode,
    bundle: resolveCurrentServerBundle(),
    isolationProfile: null,
    executionMode: null,
    executionBackend: null,
  };
}

export class DenoRuntime implements AegisPyRuntime {
  public readonly host = "deno" as const;

  private readonly transport: WorkerTransport;

  private readonly bundle: ServerBundleRecord;

  public readonly transportKind: DenoTransportMode;

  public readonly isolationProfile: IsolationProfile | null;

  public readonly executionMode: WorkerExecutionMode | null;

  public readonly executionBackend: WorkerExecutionBackendInfo | null;

  private closed = false;

  public constructor(selection: TransportSelection) {
    this.transport = selection.transport;
    this.transportKind = selection.mode;
    this.bundle = selection.bundle;
    this.isolationProfile = selection.isolationProfile;
    this.executionMode = selection.executionMode;
    this.executionBackend = selection.executionBackend;
  }

  public capabilities(): RuntimeCapabilities {
    return createServerRuntimeCapabilities(
      this.host,
      this.transportKind,
      this.bundle,
    );
  }

  public async run(req: RunRequest): Promise<RunResult> {
    const preflight = preflightRuntimeRequest(
      {
        runtimeHost: this.host,
        capabilities: this.capabilities(),
        closed: this.closed,
      },
      req,
    );
    if (!preflight.ok) {
      return preflight.result;
    }

    return Promise.resolve(preflight.request)
      .then((request) => this.transport.run(request))
      .catch((error: unknown) =>
        engineErrorResult(
          error instanceof Error ? error.message : "unknown transport error",
        ),
      );
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.transport.close();
  }
}

export async function createRuntime(
  opts: CreateRuntimeOptions,
): Promise<AegisPyRuntime> {
  if (opts.host !== "deno") {
    throw makeAegisPyError("AEG-UNSUPPORTED-HOST", "unsupported host", {
      host: opts.host,
    });
  }
  return new DenoRuntime(createTransport(opts));
}
