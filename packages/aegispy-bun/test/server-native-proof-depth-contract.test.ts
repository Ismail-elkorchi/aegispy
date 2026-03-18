import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime as createNodeRuntime } from "../../aegispy-node/src/index";
import { createRuntime as createDenoRuntime } from "../../aegispy-deno/src/index";
import { createRuntime as createBunRuntime } from "../src/index";
import type { AegisPyRuntime, RunRequest } from "@aegispy/core";
import type { Lockfile, LockfileEntry } from "../../aegispy-pack/src/index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

const sharedLimits = {
  time: {
    wallMs: 5_000,
    cpuMs: 5_000,
  },
  bytes: {
    memoryBytes: 512 * 1024 * 1024,
    stdoutBytes: 32 * 1024,
    stderrBytes: 32 * 1024,
  },
};

const originalEnv = { ...process.env };
const isLinuxX64 = process.platform === "linux" && process.arch === "x64";

function lockDigest(
  name: string,
  version: string,
  artifactUrl: string,
): string {
  return createHash("sha256")
    .update(`${name}@${version}:${artifactUrl}`)
    .digest("hex");
}

function lockEntry(
  name: string,
  version: string,
  artifactUrl: string,
): LockfileEntry {
  return {
    name,
    version,
    kind: "native_platform",
    artifactUrl,
    sha256: lockDigest(name, version, artifactUrl),
  };
}

function makeNativeLockfile(): Lockfile {
  return {
    version: 1,
    generatedAt: "2026-03-18T00:00:00.000Z",
    entries: [
      lockEntry(
        "rapidfuzz",
        "3.14.3",
        "https://files.pythonhosted.org/packages/c9/bc/ef2cee3e4d8b3fc22705ff519f0d487eecc756abdc7c25d53686689d6cf2/rapidfuzz-3.14.3-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl",
      ),
    ],
  };
}

function makeRequest(host: "node" | "deno" | "bun", code: string): RunRequest {
  return {
    host,
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

function readEvidenceMatrix(): {
  server: {
    supportedNativePlatformClaims: Array<{
      host: string;
      os: string;
      arch: string;
      packages: string[];
      proofDepth: string;
    }>;
  };
} {
  return JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "tools/evidence-matrix.v1.json"),
      "utf8",
    ),
  ) as {
    server: {
      supportedNativePlatformClaims: Array<{
        host: string;
        os: string;
        arch: string;
        packages: string[];
        proofDepth: string;
      }>;
    };
  };
}

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("server native proof-depth contract", () => {
  it.runIf(isLinuxX64)(
    "keeps native claims at package depth until module imports are proven across server hosts",
    async () => {
      process.env.AEGISPY_NODE_TRANSPORT = "process";
      process.env.AEGISPY_DENO_TRANSPORT = "process";
      process.env.AEGISPY_BUN_TRANSPORT = "process";

      const matrix = readEvidenceMatrix();
      expect(matrix.server.supportedNativePlatformClaims).toEqual([
        {
          host: "bun",
          os: "linux",
          arch: "x64",
          packages: ["rapidfuzz"],
          proofDepth: "package",
        },
        {
          host: "deno",
          os: "linux",
          arch: "x64",
          packages: ["rapidfuzz"],
          proofDepth: "package",
        },
        {
          host: "node",
          os: "linux",
          arch: "x64",
          packages: ["rapidfuzz"],
          proofDepth: "package",
        },
      ]);

      const code = [
        "import json",
        "import importlib.util",
        "import rapidfuzz",
        "payload = {'version': getattr(rapidfuzz, '__version__', None)}",
        "spec = importlib.util.find_spec('rapidfuzz.fuzz_cpp')",
        "payload['moduleImported'] = spec is not None",
        "if spec is None:",
        '    payload["error"] = "ModuleNotFoundError: No module named \'rapidfuzz.fuzz_cpp\'"',
        "else:",
        "    import rapidfuzz.fuzz_cpp as fuzz_cpp",
        "    payload['ratio'] = fuzz_cpp.ratio('kitten', 'sitting')",
        "print(json.dumps(payload, sort_keys=True))",
      ].join("\n");

      const cases: Array<{
        host: "node" | "deno" | "bun";
        createRuntime: () => Promise<AegisPyRuntime>;
      }> = [
        {
          host: "node",
          createRuntime: () =>
            createNodeRuntime({
              host: "node",
              packages: ["rapidfuzz"],
              packageLockfile: makeNativeLockfile(),
            }),
        },
        {
          host: "deno",
          createRuntime: () =>
            createDenoRuntime({
              host: "deno",
              packages: ["rapidfuzz"],
              packageLockfile: makeNativeLockfile(),
            }),
        },
        {
          host: "bun",
          createRuntime: () =>
            createBunRuntime({
              host: "bun",
              packages: ["rapidfuzz"],
              packageLockfile: makeNativeLockfile(),
            }),
        },
      ];

      for (const testCase of cases) {
        const runtime = await testCase.createRuntime();
        const result = await runtime.run(makeRequest(testCase.host, code));
        await runtime.close();

        expect(result.status, JSON.stringify(result, null, 2)).toBe("ok");
        expect(result.stdoutUtf8).toContain('"version": "3.14.3"');
        expect(result.stdoutUtf8).toContain('"moduleImported": false');
        expect(result.stdoutUtf8).toContain(
          '"error": "ModuleNotFoundError: No module named \'rapidfuzz.fuzz_cpp\'"',
        );
      }
    },
    900_000,
  );
});
