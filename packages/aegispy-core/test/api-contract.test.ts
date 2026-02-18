import { afterAll, describe, expect, it } from "vitest";
import {
  createRuntime,
  type AegisPyError,
  type AegisPyRuntime,
  type AuditEvent,
  type ByteLimits,
  type ConformanceProfile,
  type CreateRuntimeOptions,
  type DeterminismConfig,
  type EnvPermission,
  type ErrorCode,
  type ExecutionMeta,
  type FsPermission,
  type HostKind,
  type HttpPermission,
  type Limits,
  type Permissions,
  type RunRequest,
  type RunResult,
  type RunResultError,
  type RunResultOk,
  type RuntimeCapabilities,
  type TerminationReason,
  type TimeLimits,
} from "../src/index";
import { writeArtifact } from "./helpers/artifact";
import { registerCoreTestRuntimeFactories } from "./helpers/register-test-runtime";

const invariants = ["INV-FEAT-0001", "INV-FEAT-0002"];

registerCoreTestRuntimeFactories();

type CoverageTuple = [
  AegisPyError,
  AegisPyRuntime,
  AuditEvent,
  ByteLimits,
  ConformanceProfile,
  CreateRuntimeOptions,
  DeterminismConfig,
  EnvPermission,
  ErrorCode,
  ExecutionMeta,
  FsPermission,
  HostKind,
  HttpPermission,
  Limits,
  Permissions,
  RunRequest,
  RunResult,
  RunResultError,
  RunResultOk,
  RuntimeCapabilities,
  TerminationReason,
  TimeLimits,
];

const coverageTypeLink: CoverageTuple | null = null;
void coverageTypeLink;

function makeRequest(host: HostKind): RunRequest {
  return {
    host,
    code: 'print("alpha")',
    argv: ["python"],
    stdinUtf8: "",
    permissions: {
      fs: {
        readRoots: ["/sandbox/read"],
        writeRoots: ["/sandbox/write"],
        maxBytes: 4096,
        maxFiles: 16,
      },
      http: {
        allowOrigins: ["https://example.com"],
        denyOrigins: [],
        maxRequests: 4,
        maxBytes: 2048,
      },
      env: {
        allowKeys: ["LANG"],
      },
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
      epochMs: 42,
      rngSeedHex: "0badc0de",
    },
  };
}

describe("api contract", () => {
  const runtimes: AegisPyRuntime[] = [];

  afterAll(async () => {
    await Promise.all(runtimes.map(async (runtime) => runtime.close()));
  });

  it("returns a run result shape", async () => {
    const runtime = await createRuntime({ host: "node" });
    runtimes.push(runtime);
    const request = makeRequest("node");

    const result = await runtime.run(request);
    const capabilities = runtime.capabilities();

    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.stdoutUtf8).toContain("alpha");
    expect(result.meta.termination).toBe("ok");
    expect(capabilities.host).toBe("node");
    expect(typeof capabilities.hardened).toBe("boolean");

    writeArtifact("artifacts/tests/api-contract.json", {
      ok: true,
      invariants,
      result,
      capabilities,
    });
  });
});
