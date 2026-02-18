import { describe, expect, it } from "vitest";
import { createRuntime, type AegisPyRuntime } from "../../src/index";
import { writeArtifact } from "../helpers/artifact";

const invariants = ["INV-FEAT-0013", "INV-FEAT-0014"];

describe("browser runtime", () => {
  it("runs code and enforces wall time", async () => {
    const runtime: AegisPyRuntime = await createRuntime({ host: "browser" });
    const capabilities = runtime.capabilities();

    const okResult = await runtime.run({
      host: "browser",
      code: 'print("browser")',
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: null,
        http: null,
        env: null,
      },
      limits: {
        time: {
          wallMs: 30,
          cpuMs: 30,
        },
        bytes: {
          memoryBytes: 1024 * 1024,
          stdoutBytes: 1024,
          stderrBytes: 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 50,
        rngSeedHex: "abcd1234",
      },
    });

    const timeoutResult = await runtime.run({
      host: "browser",
      code: "while True: pass",
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: null,
        http: null,
        env: null,
      },
      limits: {
        time: {
          wallMs: 10,
          cpuMs: 10,
        },
        bytes: {
          memoryBytes: 1024 * 1024,
          stdoutBytes: 1024,
          stderrBytes: 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 50,
        rngSeedHex: "abcd1234",
      },
    });

    await runtime.close();

    expect(capabilities.profile).toBe("browser-subset");
    expect(capabilities.hardened).toBe(false);
    expect(capabilities.fs).toBe(false);
    expect(capabilities.http).toBe(false);
    expect(capabilities.env).toBe(false);
    expect(okResult.status).toBe("ok");
    expect(timeoutResult.status).toBe("error");

    writeArtifact("artifacts/e2e/browser-run.json", {
      ok: true,
      invariants,
      host: "browser",
      profile: capabilities.profile,
      hardened: capabilities.hardened,
      capabilityModel: {
        fs: capabilities.fs,
        http: capabilities.http,
        env: capabilities.env,
      },
      okTermination: okResult.meta.termination,
      timeoutTermination: timeoutResult.meta.termination,
    });
  });

  it("returns stable unsupported-host error for non-subset capability requests", async () => {
    const runtime: AegisPyRuntime = await createRuntime({ host: "browser" });

    const result = await runtime.run({
      host: "browser",
      code: 'print("browser-fs")',
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
          wallMs: 30,
          cpuMs: 30,
        },
        bytes: {
          memoryBytes: 1024 * 1024,
          stdoutBytes: 1024,
          stderrBytes: 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 50,
        rngSeedHex: "abcd1234",
      },
    });

    await runtime.close();

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected browser subset rejection");
    }
    expect(result.error.code).toBe("AEG-UNSUPPORTED-HOST");
  });
});
