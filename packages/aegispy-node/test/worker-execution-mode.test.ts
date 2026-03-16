import { describe, expect, it } from "vitest";
import {
  resolveWorkerExecutionMode,
  resolveWorkerLaunchSpec,
} from "../src/runtime/worker-execution-mode";

describe("worker execution mode", () => {
  it("defaults to process mode", () => {
    expect(resolveWorkerExecutionMode({})).toBe("process");
  });

  it("marks microvm mode unavailable without a launcher", () => {
    const launchSpec = resolveWorkerLaunchSpec({
      command: "/tmp/aegispy-worker",
      args: [],
      componentBinaryPath: "/tmp/aegispy.component.wasm",
      repoRoot: "/tmp",
      workerBinaryPath: "/tmp/aegispy-worker",
      env: {
        AEGISPY_WORKER_EXECUTION_MODE: "microvm",
      },
    });

    expect(launchSpec.backend.mode).toBe("microvm");
    expect(launchSpec.backend.available).toBe(false);
    expect(launchSpec.backend.reason).toContain("AEGISPY_MICROVM_LAUNCHER");
  });

  it("resolves a configured launcher contract for microvm mode", () => {
    const launchSpec = resolveWorkerLaunchSpec({
      command: "/tmp/aegispy-worker",
      args: ["--stdio"],
      componentBinaryPath: "/tmp/aegispy.component.wasm",
      repoRoot: "/tmp",
      workerBinaryPath: "/tmp/aegispy-worker",
      env: {
        AEGISPY_WORKER_EXECUTION_MODE: "microvm",
        AEGISPY_MICROVM_LAUNCHER: "/bin/sh",
        AEGISPY_MICROVM_LAUNCHER_ARGS_JSON:
          '["-lc","exec \\"$AEGISPY_MICROVM_WORKER_COMMAND\\""]',
      },
    });

    expect(launchSpec.backend.mode).toBe("microvm");
    expect(launchSpec.backend.available).toBe(true);
    expect(launchSpec.backend.backendName).toBe("microvm-launcher");
    expect(launchSpec.command).toBe("/bin/sh");
    expect(launchSpec.args).toEqual([
      "-lc",
      'exec "$AEGISPY_MICROVM_WORKER_COMMAND"',
    ]);
    expect(launchSpec.env.AEGISPY_MICROVM_WORKER_BINARY).toBe(
      "/tmp/aegispy-worker",
    );
    expect(launchSpec.env.AEGISPY_MICROVM_COMPONENT_BINARY).toBe(
      "/tmp/aegispy.component.wasm",
    );
    expect(launchSpec.env.AEGISPY_MICROVM_WORKER_ARGS_JSON).toBe('["--stdio"]');
  });
});
