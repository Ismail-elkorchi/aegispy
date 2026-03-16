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
  executionMode?: string | null;
  executionBackend?: {
    available?: boolean;
    backendName?: string;
    reason?: string | null;
  } | null;
} {
  return runtime as unknown as {
    transportKind?: string;
    isolationProfile?: unknown;
    executionMode?: string | null;
    executionBackend?: {
      available?: boolean;
      backendName?: string;
      reason?: string | null;
    } | null;
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

function auditDetail(result: RunResult, kind: string): string | null {
  const audit = result.meta.audit as Array<{
    kind: string;
    detailJson: string;
  }>;
  const event = audit.find((entry) => entry.kind === kind);
  return event?.detailJson ?? null;
}

function auditKinds(result: RunResult): string[] {
  return (result.meta.audit as Array<{ kind: string }>).map(
    (entry) => entry.kind,
  );
}

function parseKernelIsolationDetail(detail: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of detail.split(";")) {
    if (part.length === 0) continue;
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx);
    const value = part
      .slice(idx + 1)
      .replaceAll("%3B", ";")
      .replaceAll("%3D", "=");
    out[key] = value;
  }
  return out;
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
    expect(view.executionMode).toBe("process");
    expect(view.executionBackend?.available).toBe(true);
    expect(view.executionBackend?.backendName).toBe("native-process");
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
      executionMode: view.executionMode ?? null,
      executionBackend: view.executionBackend ?? null,
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
    expect(view.executionMode).toBe("process");
    expect(view.executionBackend?.available).toBe(true);
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
    expect(auditKinds(fsResult).slice(0, 2)).toEqual([
      "runtime_channel",
      "runtime_binding",
    ]);
    expect(auditKinds(httpResult).slice(0, 2)).toEqual([
      "runtime_channel",
      "runtime_binding",
    ]);
    expect(auditKinds(fsResult)).toContain("policy_denied");
    expect(auditKinds(httpResult)).toContain("policy_denied");
    expect(isolationResult.stderrUtf8).toContain("isolation_");
    expect(capabilityChannel(fsResult)).toBe("component-wit");
    expect(capabilityChannel(httpResult)).toBe("component-wit");
    expect(capabilityChannel(isolationResult)).toBe("component-wit");
    const kernelDetail = auditDetail(isolationResult, "kernel_isolation");
    expect(kernelDetail).toBeTruthy();
    const kernelIsolation =
      kernelDetail === null ? {} : parseKernelIsolationDetail(kernelDetail);
    expect(kernelIsolation.supported).toBe("1");
    expect(kernelIsolation.no_new_privs).toBe("1");
    expect(kernelIsolation.ns_pid).toBeTruthy();
    expect(kernelIsolation.ns_mnt).toBeTruthy();
    expect(kernelIsolation.cgroup_path).toBeTruthy();

    writeArtifact("artifacts/security/runtime-policy-denials.json", {
      ok: true,
      invariants: ["INV-SECU-0001", "INV-SECU-0005"],
      host: "node",
      profile: capabilities.profile,
      transport: view.transportKind ?? "unknown",
      executionMode: view.executionMode ?? null,
      executionBackend: view.executionBackend ?? null,
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
      executionMode: view.executionMode ?? null,
      executionBackend: view.executionBackend ?? null,
      capabilityChannel: capabilityChannel(isolationResult),
      hardened: capabilities.hardened,
      profile: view.isolationProfile ?? null,
      deniedByProfile: isolationResult.stderrUtf8,
      termination: isolationResult.meta.termination,
    });

    writeArtifact("artifacts/security/kernel-isolation-runtime.json", {
      ok: true,
      invariants: ["INV-SECU-0006"],
      host: "node",
      conformanceProfile: capabilities.profile,
      transport: view.transportKind ?? "unknown",
      executionMode: view.executionMode ?? null,
      executionBackend: view.executionBackend ?? null,
      capabilityChannel: capabilityChannel(isolationResult),
      hardened: capabilities.hardened,
      supported: kernelIsolation.supported === "1",
      profile: kernelIsolation.profile ?? null,
      noNewPrivs: kernelIsolation.no_new_privs === "1",
      seccompMode: kernelIsolation.seccomp ?? "unknown",
      seccompFilters: kernelIsolation.seccomp_filters ?? "unknown",
      cgroupPath: kernelIsolation.cgroup_path ?? null,
      namespaces: {
        pid: kernelIsolation.ns_pid ?? null,
        mnt: kernelIsolation.ns_mnt ?? null,
        net: kernelIsolation.ns_net ?? null,
        uts: kernelIsolation.ns_uts ?? null,
        ipc: kernelIsolation.ns_ipc ?? null,
        cgroup: kernelIsolation.ns_cgroup ?? null,
      },
    });
  }, 600_000);

  it("fails closed when microvm mode is selected without a launcher", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";
    process.env.AEGISPY_WORKER_EXECUTION_MODE = "microvm";
    delete process.env.AEGISPY_MICROVM_LAUNCHER;
    delete process.env.AEGISPY_MICROVM_LAUNCHER_ARGS_JSON;

    const runtime = await createRuntime({ host: "node" });
    const view = runtimeView(runtime);

    const result = await runtime.run({
      ...baseRequest,
      code: 'print("microvm-unavailable")',
    });
    await runtime.close();

    expect(view.transportKind).toBe("process");
    expect(view.executionMode).toBe("microvm");
    expect(view.executionBackend?.available).toBe(false);
    expect(view.executionBackend?.backendName).toBe("microvm-launcher");
    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected microvm startup denial");
    }
    expect(result.error.code).toBe("AEG-ENGINE");
    expect(result.stderrUtf8).toContain("microvm execution mode unavailable");
  }, 600_000);

  it.runIf(Boolean(process.env.AEGISPY_MICROVM_LAUNCHER))(
    "records configured microvm execution mode when a launcher is available",
    async () => {
      process.env.AEGISPY_NODE_TRANSPORT = "process";
      process.env.AEGISPY_WORKER_EXECUTION_MODE = "microvm";

      const runtime = await createRuntime({ host: "node" });
      const view = runtimeView(runtime);
      const result = await runtime.run({
        ...baseRequest,
        code: 'print("microvm-runtime")',
      });
      await runtime.close();

      expect(view.transportKind).toBe("process");
      expect(view.executionMode).toBe("microvm");
      expect(view.executionBackend?.available).toBe(true);
      expect(view.executionBackend?.backendName).toBe("microvm-launcher");
      expect(result.status).toBe("ok");
      expect(capabilityChannel(result)).toBe("component-wit");

      writeArtifact("artifacts/security/microvm-execution.json", {
        ok: true,
        invariants: ["INV-SECU-0008"],
        host: "node",
        transport: view.transportKind ?? "unknown",
        executionMode: view.executionMode ?? null,
        executionBackend: view.executionBackend ?? null,
        capabilityChannel: capabilityChannel(result),
        termination: result.meta.termination,
        status: result.status,
      });
    },
    600_000,
  );
});
