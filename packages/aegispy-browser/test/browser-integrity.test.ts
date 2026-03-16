import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createBrowserRuntime } from "../src/index";
import {
  selectBrowserPackages,
  type BrowserEngineAssetManifest,
  verifyBrowserEngineAssets,
} from "../src/runtime/browser-integrity";
import { resolveLockfile } from "../../aegispy-pack/src/index";
import { writeArtifact } from "./helpers/artifact";

const invariants = ["INV-FEAT-0025", "INV-SECU-0007"];

function makeBrowserRequest(code: string) {
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
        wallMs: 1_000,
        cpuMs: 1_000,
      },
      bytes: {
        memoryBytes: 16 * 1024 * 1024,
        stdoutBytes: 8 * 1024,
        stderrBytes: 8 * 1024,
      },
    },
    determinism: {
      enabled: true,
      epochMs: 10,
      rngSeedHex: "abcd1234",
    },
  };
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeFetchStub(bodies: Record<string, string | Uint8Array>) {
  return async (url: string) => {
    const name = url.slice(url.lastIndexOf("/") + 1);
    const body = bodies[name];
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    const arrayBuffer = new Uint8Array(bytes.byteLength);
    arrayBuffer.set(bytes);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => arrayBuffer.buffer,
    };
  };
}

function baseLockfile() {
  return resolveLockfile({
    dependencies: [
      {
        name: "micropip",
        version: "0.10.1",
        kind: "pure_python",
      },
      {
        name: "packaging",
        version: "24.1.0",
        kind: "pure_python",
      },
    ],
    generatedAt: "2026-03-16T00:00:00.000Z",
  });
}

