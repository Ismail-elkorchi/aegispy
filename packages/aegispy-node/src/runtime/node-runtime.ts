import { makeAegisPyError } from "../../../aegispy-core/src/errors";
import { validateRunRequest } from "../../../aegispy-core/src/contracts/validation";
import type {
  AegisPyRuntime,
  CreateRuntimeOptions,
  RunRequest,
  RunResult,
} from "@aegispy/core";
import { InProcessTransport } from "./in-process-transport";
import { RustWorkerTransport } from "./rust-worker-transport";
import type { WorkerTransport } from "./worker-transport";

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

function createTransport(): WorkerTransport {
  if (process.env.AEGISPY_NODE_TRANSPORT === "process") {
    return new RustWorkerTransport();
  }
  return new InProcessTransport();
}

export class NodeRuntime implements AegisPyRuntime {
  public readonly host = "node" as const;

  private readonly transport: WorkerTransport;

  private closed = false;

  public constructor(transport: WorkerTransport = createTransport()) {
    this.transport = transport;
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

    if (req.host !== "node") {
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

export async function createNodeRuntime(
  opts: CreateRuntimeOptions,
): Promise<AegisPyRuntime> {
  if (opts.host !== "node") {
    return new NodeRuntime(new InProcessTransport());
  }
  return new NodeRuntime();
}
