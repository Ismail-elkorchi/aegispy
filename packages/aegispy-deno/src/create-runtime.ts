import { makeAegisPyError } from "../../aegispy-core/src/errors";
import { validateRunRequest } from "../../aegispy-core/src/contracts/validation";
import type {
  AegisPyRuntime,
  CreateRuntimeOptions,
  RunRequest,
  RunResult,
} from "@aegispy/core";
import { InProcessTransport } from "../../aegispy-node/src/runtime/in-process-transport";
import type { IsolationProfile } from "../../aegispy-node/src/runtime/isolation-profile";
import { RustWorkerTransport } from "../../aegispy-node/src/runtime/rust-worker-transport";
import type { WorkerTransport } from "../../aegispy-node/src/runtime/worker-transport";

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
  isolationProfile: IsolationProfile | null;
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

function createTransport(): TransportSelection {
  const mode = resolveDenoTransportMode();
  if (mode === "process") {
    const transport = new RustWorkerTransport();
    return {
      transport,
      mode,
      isolationProfile: transport.isolationProfile,
    };
  }
  return {
    transport: new InProcessTransport(),
    mode,
    isolationProfile: null,
  };
}

export class DenoRuntime implements AegisPyRuntime {
  public readonly host = "deno" as const;

  private readonly transport: WorkerTransport;

  public readonly transportKind: DenoTransportMode;

  public readonly isolationProfile: IsolationProfile | null;

  private closed = false;

  public constructor(selection: TransportSelection = createTransport()) {
    this.transport = selection.transport;
    this.transportKind = selection.mode;
    this.isolationProfile = selection.isolationProfile;
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

    if (req.host !== "deno") {
      return engineErrorResult("host mismatch");
    }

    return this.transport.run(req).catch((error: unknown) => {
      return engineErrorResult(
        error instanceof Error ? error.message : "unknown transport error",
      );
    });
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
  return new DenoRuntime();
}
