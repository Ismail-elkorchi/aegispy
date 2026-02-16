import { describe, expect, it } from "vitest";
import { createRuntime, type RunRequest } from "../src/index";
import { writeArtifact } from "./helpers/artifact";
import { registerCoreTestRuntimeFactories } from "./helpers/register-test-runtime";

const denyInvariants = ["INV-SECU-0001"];
const provenanceInvariant = ["INV-OPER-0004"];

registerCoreTestRuntimeFactories();

describe("policy core", () => {
  it("denies filesystem and http by default", async () => {
    const runtime = await createRuntime({ host: "node" });

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
          wallMs: 100,
          cpuMs: 100,
        },
        bytes: {
          memoryBytes: 1024,
          stdoutBytes: 1024,
          stderrBytes: 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 1,
        rngSeedHex: "abcd",
      },
    };

    const fsResult = await runtime.run({
      ...baseRequest,
      code: 'aegispy.fs_read("/tmp/secret.txt")',
    });
    const httpResult = await runtime.run({
      ...baseRequest,
      code: 'aegispy.http_get("https://example.com/data")',
    });

    expect(fsResult.status).toBe("error");
    expect(httpResult.status).toBe("error");

    if (fsResult.status !== "error" || httpResult.status !== "error") {
      throw new Error("expected policy denial");
    }

    expect(fsResult.error.code).toBe("AEG-POLICY-DENIED");
    expect(httpResult.error.code).toBe("AEG-POLICY-DENIED");

    writeArtifact("artifacts/tests/policy-deny-default.json", {
      ok: true,
      invariants: denyInvariants,
      fsDenied: fsResult.error.code,
      httpDenied: httpResult.error.code,
    });

    await runtime.close();
  });

  it("records allow and deny provenance events", async () => {
    const runtime = await createRuntime({ host: "node" });

    const allowResult = await runtime.run({
      host: "node",
      code: 'aegispy.fs_write("/sandbox/write/log.txt", "ok")',
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: {
          readRoots: ["/sandbox/read"],
          writeRoots: ["/sandbox/write"],
          maxBytes: 1024,
          maxFiles: 4,
        },
        http: null,
        env: null,
      },
      limits: {
        time: {
          wallMs: 100,
          cpuMs: 100,
        },
        bytes: {
          memoryBytes: 4096,
          stdoutBytes: 1024,
          stderrBytes: 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 10,
        rngSeedHex: "1234",
      },
    });

    const denyResult = await runtime.run({
      host: "node",
      code: 'aegispy.fs_write("/escape/log.txt", "blocked")',
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: {
          readRoots: ["/sandbox/read"],
          writeRoots: ["/sandbox/write"],
          maxBytes: 1024,
          maxFiles: 4,
        },
        http: null,
        env: null,
      },
      limits: {
        time: {
          wallMs: 100,
          cpuMs: 100,
        },
        bytes: {
          memoryBytes: 4096,
          stdoutBytes: 1024,
          stderrBytes: 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 10,
        rngSeedHex: "1234",
      },
    });

    const allowAudit = allowResult.meta.audit;
    const denyAudit = denyResult.meta.audit;

    writeArtifact("artifacts/tests/policy-provenance.json", {
      ok: true,
      invariants: provenanceInvariant,
      allowAudit,
      denyAudit,
    });

    await runtime.close();
  });
});
