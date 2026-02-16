import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type AegisPyRuntime } from "../src/index";
import type { RunRequest } from "@aegispy/core";
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
      memoryBytes: 1024 * 1024,
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

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runtime hardening", () => {
  it("defaults to process transport and records real execution proof", async () => {
    delete process.env.AEGISPY_NODE_TRANSPORT;
    process.env.AEGISPY_ISOLATION_PROFILE = "strict";

    const runtime = await createRuntime({ host: "node" });
    const view = runtimeView(runtime);
    const result = await runtime.run({
      ...baseRequest,
      code: 'print("real-path")',
    });
    await runtime.close();

    expect(view.transportKind).toBe("process");
    expect(result.status).toBe("ok");

    writeArtifact("artifacts/tests/real-engine-default.json", {
      ok: true,
      invariants: ["INV-FEAT-0003", "INV-FEAT-0009"],
      host: "node",
      transport: view.transportKind ?? "unknown",
      isolationProfile: view.isolationProfile ?? null,
      termination: result.meta.termination,
      status: result.status,
    });
  }, 120_000);

  it("enforces strict isolation profile and runtime-bound policy denials", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";
    process.env.AEGISPY_ISOLATION_PROFILE = "strict";
    process.env.AEGISPY_ISOLATION_MAX_WALL_MS = "300";

    const runtime = await createRuntime({ host: "node" });
    const view = runtimeView(runtime);

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

    writeArtifact("artifacts/security/runtime-policy-denials.json", {
      ok: true,
      invariants: ["INV-SECU-0001", "INV-SECU-0005"],
      host: "node",
      transport: view.transportKind ?? "unknown",
      fsDenied: fsResult.error.code === "AEG-POLICY-DENIED",
      httpDenied: httpResult.error.code === "AEG-POLICY-DENIED",
      isolationDenied: isolationResult.error.code === "AEG-POLICY-DENIED",
    });

    writeArtifact("artifacts/security/isolation-profile.json", {
      ok: true,
      invariants: ["INV-SECU-0006"],
      host: "node",
      transport: view.transportKind ?? "unknown",
      profile: view.isolationProfile ?? null,
      deniedByProfile: isolationResult.stderrUtf8,
      termination: isolationResult.meta.termination,
    });
  }, 120_000);
});