describe("browser integrity", () => {
  it("fails closed when browser packages are requested without a lockfile", async () => {
    const runtime = await createBrowserRuntime({
      packages: ["micropip"],
    });

    const result = await runtime.run(makeBrowserRequest('print("locked")'));

    await runtime.close();

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected browser integrity failure");
    }
    expect(result.error.code).toBe("AEG-ENGINE");
    expect(result.stderrUtf8).toContain("browser package integrity");
    expect(JSON.parse(result.error.detailJson)).toMatchObject({
      reason: "package_lockfile_missing",
    });
    expect(result.meta.audit.map((entry) => entry.kind)).toEqual([
      "runtime_channel",
      "runtime_binding",
      "engine_error",
    ]);
  });

  it("keeps browser package selection locked to verified entries", async () => {
    const lockfile = baseLockfile();
    const valid = await selectBrowserPackages(["micropip"], lockfile);

    expect(valid.ok).toBe(true);
    if (!valid.ok) {
      throw new Error("expected verified browser package selection");
    }
    expect(valid.packages).toEqual(["micropip"]);

    const tampered = structuredClone(lockfile);
    tampered.entries[0] = {
      ...tampered.entries[0],
      sha256: "0".repeat(64),
    };
    const tamperedResult = await selectBrowserPackages(["micropip"], tampered);

    expect(tamperedResult.ok).toBe(false);
    if (tamperedResult.ok) {
      throw new Error("expected tampered browser package selection failure");
    }
    expect(tamperedResult.failures).toContain("hash_mismatch:micropip@0.10.1");

    const missingResult = await selectBrowserPackages(["jinja2"], lockfile);
    expect(missingResult.ok).toBe(false);
    if (missingResult.ok) {
      throw new Error("expected unpinned package failure");
    }
    expect(missingResult.failures).toContain("package_not_pinned:jinja2");
  });

  it("keeps engine asset verification locked to pinned hashes", async () => {
    const manifest: BrowserEngineAssetManifest = {
      engine: "pyodide",
      version: "0.test",
      files: {
        "pyodide-lock.json": sha256Hex('{"name":"lock"}'),
        "pyodide.asm.wasm": sha256Hex(new Uint8Array([1, 2, 3, 4])),
        "python_stdlib.zip": sha256Hex(new Uint8Array([5, 6, 7, 8])),
      },
    };

    const valid = await verifyBrowserEngineAssets(
      "https://cdn.example.test/pyodide",
      manifest,
      makeFetchStub({
        "pyodide-lock.json": '{"name":"lock"}',
        "pyodide.asm.wasm": new Uint8Array([1, 2, 3, 4]),
        "python_stdlib.zip": new Uint8Array([5, 6, 7, 8]),
      }),
    );
    expect(valid.ok).toBe(true);

    const tampered = await verifyBrowserEngineAssets(
      "https://cdn.example.test/pyodide",
      manifest,
      makeFetchStub({
        "pyodide-lock.json": '{"name":"lock"}',
        "pyodide.asm.wasm": new Uint8Array([9, 9, 9, 9]),
        "python_stdlib.zip": new Uint8Array([5, 6, 7, 8]),
      }),
    );
    expect(tampered.ok).toBe(false);
    if (tampered.ok) {
      throw new Error("expected engine asset hash failure");
    }
    expect(tampered.failures).toContain(
      "engine_asset_hash_mismatch:pyodide.asm.wasm",
    );
  });

  it("keeps lockfile and engine verification stable across fuzzed mutations", async () => {
    let packageRuns = 0;
    let assetRuns = 0;
    let cleanPackageCases = 0;
    let tamperedPackageCases = 0;
    let missingPackageCases = 0;
    let cleanAssetCases = 0;
    let tamperedAssetCases = 0;
    let missingAssetCases = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("clean", "tampered", "missing"),
        async (scenario) => {
          packageRuns += 1;

          const lockfile = baseLockfile();
          if (scenario === "tampered") {
            lockfile.entries[0] = {
              ...lockfile.entries[0],
              sha256: "f".repeat(64),
            };
          }

          const packages = scenario === "missing" ? ["jinja2"] : ["micropip"];
          const result = await selectBrowserPackages(packages, lockfile);

          if (scenario === "clean") {
            cleanPackageCases += 1;
          } else if (scenario === "tampered") {
            tamperedPackageCases += 1;
          } else {
            missingPackageCases += 1;
          }

          expect(result.ok).toBe(scenario === "clean");
        },
      ),
      { numRuns: 60 },
    );

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("clean", "tampered", "missing"),
        async (scenario) => {
          assetRuns += 1;

          const manifest: BrowserEngineAssetManifest = {
            engine: "pyodide",
            version: "0.test",
            files: {
              "pyodide-lock.json": sha256Hex('{"name":"lock"}'),
              "pyodide.asm.wasm": sha256Hex(new Uint8Array([1, 2, 3, 4])),
              "python_stdlib.zip": sha256Hex(new Uint8Array([5, 6, 7, 8])),
            },
          };

          const result = await verifyBrowserEngineAssets(
            "https://cdn.example.test/pyodide",
            manifest,
            makeFetchStub({
              "pyodide-lock.json": '{"name":"lock"}',
              "pyodide.asm.wasm":
                scenario === "tampered"
                  ? new Uint8Array([9, 9, 9, 9])
                  : new Uint8Array([1, 2, 3, 4]),
              ...(scenario === "missing"
                ? {}
                : { "python_stdlib.zip": new Uint8Array([5, 6, 7, 8]) }),
            }),
          );

          if (scenario === "clean") {
            cleanAssetCases += 1;
          } else if (scenario === "tampered") {
            tamperedAssetCases += 1;
          } else {
            missingAssetCases += 1;
          }

          expect(result.ok).toBe(scenario === "clean");
        },
      ),
      { numRuns: 60 },
    );

    expect(cleanPackageCases).toBeGreaterThan(0);
    expect(tamperedPackageCases).toBeGreaterThan(0);
    expect(missingPackageCases).toBeGreaterThan(0);
    expect(cleanAssetCases).toBeGreaterThan(0);
    expect(tamperedAssetCases).toBeGreaterThan(0);
    expect(missingAssetCases).toBeGreaterThan(0);

    writeArtifact("artifacts/security/browser-integrity-fuzz.json", {
      ok: true,
      invariants,
      packageRuns,
      assetRuns,
      cleanPackageCases,
      tamperedPackageCases,
      missingPackageCases,
      cleanAssetCases,
      tamperedAssetCases,
      missingAssetCases,
    });
  });
});
