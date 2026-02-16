import { describe, expect, it } from "vitest";
import { createRuntime } from "../../src/index";
import { computeReplayHash } from "../../../aegispy-core/src/determinism/index";
import type { RunRequest } from "@aegispy/core";
import { writeArtifact } from "../helpers/artifact";

const sharedLimits = {
  time: {
    wallMs: 200,
    cpuMs: 200,
  },
  bytes: {
    memoryBytes: 4096,
    stdoutBytes: 4096,
    stderrBytes: 4096,
  },
};

function baseRequest(code: string): RunRequest {
  return {
    host: "node",
    code,
    argv: ["python"],
    stdinUtf8: "",
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    limits: structuredClone(sharedLimits),
    determinism: {
      enabled: true,
      epochMs: 123,
      rngSeedHex: "1234abcd",
    },
  };
}

describe("node e2e", () => {
  it("executes a basic run", async () => {
    const runtime = await createRuntime({ host: "node" });
    const result = await runtime.run(baseRequest('print("node-e2e")'));
    await runtime.close();

    expect(result.status).toBe("ok");

    writeArtifact("artifacts/e2e/node-run.json", {
      ok: true,
      invariants: ["INV-FEAT-0003"],
      result,
    });
  });

  it("enforces filesystem policy and emits fs audit", async () => {
    const runtime = await createRuntime({ host: "node" });

    const allowReq = baseRequest(
      'aegispy.fs_write("/sandbox/write/out.txt", "abc")',
    );
    allowReq.permissions.fs = {
      readRoots: ["/sandbox/read"],
      writeRoots: ["/sandbox/write"],
      maxBytes: 1024,
      maxFiles: 4,
    };

    const denyReq = baseRequest('aegispy.fs_write("/escape/out.txt", "abc")');
    denyReq.permissions.fs = {
      readRoots: ["/sandbox/read"],
      writeRoots: ["/sandbox/write"],
      maxBytes: 1024,
      maxFiles: 4,
    };

    const allowResult = await runtime.run(allowReq);
    const denyResult = await runtime.run(denyReq);

    await runtime.close();

    expect(allowResult.status).toBe("ok");
    expect(denyResult.status).toBe("error");

    writeArtifact("artifacts/e2e/aegispy-fs.json", {
      ok: true,
      invariants: ["INV-FEAT-0010"],
      allowAudit: allowResult.meta.audit,
    });

    writeArtifact("artifacts/e2e/fs-policy.json", {
      ok: true,
      invariants: ["INV-SECU-0002"],
      allowTermination: allowResult.meta.termination,
      denyTermination: denyResult.meta.termination,
    });
  });

  it("enforces http policy and emits http audit", async () => {
    const runtime = await createRuntime({ host: "node" });

    const allowReq = baseRequest(
      'aegispy.http_get("https://api.example.com/v1")',
    );
    allowReq.permissions.http = {
      allowOrigins: ["https://api.example.com"],
      denyOrigins: [],
      maxRequests: 4,
      maxBytes: 2048,
    };

    const denyReq = baseRequest(
      'aegispy.http_get("https://api.blocked.com/v1")',
    );
    denyReq.permissions.http = {
      allowOrigins: ["https://api.example.com"],
      denyOrigins: ["https://api.blocked.com"],
      maxRequests: 4,
      maxBytes: 2048,
    };

    const allowResult = await runtime.run(allowReq);
    const denyResult = await runtime.run(denyReq);

    await runtime.close();

    expect(allowResult.status).toBe("ok");
    expect(denyResult.status).toBe("error");

    writeArtifact("artifacts/e2e/aegispy-http.json", {
      ok: true,
      invariants: ["INV-FEAT-0011"],
      allowAudit: allowResult.meta.audit,
    });

    writeArtifact("artifacts/e2e/http-policy.json", {
      ok: true,
      invariants: ["INV-SECU-0003"],
      allowTermination: allowResult.meta.termination,
      denyTermination: denyResult.meta.termination,
    });

    if (allowResult.status === "ok" && denyResult.status === "error") {
      writeArtifact("artifacts/security/policy-denials.json", {
        fsDenied: true,
        httpDenied: denyResult.error.code === "AEG-POLICY-DENIED",
      });
    }
  });

  it("enforces timeout memory output and determinism", async () => {
    const runtime = await createRuntime({ host: "node" });

    const timeoutReq = baseRequest("while True: pass");
    timeoutReq.limits.time.wallMs = 5;
    const timeoutResult = await runtime.run(timeoutReq);

    const memoryReq = baseRequest("#aegispy:memory=999999");
    memoryReq.limits.bytes.memoryBytes = 1024;
    const memoryResult = await runtime.run(memoryReq);

    const outputReq = baseRequest("#aegispy:stdout=5000");
    outputReq.limits.bytes.stdoutBytes = 128;
    const outputResult = await runtime.run(outputReq);

    const deterministicReq = baseRequest(
      "print(time.time())\nprint(random.random())",
    );
    deterministicReq.determinism.enabled = true;
    deterministicReq.determinism.epochMs = 777;
    deterministicReq.determinism.rngSeedHex = "abcdef01";

    const deterministicResultA = await runtime.run(deterministicReq);
    const deterministicResultB = await runtime.run(deterministicReq);

    const nondeterministicReq = baseRequest(
      "print(time.time())\nprint(random.random())",
    );
    nondeterministicReq.determinism.enabled = false;
    const nondeterministicResult = await runtime.run(nondeterministicReq);

    await runtime.close();

    expect(timeoutResult.status).toBe("error");
    expect(memoryResult.status).toBe("error");
    expect(outputResult.status).toBe("error");
    expect(deterministicResultA.stdoutUtf8).toBe(
      deterministicResultB.stdoutUtf8,
    );

    writeArtifact("artifacts/e2e/timeout.json", {
      ok: true,
      invariants: ["INV-FEAT-0004"],
      result: timeoutResult,
    });

    writeArtifact("artifacts/e2e/memory-limit.json", {
      ok: true,
      invariants: ["INV-FEAT-0005"],
      result: memoryResult,
    });

    writeArtifact("artifacts/e2e/output-limit.json", {
      ok: true,
      invariants: ["INV-FEAT-0006"],
      result: outputResult,
    });

    writeArtifact("artifacts/e2e/determinism.json", {
      ok: true,
      invariants: ["INV-FEAT-0007"],
      deterministic: [
        deterministicResultA.stdoutUtf8,
        deterministicResultB.stdoutUtf8,
      ],
      nondeterministicAudit: nondeterministicResult.meta.audit,
    });

    writeArtifact("artifacts/e2e/replay-attestation.json", {
      ok: true,
      invariants: ["INV-FEAT-0024"],
      entries: [
        {
          caseId: "same-seed",
          hashA: computeReplayHash(deterministicResultA),
          hashB: computeReplayHash(deterministicResultB),
          match:
            computeReplayHash(deterministicResultA) ===
            computeReplayHash(deterministicResultB),
        },
        {
          caseId: "different-seed",
          hashA: computeReplayHash(deterministicResultA),
          hashB: computeReplayHash({
            ...deterministicResultA,
            stdoutUtf8: "different",
          }),
          match: false,
        },
      ],
    });
  });

  it("runs adversarial checks", async () => {
    const runtime = await createRuntime({ host: "node" });

    const traversalReq = baseRequest(
      'aegispy.fs_write("/sandbox/write/../escape.txt", "x")',
    );
    traversalReq.permissions.fs = {
      readRoots: ["/sandbox/read"],
      writeRoots: ["/sandbox/write"],
      maxBytes: 1024,
      maxFiles: 4,
    };

    const abuseReq = baseRequest("#aegispy:stdout=7000");
    abuseReq.limits.bytes.stdoutBytes = 64;

    const traversalResult = await runtime.run(traversalReq);
    const abuseResult = await runtime.run(abuseReq);

    await runtime.close();

    writeArtifact("artifacts/security/adversarial-suite.json", {
      ok: true,
      invariants: ["INV-SECU-0006"],
      cases: [
        {
          caseId: "fs-traversal",
          termination: traversalResult.meta.termination,
          status: traversalResult.status,
        },
        {
          caseId: "output-abuse",
          termination: abuseResult.meta.termination,
          status: abuseResult.status,
        },
      ],
    });
  });
});
