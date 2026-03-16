import { describe, expect, it } from "vitest";
import {
  createBrowserRuntime,
  createRuntime,
  type AegisPyRuntime,
  type BrowserRuntimeOptions,
} from "../../src/index";
import { writeArtifact } from "../helpers/artifact";

const invariants = ["INV-FEAT-0013", "INV-FEAT-0014"];

function makeBrowserRequest(code: string, wallMs = 5000) {
  return {
    host: "browser" as const,
    code,
    argv: ["python"],
    stdinUtf8: "",
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    limits: {
      time: {
        wallMs,
        cpuMs: wallMs,
      },
      bytes: {
        memoryBytes: 16 * 1024 * 1024,
        stdoutBytes: 8 * 1024,
        stderrBytes: 8 * 1024,
      },
    },
    determinism: {
      enabled: true,
      epochMs: 50,
      rngSeedHex: "abcd1234",
    },
  };
}

describe("browser runtime", () => {
  it("exposes createBrowserRuntime with browser options", async () => {
    const options: BrowserRuntimeOptions = {
      engine: "pyodide",
      packages: [],
    };
    const runtime: AegisPyRuntime = await createBrowserRuntime(options);

    const result = await runtime.run(makeBrowserRequest('print("direct-api")'));

    await runtime.close();

    expect(result.status).toBe("ok");
    expect(result.stdoutUtf8).toContain("direct-api");
  }, 20_000);

  it("uses a real browser engine, imports stdlib, and recovers after timeout", async () => {
    const runtime: AegisPyRuntime = await createRuntime({ host: "browser" });
    const capabilities = runtime.capabilities();

    const okResult = await runtime.run(
      makeBrowserRequest(
        [
          "import statistics",
          'print("browser-real-engine")',
          "print(statistics.mean([1, 2, 3]))",
        ].join("\n"),
      ),
    );

    const timeoutResult = await runtime.run(
      makeBrowserRequest("while True:\n    pass", 10),
    );

    const recoveryResult = await runtime.run(
      makeBrowserRequest("import math\nprint(math.factorial(5))", 30_000),
    );
    await runtime.close();

    expect(capabilities.profile).toBe("browser-real-engine");
    expect(capabilities.hardened).toBe(false);
    expect(capabilities.fs).toBe(false);
    expect(capabilities.http).toBe(false);
    expect(capabilities.env).toBe(false);
    expect(okResult.status).toBe("ok");
    expect(okResult.stdoutUtf8).toContain("browser-real-engine");
    expect(okResult.stdoutUtf8).toContain("2");
    expect(timeoutResult.status).toBe("error");
    expect(timeoutResult.meta.termination).toBe("timeout");
    expect(recoveryResult.status).toBe("ok");
    expect(recoveryResult.stdoutUtf8).toContain("120");

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
      recoveryTermination: recoveryResult.meta.termination,
    });
  }, 60_000);

  it("runs heavier stdlib hashing workloads in the real browser engine", async () => {
    const runtime: AegisPyRuntime = await createRuntime({ host: "browser" });

    const result = await runtime.run(
      makeBrowserRequest(
        [
          "import json",
          "import hashlib",
          'payload = json.dumps({"answer": 42, "tags": ["a", "b"]}, sort_keys=True)',
          "print(hashlib.sha256(payload.encode()).hexdigest())",
        ].join("\n"),
        30_000,
      ),
    );

    await runtime.close();

    expect(result.status).toBe("ok");
    expect(result.stdoutUtf8.trim()).toMatch(/^[0-9a-f]{64}$/u);
  }, 45_000);

  it("returns engine errors from real python execution", async () => {
    const runtime: AegisPyRuntime = await createRuntime({ host: "browser" });

    const result = await runtime.run(
      makeBrowserRequest("raise RuntimeError('browser-engine-failure')"),
    );

    await runtime.close();

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected browser engine error");
    }
    expect(result.error.code).toBe("AEG-ENGINE");
    expect(result.stderrUtf8).toContain("browser-engine-failure");
  }, 20_000);

  it("returns stable unsupported-host error for non-subset capability requests", async () => {
    const runtime: AegisPyRuntime = await createRuntime({ host: "browser" });

    const result = await runtime.run({
      ...makeBrowserRequest('print("browser-fs")'),
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
    });

    await runtime.close();

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected browser subset rejection");
    }
    expect(result.error.code).toBe("AEG-UNSUPPORTED-HOST");
  });
});
