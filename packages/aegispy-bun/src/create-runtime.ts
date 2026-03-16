import { makeAegisPyError } from "../../aegispy-core/src/errors";
import { validateRunRequest } from "../../aegispy-core/src/contracts/validation";
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
      subsystem: "bun-runtime",
    }),
  };
}

export type BunTransportMode = "process" | "simulation";

interface TransportSelection {
  transport: WorkerTransport;
  mode: BunTransportMode;
  isolationProfile: IsolationProfile | null;
  executionMode: WorkerExecutionMode | null;
  executionBackend: WorkerExecutionBackendInfo | null;
}

export function resolveBunTransportMode(
  env: NodeJS.ProcessEnv = process.env,
): BunTransportMode {
  const raw = (env.AEGISPY_BUN_TRANSPORT ?? "process").trim().toLowerCase();
  if (raw === "process") return "process";
  if (raw === "simulation") return "simulation";
  throw new Error(
    "invalid AEGISPY_BUN_TRANSPORT value, expected process or simulation",
  );
}

function createTransport(): TransportSelection {
  const mode = resolveBunTransportMode();
  if (mode === "process") {
    const transport = new RustWorkerTransport();
    return {
      transport,
      mode,
      isolationProfile: transport.isolationProfile,
      executionMode: transport.executionMode,
      executionBackend: transport.executionBackend,
    };
  }
  return {
    transport: new InProcessTransport(),
    mode,
    isolationProfile: null,
    executionMode: null,
    executionBackend: null,
  };
}

export class BunRuntime implements AegisPyRuntime {
  public readonly host = "bun" as const;

  private readonly transport: WorkerTransport;

  public readonly transportKind: BunTransportMode;

  public readonly isolationProfile: IsolationProfile | null;

  public readonly executionMode: WorkerExecutionMode | null;

  public readonly executionBackend: WorkerExecutionBackendInfo | null;

  private closed = false;

  public constructor(selection: TransportSelection = createTransport()) {
    this.transport = selection.transport;
    this.transportKind = selection.mode;
    this.isolationProfile = selection.isolationProfile;
    this.executionMode = selection.executionMode;
    this.executionBackend = selection.executionBackend;
  }

  public capabilities(): RuntimeCapabilities {
    const hardened = this.transportKind === "process";
    return {
      host: this.host,
      profile: "server-hardened",
      transport: this.transportKind,
      capabilityChannel: hardened ? "component-wit" : "none",
      fs: true,
      http: true,
      env: true,
      deterministic: true,
      hardened,
    };
  }

  public async run(req: RunRequest): Promise<RunResult> {
    if (this.closed) {
      return engineErrorResult("runtime closed");
    }

    const validated = validateRunRequest(req);
    if (!validated.ok) {
      return {
        status: "error",
        exitCode: 2,
        stdoutUtf8: "",
        stderrUtf8: "invalid request",
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
        error: makeAegisPyError("AEG-INVALID-REQUEST", "invalid request", {
          issues: validated.issues,
        }),
      };
    }

    if (req.host !== "bun") {
      return engineErrorResult("host mismatch");
    }

    return Promise.resolve(req)
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
  if (opts.host !== "bun") {
    throw makeAegisPyError("AEG-UNSUPPORTED-HOST", "unsupported host", {
      host: opts.host,
    });
  }
  return new BunRuntime();
}
