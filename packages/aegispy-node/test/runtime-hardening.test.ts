import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type AegisPyRuntime } from "../src/index";
import type { RunRequest, RunResult } from "@aegispy/core";
import { writeArtifact } from "./helpers/artifact";

const baseRequest: Omit<RunRequest, "code"> = {
  host: "node",
  argv: ["python"],
  stdinUtf8: "",
  permissions: {
    fs: null,
    http: null,
    env: null,
  },
  limits: {
    time: {
      wallMs: 250,
      cpuMs: 250,
    },
    bytes: {
      memoryBytes: 64 * 1024 * 1024,
      stdoutBytes: 1024,
      stderrBytes: 1024,
    },
  },
  determinism: {
    enabled: true,
    epochMs: 100,
    rngSeedHex: "1234abcd",
  },
};

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

describe("runtime hardening", () => {
  it("defaults to process transport and records real execution proof", async () => {
    delete process.env.AEGISPY_NODE_TRANSPORT;
    process.env.AEGISPY_ISOLATION_PROFILE = "strict";

    const runtime = await createRuntime({ host: "node" });
    const view = runtimeView(runtime);
    const capabilities = runtime.capabilities();
    const result = await runtime.run({
      ...baseRequest,
      code: 'print("real-path")',
    });
    await runtime.close();

    expect(view.transportKind).toBe("process");
    expect(capabilities.profile).toBe("server-hardened");
    expect(capabilities.hardened).toBe(true);
    expect(result.status).toBe("ok");
    expect(capabilityChannel(result)).toBe("component-wit");

    writeArtifact("artifacts/tests/real-engine-default.json", {
      ok: true,
      invariants: ["INV-FEAT-0003", "INV-FEAT-0009"],
      host: "node",
      profile: capabilities.profile,
      transport: view.transportKind ?? "unknown",
      capabilityChannel: capabilityChannel(result),
      isolationProfile: view.isolationProfile ?? null,
      hardened: capabilities.hardened,
      termination: result.meta.termination,
      status: result.status,
    });
  }, 600_000);

  it("enforces strict isolation profile and runtime-bound policy denials", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";
    process.env.AEGISPY_ISOLATION_PROFILE = "strict";
    process.env.AEGISPY_ISOLATION_MAX_WALL_MS = "300";

    const runtime = await createRuntime({ host: "node" });
    const view = runtimeView(runtime);
    const capabilities = runtime.capabilities();

    const fsResult = await runtime.run({
      ...baseRequest,
      code: 'aegispy.fs_read("/tmp/secret.txt")',
    });
    const httpResult = await runtime.run({
      ...baseRequest,
      code: 'aegispy.http_get("https://example.com/secret")',
    });
    const isolationResult = await runtime.run({
      ...baseRequest,
      code: 'print("oversized wall limit")',
      limits: {
        ...baseRequest.limits,
        time: {
          wallMs: 2000,
          cpuMs: 2000,
        },
      },
    });

    await runtime.close();

    expect(view.transportKind).toBe("process");
    expect(capabilities.profile).toBe("server-hardened");
    expect(capabilities.hardened).toBe(true);
    expect(fsResult.status).toBe("error");
    expect(httpResult.status).toBe("error");
    expect(isolationResult.status).toBe("error");

    if (
      fsResult.status !== "error" ||
      httpResult.status !== "error" ||
      isolationResult.status !== "error"
    ) {
      throw new Error("expected runtime-bound denials");
    }

    expect(fsResult.error.code).toBe("AEG-POLICY-DENIED");
    expect(httpResult.error.code).toBe("AEG-POLICY-DENIED");
    expect(isolationResult.error.code).toBe("AEG-POLICY-DENIED");
    expect(isolationResult.stderrUtf8).toContain("isolation_");
    expect(capabilityChannel(fsResult)).toBe("component-wit");
    expect(capabilityChannel(httpResult)).toBe("component-wit");
    expect(capabilityChannel(isolationResult)).toBe("component-wit");

    writeArtifact("artifacts/security/runtime-policy-denials.json", {
      ok: true,
      invariants: ["INV-SECU-0001", "INV-SECU-0005"],
      host: "node",
      profile: capabilities.profile,
      transport: view.transportKind ?? "unknown",
      capabilityChannel: capabilityChannel(fsResult),
      hardened: capabilities.hardened,
      fsDenied: fsResult.error.code === "AEG-POLICY-DENIED",
      httpDenied: httpResult.error.code === "AEG-POLICY-DENIED",
      isolationDenied: isolationResult.error.code === "AEG-POLICY-DENIED",
    });

    writeArtifact("artifacts/security/isolation-profile.json", {
      ok: true,
      invariants: ["INV-SECU-0006"],
      host: "node",
      conformanceProfile: capabilities.profile,
      transport: view.transportKind ?? "unknown",
      capabilityChannel: capabilityChannel(isolationResult),
      hardened: capabilities.hardened,
      profile: view.isolationProfile ?? null,
      deniedByProfile: isolationResult.stderrUtf8,
      termination: isolationResult.meta.termination,
    });
  }, 600_000);
});
