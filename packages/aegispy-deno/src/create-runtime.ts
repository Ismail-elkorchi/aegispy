import { makeAegisPyError } from "../../aegispy-core/src/errors";
import { simulateRun } from "../../aegispy-core/src/execution/simulated";
import { validateRunRequest } from "../../aegispy-core/src/contracts/validation";
import type {
  AegisPyRuntime,
  CreateRuntimeOptions,
  RunRequest,
  RunResult,
} from "@aegispy/core";

function runtimeError(message: string): RunResult {
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
      termination: "internal_error",
      audit: [],
    },
    error: makeAegisPyError("AEG-INTERNAL", message, {
      subsystem: "deno-runtime",
    }),
  };
}

export class DenoRuntime implements AegisPyRuntime {
  public readonly host = "deno" as const;

  private closed = false;

  public async run(req: RunRequest): Promise<RunResult> {
    if (this.closed) {
      return runtimeError("runtime closed");
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
      return runtimeError("host mismatch");
    }

    return simulateRun(req);
  }

  public async close(): Promise<void> {
    this.closed = true;
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
