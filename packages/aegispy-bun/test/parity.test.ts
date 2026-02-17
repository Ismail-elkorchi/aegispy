import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type AegisPyRuntime } from "../src/index";
import { createRuntime as createNodeRuntime } from "../../aegispy-node/src/index";
import { createRuntime as createDenoRuntime } from "../../aegispy-deno/src/index";
import { createRuntime as createBrowserRuntime } from "../../aegispy-browser/src/index";
import type { RunResult } from "@aegispy/core";
import { writeArtifact } from "./helpers/artifact";

const originalEnv = { ...process.env };

function runtimeView(runtime: AegisPyRuntime): {
  transportKind?: string;
  isolationProfile?: unknown;
} {
  return runtime as unknown as {
    transportKind?: string;
    isolationProfile?: unknown;
  };
}

function capabilityChannel(result: RunResult): string | null {
  const audit = result.meta.audit as Array<{
    kind: string;
    detailJson: string;
  }>;
  const event = audit.find((entry) => entry.kind === "runtime_channel");
  if (!event) return null;
  const prefix = "capability_channel:";
  if (!event.detailJson.startsWith(prefix)) return null;
  return event.detailJson.slice(prefix.length) || null;
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("bun adapter parity", () => {
  it("defaults to process transport and matches node contract shape", async () => {
    process.env = { ...originalEnv };
    delete process.env.AEGISPY_BUN_TRANSPORT;

    const runtime: AegisPyRuntime = await createRuntime({ host: "bun" });
    const view = runtimeView(runtime);

    const result = await runtime.run({
      host: "bun",
      code: 'print("bun")',
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: null,
        http: null,
        env: null,
      },
      limits: {
        time: {
          wallMs: 1000,
          cpuMs: 1000,
        },
        bytes: {
          memoryBytes: 1024 * 1024,
          stdoutBytes: 1024,
          stderrBytes: 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 5,
        rngSeedHex: "feedface",
      },
    });

    await runtime.close();

    expect(view.transportKind).toBe("process");
    expect(result.meta.termination).toBe("ok");
    expect(capabilityChannel(result)).toBe("component-wit");

    writeArtifact("artifacts/e2e/bun-parity.json", {
      ok: true,
      invariants: ["INV-FEAT-0018"],
      transport: view.transportKind ?? "unknown",
      capabilityChannel: capabilityChannel(result),
      termination: result.meta.termination,
      status: result.status,
    });
  }, 600_000);

  it("uses simulation only when explicitly selected", async () => {
    process.env = { ...originalEnv, AEGISPY_BUN_TRANSPORT: "simulation" };

    const runtime: AegisPyRuntime = await createRuntime({ host: "bun" });
    const view = runtimeView(runtime);

    const result = await runtime.run({
      host: "bun",
      code: 'print("bun-sim")',
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: null,
        http: null,
        env: null,
      },
      limits: {
        time: {
          wallMs: 1000,
          cpuMs: 1000,
        },
        bytes: {
          memoryBytes: 1024 * 1024,
          stdoutBytes: 1024,
          stderrBytes: 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 5,
        rngSeedHex: "feedface",
      },
    });

    await runtime.close();

    expect(view.transportKind).toBe("simulation");
    expect(result.status).toBe("ok");
    expect(capabilityChannel(result)).toBe(null);
  }, 600_000);

  it("writes cross-host parity contract", async () => {
    process.env = {
      ...originalEnv,
      AEGISPY_NODE_TRANSPORT: "process",
      AEGISPY_DENO_TRANSPORT: "process",
      AEGISPY_BUN_TRANSPORT: "process",
    };

    const request = {
      code: 'print("parity")',
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: null,
        http: null,
        env: null,
      },
      limits: {
        time: {
          wallMs: 1000,
          cpuMs: 1000,
        },
        bytes: {
          memoryBytes: 1024 * 1024,
          stdoutBytes: 1024,
          stderrBytes: 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 9,
        rngSeedHex: "0a0b0c0d",
      },
    };

    const nodeRuntime = await createNodeRuntime({ host: "node" });
    const denoRuntime = await createDenoRuntime({ host: "deno" });
    const bunRuntime = await createRuntime({ host: "bun" });
    const browserRuntime = await createBrowserRuntime({ host: "browser" });

    const nodeResult = await nodeRuntime.run({ host: "node", ...request });
    const denoResult = await denoRuntime.run({ host: "deno", ...request });
    const bunResult = await bunRuntime.run({ host: "bun", ...request });
    const browserResult = await browserRuntime.run({
      host: "browser",
      ...request,
    });

    await nodeRuntime.close();
    await denoRuntime.close();
    await bunRuntime.close();
    await browserRuntime.close();

    const terminations = {
      node: nodeResult.meta.termination,
      deno: denoResult.meta.termination,
      bun: bunResult.meta.termination,
      browser: browserResult.meta.termination,
    };

    expect(new Set(Object.values(terminations)).size).toBe(1);

    writeArtifact("artifacts/e2e/host-parity-contract.json", {
      ok: true,
      invariants: ["INV-FEAT-0025"],
      runs: {
        node: {
          termination: nodeResult.meta.termination,
          status: nodeResult.status,
          capabilityChannel: capabilityChannel(nodeResult),
          exceptionTag: null,
        },
        deno: {
          termination: denoResult.meta.termination,
          status: denoResult.status,
          capabilityChannel: capabilityChannel(denoResult),
          exceptionTag: null,
        },
        bun: {
          termination: bunResult.meta.termination,
          status: bunResult.status,
          capabilityChannel: capabilityChannel(bunResult),
          exceptionTag: null,
        },
        browser: {
          termination: browserResult.meta.termination,
          status: browserResult.status,
          capabilityChannel: capabilityChannel(browserResult),
          exceptionTag: null,
        },
      },
    });
  }, 90_000);
});
