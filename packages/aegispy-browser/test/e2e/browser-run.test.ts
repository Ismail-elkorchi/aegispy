import http from "node:http";
import { describe, expect, it } from "vitest";
import {
  createBrowserRuntime,
  createRuntime,
  type AegisPyRuntime,
  type BrowserRuntimeOptions,
} from "../../src/index";
import { writeArtifact } from "../helpers/artifact";

const invariants = ["INV-FEAT-0013", "INV-FEAT-0014"];

function makeBrowserRequest(code: string, wallMs = 30_000) {
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

async function withHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    throw new Error("expected tcp server address");
  }

  await Promise.resolve(run(`http://127.0.0.1:${address.port}`)).finally(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  );
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
  }, 45_000);

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
    expect(capabilities.capabilityFamilies).toEqual({
      storage: "unavailable",
      network: "available_granted",
      fileAccess: "unavailable",
      worker: "available_granted",
      handles: "unavailable",
    });
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
        capabilityFamilies: capabilities.capabilityFamilies,
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
  }, 45_000);

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
    expect(result.meta.termination).toBe("policy_denied");
    expect(result.meta.audit.map((entry) => entry.kind)).toEqual([
      "runtime_channel",
      "runtime_binding",
      "policy_denied",
    ]);
    expect(result.meta.audit[0]?.detailJson).toBe(
      "capability_channel:worker-timeout",
    );
    expect(JSON.parse(result.meta.audit[2]?.detailJson ?? "{}")).toMatchObject({
      reason: "host_profile_capability_unsupported",
      unsupportedCapabilities: ["fs"],
      profile: "browser-real-engine",
    });
  });

  it("rejects unavailable browser-native capability requests on the new request surface", async () => {
    const runtime: AegisPyRuntime = await createRuntime({ host: "browser" });

    const result = await runtime.run({
      ...makeBrowserRequest('print("browser-network")'),
      requestedCapabilities: {
        storage: {
          maxBytes: 1024,
        },
      },
    });

    await runtime.close();

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected browser-native capability denial");
    }
    expect(result.error.code).toBe("AEG-UNSUPPORTED-HOST");
    expect(result.meta.termination).toBe("policy_denied");
    expect(JSON.parse(result.meta.audit[2]?.detailJson ?? "{}")).toMatchObject({
      reason: "host_profile_capability_unsupported",
      unsupportedCapabilities: ["storage"],
      profile: "browser-real-engine",
    });
  });

  it("executes browser-native network requests through the real engine", async () => {
    await withHttpServer(
      (req, res) => {
        if (req.url !== "/payload") {
          res.writeHead(404);
          res.end("missing");
          return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("browser-fetch-ok");
      },
      async (origin) => {
        const runtime: AegisPyRuntime = await createRuntime({
          host: "browser",
        });

        const result = await runtime.run({
          ...makeBrowserRequest(
            [
              "import aegispy",
              `print(aegispy.http_get(${JSON.stringify(`${origin}/payload`)}))`,
            ].join("\n"),
          ),
          requestedCapabilities: {
            network: {
              allowOrigins: [origin],
              maxRequests: 1,
              maxBytes: 1024,
            },
          },
        });

        await runtime.close();

        expect(result.status).toBe("ok");
        expect(result.stdoutUtf8).toContain("browser-fetch-ok");
      },
    );
  }, 60_000);

  it("rejects browser-native network requests when the origin is not granted", async () => {
    await withHttpServer(
      (_, res) => {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("browser-fetch-denied");
      },
      async (origin) => {
        const runtime: AegisPyRuntime = await createRuntime({
          host: "browser",
        });

        const result = await runtime.run({
          ...makeBrowserRequest(
            [
              "import aegispy",
              `print(aegispy.http_get(${JSON.stringify(`${origin}/payload`)}))`,
            ].join("\n"),
          ),
          requestedCapabilities: {
            network: {
              allowOrigins: ["https://example.com"],
              maxRequests: 1,
              maxBytes: 1024,
            },
          },
        });

        await runtime.close();

        expect(result.status).toBe("error");
        if (result.status !== "error") {
          throw new Error("expected browser-native network denial");
        }
        expect(result.error.code).toBe("AEG-POLICY-DENIED");
        expect(result.meta.termination).toBe("policy_denied");
        expect(result.stderrUtf8).toContain("http_origin_denied");
      },
    );
  }, 60_000);

  it("enforces browser-native network request budgets", async () => {
    await withHttpServer(
      (_, res) => {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("budget-ok");
      },
      async (origin) => {
        const runtime: AegisPyRuntime = await createRuntime({
          host: "browser",
        });

        const result = await runtime.run({
          ...makeBrowserRequest(
            [
              "import aegispy",
              `print(aegispy.http_get(${JSON.stringify(`${origin}/payload`)}))`,
              `print(aegispy.http_get(${JSON.stringify(`${origin}/payload`)}))`,
            ].join("\n"),
          ),
          requestedCapabilities: {
            network: {
              allowOrigins: [origin],
              maxRequests: 1,
              maxBytes: 1024,
            },
          },
        });

        await runtime.close();

        expect(result.status).toBe("error");
        if (result.status !== "error") {
          throw new Error(
            "expected browser-native network request-budget denial",
          );
        }
        expect(result.error.code).toBe("AEG-POLICY-DENIED");
        expect(result.meta.termination).toBe("policy_denied");
        expect(result.stderrUtf8).toContain("http_max_requests_exceeded");
      },
    );
  }, 60_000);

  it("enforces browser-native network byte budgets", async () => {
    await withHttpServer(
      (_, res) => {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("0123456789");
      },
      async (origin) => {
        const runtime: AegisPyRuntime = await createRuntime({
          host: "browser",
        });

        const result = await runtime.run({
          ...makeBrowserRequest(
            [
              "import aegispy",
              `print(aegispy.http_get(${JSON.stringify(`${origin}/payload`)}))`,
            ].join("\n"),
          ),
          requestedCapabilities: {
            network: {
              allowOrigins: [origin],
              maxRequests: 1,
              maxBytes: 5,
            },
          },
        });

        await runtime.close();

        expect(result.status).toBe("error");
        if (result.status !== "error") {
          throw new Error("expected browser-native network byte-budget denial");
        }
        expect(result.error.code).toBe("AEG-POLICY-DENIED");
        expect(result.meta.termination).toBe("policy_denied");
        expect(result.stderrUtf8).toContain("http_byte_budget_reached");
      },
    );
  }, 60_000);
});
