import { makeAegisPyError } from "../../../aegispy-core/src/errors";
import { preflightRuntimeRequest } from "../../../aegispy-core/src/runtime/preflight";
import type {
  AegisPyRuntime,
  CreateRuntimeOptions,
  RuntimeCapabilities,
  RunRequest,
  RunResult,
} from "@aegispy/core";
import { InProcessTransport } from "./in-process-transport";
import { RustWorkerTransport } from "./rust-worker-transport";
import type { WorkerTransport } from "./worker-transport";
import type { IsolationProfile } from "./isolation-profile";
import type {
  WorkerExecutionBackendInfo,
  WorkerExecutionMode,
} from "./worker-execution-mode";
import {
  resolveCurrentServerBundle,
  type ServerBundleRecord,
} from "./server-bundle-manifest";
import { resolveServerPackageLayer } from "./server-package-layer";
import { createServerRuntimeCapabilities } from "./server-runtime-capabilities";

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
      subsystem: "node-runtime",
    }),
  };
}

export type NodeTransportMode = "process" | "inprocess";

interface TransportSelection {
  transport: WorkerTransport;
  mode: NodeTransportMode;
  bundle: ServerBundleRecord;
  packageSetVersion: string;
  isolationProfile: IsolationProfile | null;
  executionMode: WorkerExecutionMode | null;
  executionBackend: WorkerExecutionBackendInfo | null;
}

export function resolveNodeTransportMode(
  env: NodeJS.ProcessEnv = process.env,
): NodeTransportMode {
  const raw = (env.AEGISPY_NODE_TRANSPORT ?? "process").trim().toLowerCase();
  if (raw === "process") return "process";
  if (raw === "inprocess") return "inprocess";
  throw new Error(
    "invalid AEGISPY_NODE_TRANSPORT value, expected process or inprocess",
  );
}

async function createTransport(
  opts: CreateRuntimeOptions,
): Promise<TransportSelection> {
  const mode = resolveNodeTransportMode();
  if (mode === "process") {
    const packageLayer = await resolveServerPackageLayer(
      opts.packages,
      opts.packageLockfile,
    );
    const transport = new RustWorkerTransport({
      host: "node",
      projectRoots: opts.projectRoots,
      packageRoots: packageLayer.packageRoots,
      tempRoot: opts.tempRoot,
    });
    return {
      transport,
      mode,
      bundle: transport.bundle,
      packageSetVersion: packageLayer.packageSetVersion,
      isolationProfile: transport.isolationProfile,
      executionMode: transport.executionMode,
      executionBackend: transport.executionBackend,
    };
  }
  if ((opts.packages?.length ?? 0) > 0) {
    throw makeAegisPyError(
      "AEG-ENGINE",
      "server package layers require process transport",
      {
        host: "node",
        reason: "package_layers_require_process_transport",
      },
    );
  }
  return {
    transport: new InProcessTransport(),
    mode,
    bundle: resolveCurrentServerBundle(),
    packageSetVersion: "base",
    isolationProfile: null,
    executionMode: null,
    executionBackend: null,
  };
}

export class NodeRuntime implements AegisPyRuntime {
  public readonly host = "node" as const;

  private readonly transport: WorkerTransport;

  private readonly bundle: ServerBundleRecord;

  private readonly packageSetVersion: string;

  public readonly transportKind: NodeTransportMode;

  public readonly isolationProfile: IsolationProfile | null;

  public readonly executionMode: WorkerExecutionMode | null;

  public readonly executionBackend: WorkerExecutionBackendInfo | null;

  private closed = false;

  public constructor(selection: TransportSelection) {
    this.transport = selection.transport;
    this.transportKind = selection.mode;
    this.bundle = selection.bundle;
    this.packageSetVersion = selection.packageSetVersion;
    this.isolationProfile = selection.isolationProfile;
    this.executionMode = selection.executionMode;
    this.executionBackend = selection.executionBackend;
  }

  public capabilities(): RuntimeCapabilities {
    return createServerRuntimeCapabilities(
      this.host,
      this.transportKind,
      this.bundle,
      this.packageSetVersion,
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

export async function createNodeRuntime(
  opts: CreateRuntimeOptions,
): Promise<AegisPyRuntime> {
  if (opts.host !== "node") {
    throw makeAegisPyError("AEG-UNSUPPORTED-HOST", "unsupported host", {
      host: opts.host,
    });
  }
  return new NodeRuntime(await createTransport(opts));
}
