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

interface IsolationProfileView {
  name?: string;
  maxWallMs?: number;
  maxCpuMs?: number;
  maxMemoryBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  denyEnvCapability?: boolean;
}

interface KernelControlProbeView {
  blocked: boolean;
  errnoCode: number | null;
  errnoName: string | null;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

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

function isolationProfileView(
  runtime: AegisPyRuntime,
): IsolationProfileView | null {
  const view = runtimeView(runtime);
  return (view.isolationProfile as IsolationProfileView | null) ?? null;
}

function makeRealExecutionProofRequest(code: string): RunRequest {
  return {
    ...baseRequest,
    code,
    limits: {
      ...baseRequest.limits,
      time: {
        wallMs: 10_000,
        cpuMs: 10_000,
      },
    },
  };
}

async function runStrictIsolationCase(
  envOverrides: Record<string, string>,
  request: RunRequest,
): Promise<{
  capabilities: ReturnType<AegisPyRuntime["capabilities"]>;
  isolationProfile: IsolationProfileView | null;
  result: RunResult;
  view: ReturnType<typeof runtimeView>;
}> {
  process.env = {
    ...originalEnv,
    AEGISPY_NODE_TRANSPORT: "process",
    AEGISPY_ISOLATION_PROFILE: "strict",
    ...envOverrides,
  };

  const runtime = await createRuntime({ host: "node" });
  const view = runtimeView(runtime);
  const profile = isolationProfileView(runtime);
  const capabilities = runtime.capabilities();
  const result = await runtime.run(request);
  await runtime.close();

  return {
    capabilities,
    isolationProfile: profile,
    result,
    view,
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("runtime hardening", () => {
  it("defaults to process transport and records real execution proof", async () => {
    delete process.env.AEGISPY_NODE_TRANSPORT;
    process.env.AEGISPY_ISOLATION_PROFILE = "strict";
    process.env.AEGISPY_ISOLATION_MAX_WALL_MS = "10000";
    process.env.AEGISPY_ISOLATION_MAX_CPU_MS = "10000";

    const runtime = await createRuntime({ host: "node" });
    const view = runtimeView(runtime);
    const capabilities = runtime.capabilities();
    const result = await runtime.run(
      makeRealExecutionProofRequest('print("real-path")'),
    );
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
    process.env.AEGISPY_RUNTIME_ENV_VALUE = "strict-env";

    const runtime = await createRuntime({ host: "node" });
    const view = runtimeView(runtime);
    const profile = isolationProfileView(runtime);
    const capabilities = runtime.capabilities();

    const fsResult = await runtime.run({
      ...baseRequest,
      code: 'aegispy.fs_read("/tmp/secret.txt")',
    });
    const httpResult = await runtime.run({
      ...baseRequest,
      code: 'aegispy.http_get("https://example.com/secret")',
    });
    const envResult = await runtime.run({
      ...baseRequest,
      code: 'print(aegispy.env_get("AEGISPY_RUNTIME_ENV_VALUE"))',
      permissions: {
        ...baseRequest.permissions,
        env: {
          allowKeys: ["AEGISPY_RUNTIME_ENV_VALUE"],
        },
      },
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
    expect(envResult.status).toBe("error");
    expect(isolationResult.status).toBe("error");

    if (
      fsResult.status !== "error" ||
      httpResult.status !== "error" ||
      envResult.status !== "error" ||
      isolationResult.status !== "error"
    ) {
      throw new Error("expected runtime-bound denials");
    }

    expect(fsResult.error.code).toBe("AEG-POLICY-DENIED");
    expect(httpResult.error.code).toBe("AEG-POLICY-DENIED");
    expect(envResult.error.code).toBe("AEG-POLICY-DENIED");
    expect(isolationResult.error.code).toBe("AEG-POLICY-DENIED");
    expect(auditKinds(fsResult).slice(0, 2)).toEqual([
      "runtime_channel",
      "runtime_binding",
    ]);
    expect(auditKinds(httpResult).slice(0, 2)).toEqual([
      "runtime_channel",
      "runtime_binding",
    ]);
    expect(auditKinds(envResult).slice(0, 2)).toEqual([
      "runtime_channel",
      "runtime_binding",
    ]);
    expect(auditKinds(fsResult)).toContain("policy_denied");
    expect(auditKinds(httpResult)).toContain("policy_denied");
    expect(auditKinds(envResult)).toContain("policy_denied");
    expect(envResult.stderrUtf8).toContain("env capability blocked");
    expect(isolationResult.stderrUtf8).toContain("isolation_");
    expect(capabilityChannel(fsResult)).toBe("component-wit");
    expect(capabilityChannel(httpResult)).toBe("component-wit");
    expect(capabilityChannel(envResult)).toBe("component-wit");
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
    expect(kernelIsolation.seccomp).not.toBe("0");
    expect(parsePositiveInt(kernelIsolation.seccomp_filters)).toBeGreaterThan(
      0,
    );
    expect(
      parsePositiveInt(kernelIsolation.rlimit_cpu_soft_secs),
    ).toBeGreaterThan(0);
    expect(
      parsePositiveInt(kernelIsolation.rlimit_as_soft_bytes),
    ).toBeGreaterThan(0);
    expect(profile?.name).toBe("strict");

    const controlProbes: Record<string, KernelControlProbeView> = {
      unshare: {
        blocked: kernelIsolation.probe_unshare_blocked === "1",
        errnoCode: parsePositiveInt(kernelIsolation.probe_unshare_errno),
        errnoName: kernelIsolation.probe_unshare_errno_name ?? null,
      },
      setns: {
        blocked: kernelIsolation.probe_setns_blocked === "1",
        errnoCode: parsePositiveInt(kernelIsolation.probe_setns_errno),
        errnoName: kernelIsolation.probe_setns_errno_name ?? null,
      },
      mount: {
        blocked: kernelIsolation.probe_mount_blocked === "1",
        errnoCode: parsePositiveInt(kernelIsolation.probe_mount_errno),
        errnoName: kernelIsolation.probe_mount_errno_name ?? null,
      },
      ptrace: {
        blocked: kernelIsolation.probe_ptrace_blocked === "1",
        errnoCode: parsePositiveInt(kernelIsolation.probe_ptrace_errno),
        errnoName: kernelIsolation.probe_ptrace_errno_name ?? null,
      },
    };

    for (const [probeName, probe] of Object.entries(controlProbes)) {
      expect(probe.blocked).toBe(true);
      expect(probe.errnoCode).toBeGreaterThan(0);
      expect(probe.errnoName).toBe("EUCLEAN");
      if (!probe.blocked) {
        throw new Error(`expected ${probeName} seccomp probe to be blocked`);
      }
    }

    const controlStatus = {
      noNewPrivs: kernelIsolation.no_new_privs === "1",
      cgroup: Boolean(kernelIsolation.cgroup_path),
      namespaces: {
        pid: Boolean(kernelIsolation.ns_pid),
        mnt: Boolean(kernelIsolation.ns_mnt),
        net: Boolean(kernelIsolation.ns_net),
        uts: Boolean(kernelIsolation.ns_uts),
        ipc: Boolean(kernelIsolation.ns_ipc),
        cgroup: Boolean(kernelIsolation.ns_cgroup),
      },
      seccomp: {
        mode: kernelIsolation.seccomp ?? "unknown",
        filters: kernelIsolation.seccomp_filters ?? "unknown",
        active:
          kernelIsolation.seccomp !== undefined &&
          kernelIsolation.seccomp !== "0",
      },
    };

    const rlimits = {
      cpuSeconds: {
        soft: parsePositiveInt(kernelIsolation.rlimit_cpu_soft_secs),
        hard: parsePositiveInt(kernelIsolation.rlimit_cpu_hard_secs),
      },
      addressSpaceBytes: {
        soft: parsePositiveInt(kernelIsolation.rlimit_as_soft_bytes),
        hard: parsePositiveInt(kernelIsolation.rlimit_as_hard_bytes),
      },
    };

    const limitEnvelope = {
      wallMs: profile?.maxWallMs ?? null,
      cpuMs: profile?.maxCpuMs ?? null,
      memoryBytes: profile?.maxMemoryBytes ?? null,
      stdoutBytes: profile?.maxStdoutBytes ?? null,
      stderrBytes: profile?.maxStderrBytes ?? null,
      denyEnvCapability: profile?.denyEnvCapability ?? null,
    };

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
      envDenied: envResult.error.code === "AEG-POLICY-DENIED",
      isolationDenied: isolationResult.error.code === "AEG-POLICY-DENIED",
      limitReasons: {
        wall: isolationResult.stderrUtf8,
      },
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
      profile: profile,
      limitEnvelope,
      controlStatus,
      rlimits,
      controlProbes,
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
      limitEnvelope,
      controlStatus,
      noNewPrivs: kernelIsolation.no_new_privs === "1",
      seccompMode: kernelIsolation.seccomp ?? "unknown",
      seccompFilters: kernelIsolation.seccomp_filters ?? "unknown",
      rlimits,
      controlProbes,
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

  it("records hostile limit-envelope denials for cpu, memory, stdout, and stderr", async () => {
    const cpuCase = await runStrictIsolationCase(
      {
        AEGISPY_ISOLATION_MAX_CPU_MS: "300",
      },
      {
        ...baseRequest,
        code: 'print("cpu-bound envelope")',
        limits: {
          ...baseRequest.limits,
          time: {
            wallMs: 250,
            cpuMs: 2000,
          },
        },
      },
    );
    const memoryCase = await runStrictIsolationCase(
      {
        AEGISPY_ISOLATION_MAX_MEMORY_BYTES: "1048576",
      },
      {
        ...baseRequest,
        code: 'print("memory envelope")',
      },
    );
    const stdoutCase = await runStrictIsolationCase(
      {
        AEGISPY_ISOLATION_MAX_STDOUT_BYTES: "128",
      },
      {
        ...baseRequest,
        code: 'print("stdout envelope")',
      },
    );
    const stderrCase = await runStrictIsolationCase(
      {
        AEGISPY_ISOLATION_MAX_STDERR_BYTES: "128",
      },
      {
        ...baseRequest,
        code: 'import sys\nprint("stderr envelope", file=sys.stderr)',
      },
    );

    expect(cpuCase.capabilities.profile).toBe("server-hardened");
    expect(cpuCase.isolationProfile?.maxCpuMs).toBe(300);
    expect(memoryCase.isolationProfile?.maxMemoryBytes).toBe(1048576);
    expect(stdoutCase.isolationProfile?.maxStdoutBytes).toBe(128);
    expect(stderrCase.isolationProfile?.maxStderrBytes).toBe(128);

    const cases = {
      cpu: cpuCase.result,
      memory: memoryCase.result,
      stdout: stdoutCase.result,
      stderr: stderrCase.result,
    };

    for (const result of Object.values(cases)) {
      expect(result.status).toBe("error");
      if (result.status !== "error") {
        throw new Error("expected strict isolation denial");
      }
      expect(result.error.code).toBe("AEG-POLICY-DENIED");
      expect(result.meta.termination).toBe("policy_denied");
      expect(capabilityChannel(result)).toBe("component-wit");
      expect(auditKinds(result)).toContain("kernel_isolation");
      expect(auditKinds(result)).toContain("policy_denied");
    }

    expect(cpuCase.result.stderrUtf8).toContain("isolation_cpu_limit_exceeded");
    expect(memoryCase.result.stderrUtf8).toContain(
      "isolation_memory_limit_exceeded",
    );
    expect(stdoutCase.result.stderrUtf8).toContain(
      "isolation_stdout_limit_exceeded",
    );
    expect(stderrCase.result.stderrUtf8).toContain(
      "isolation_stderr_limit_exceeded",
    );

    writeArtifact("artifacts/security/isolation-limit-denials.json", {
      ok: true,
      invariants: ["INV-SECU-0006"],
      host: "node",
      conformanceProfile: cpuCase.capabilities.profile,
      transport: cpuCase.view.transportKind ?? "unknown",
      executionMode: cpuCase.view.executionMode ?? null,
      executionBackend: cpuCase.view.executionBackend ?? null,
      cases: {
        cpu: {
          denied: true,
          reason: cpuCase.result.stderrUtf8,
        },
        memory: {
          denied: true,
          reason: memoryCase.result.stderrUtf8,
        },
        stdout: {
          denied: true,
          reason: stdoutCase.result.stderrUtf8,
        },
        stderr: {
          denied: true,
          reason: stderrCase.result.stderrUtf8,
        },
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
