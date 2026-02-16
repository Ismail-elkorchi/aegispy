import { makeAegisPyError } from "../errors";
import { simulateRun } from "../execution/simulated";
import {
  validateRunRequest,
  validationIssuesToErrorDetail,
} from "../contracts/validation";
import type {
  AegisPyRuntime,
  CreateRuntimeOptions,
  HostKind,
  RunRequest,
  RunResult,
} from "../contracts/types";

export type RuntimeFactory = (
  opts: CreateRuntimeOptions,
) => Promise<AegisPyRuntime>;

class SimulatedRuntime implements AegisPyRuntime {
  public readonly host: HostKind;

  private closed = false;

  public constructor(host: HostKind) {
    this.host = host;
  }

  public async run(req: RunRequest): Promise<RunResult> {
    if (this.closed) {
      const now = Date.now();
      return {
        status: "error",
        exitCode: 1,
        stdoutUtf8: "",
        stderrUtf8: "runtime closed",
        meta: {
          startedTsMs: now,
          endedTsMs: now,
          durationMs: 0,
          cpuMs: 0,
          memoryPeakBytes: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          termination: "internal_error",
          audit: [],
        },
        error: makeAegisPyError("AEG-INTERNAL", "runtime closed", {
          host: this.host,
        }),
      };
    }

    const checked = validateRunRequest(req);
    if (!checked.ok) {
      const now = Date.now();
      return {
        status: "error",
        exitCode: 2,
        stdoutUtf8: "",
        stderrUtf8: "invalid request",
        meta: {
          startedTsMs: now,
          endedTsMs: now,
          durationMs: 0,
          cpuMs: 0,
          memoryPeakBytes: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          termination: "internal_error",
          audit: [],
        },
        error: makeAegisPyError(
          "AEG-INVALID-REQUEST",
          "invalid request",
          validationIssuesToErrorDetail(checked.issues),
        ),
      };
    }

    if (req.host !== this.host) {
      const now = Date.now();
      return {
        status: "error",
        exitCode: 2,
        stdoutUtf8: "",
        stderrUtf8: "host mismatch",
        meta: {
          startedTsMs: now,
          endedTsMs: now,
          durationMs: 0,
          cpuMs: 0,
          memoryPeakBytes: 0,
          stdoutBytes: 0,
          stderrBytes: 0,
          termination: "internal_error",
          audit: [],
        },
        error: makeAegisPyError("AEG-INVALID-REQUEST", "host mismatch", {
          runtimeHost: this.host,
          requestHost: req.host,
        }),
      };
    }

    return simulateRun(req);
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

const runtimeFactories = new Map<HostKind, RuntimeFactory>();

const defaultFactory: RuntimeFactory = async (opts) =>
  new SimulatedRuntime(opts.host);

const knownHosts: HostKind[] = ["node", "deno", "bun", "browser"];
for (const host of knownHosts) {
  runtimeFactories.set(host, defaultFactory);
}

export function registerRuntimeFactory(
  host: HostKind,
  factory: RuntimeFactory,
): void {
  runtimeFactories.set(host, factory);
}

export async function createRuntime(
  opts: CreateRuntimeOptions,
): Promise<AegisPyRuntime> {
  const factory = runtimeFactories.get(opts.host);
  if (!factory) {
    throw makeAegisPyError("AEG-UNSUPPORTED-HOST", "unsupported host", {
      host: opts.host,
    });
  }
  return factory(opts);
}
