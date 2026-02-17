import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type AegisPyRuntime } from "../src/index";
import type { RunResult } from "@aegispy/core";
import { writeArtifact } from "./helpers/artifact";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

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

describe("deno adapter parity", () => {
  it("defaults to process transport and matches node contract shape", async () => {
    process.env = { ...originalEnv };
    delete process.env.AEGISPY_DENO_TRANSPORT;

    const runtime: AegisPyRuntime = await createRuntime({ host: "deno" });
    const view = runtimeView(runtime);

    const result = await runtime.run({
      host: "deno",
      code: 'print("deno")',
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
        rngSeedHex: "deadbeef",
      },
    });

    await runtime.close();

    expect(view.transportKind).toBe("process");
    expect(result.meta.termination).toBe("ok");
    expect(capabilityChannel(result)).toBe("component-wit");

    writeArtifact("artifacts/e2e/deno-parity.json", {
      ok: true,
      invariants: ["INV-FEAT-0017"],
      transport: view.transportKind ?? "unknown",
      capabilityChannel: capabilityChannel(result),
      termination: result.meta.termination,
      status: result.status,
    });
  }, 600_000);

  it("uses simulation only when explicitly selected", async () => {
    process.env = { ...originalEnv, AEGISPY_DENO_TRANSPORT: "simulation" };

    const runtime: AegisPyRuntime = await createRuntime({ host: "deno" });
    const view = runtimeView(runtime);

    const result = await runtime.run({
      host: "deno",
      code: 'print("deno-sim")',
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
        rngSeedHex: "deadbeef",
      },
    });

    await runtime.close();

    expect(view.transportKind).toBe("simulation");
    expect(result.status).toBe("ok");
    expect(capabilityChannel(result)).toBe(null);
  }, 600_000);
});
