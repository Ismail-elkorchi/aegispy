import {
  registerRuntimeFactory,
  type RuntimeFactory,
} from "../../src/runtime/factory";
import { simulateRun } from "../../src/execution/simulated";
import { makeAegisPyError } from "../../src/errors";
import { validateRunRequest } from "../../src/contracts/validation";
import type {
  AegisPyRuntime,
  HostKind,
  RuntimeCapabilities,
  RunRequest,
  RunResult,
} from "../../src";

class TestSimulatedRuntime implements AegisPyRuntime {
  public readonly host: HostKind;

  private closed = false;

  public constructor(host: HostKind) {
    this.host = host;
  }

  public capabilities(): RuntimeCapabilities {
    return {
      host: this.host,
      profile: this.host === "browser" ? "browser-subset" : "server-hardened",
      transport: this.host === "browser" ? "worker" : "simulation",
      capabilityChannel: this.host === "browser" ? "worker-timeout" : "none",
      fs: this.host !== "browser",
      http: this.host !== "browser",
      env: this.host !== "browser",
      deterministic: true,
      hardened: false,
    };
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

    const validated = validateRunRequest(req);
    if (!validated.ok) {
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
        error: makeAegisPyError("AEG-INVALID-REQUEST", "invalid request", {
          host: this.host,
        }),
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

const testFactory: RuntimeFactory = async (opts) =>
  new TestSimulatedRuntime(opts.host);

let registered = false;

export function registerCoreTestRuntimeFactories(): void {
  if (registered) return;
  for (const host of ["node", "deno", "bun", "browser"] as const) {
    registerRuntimeFactory(host, testFactory);
  }
  registered = true;
}
