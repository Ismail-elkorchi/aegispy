import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/index";
import type { Lockfile, LockfileEntry } from "../../aegispy-pack/src/index";
import type { RunRequest } from "@aegispy/core";

const sharedLimits = {
  time: {
    wallMs: 5_000,
    cpuMs: 5_000,
  },
  bytes: {
    memoryBytes: 256 * 1024 * 1024,
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

function makeNativeLockfile(artifactUrl: string): Lockfile {
  return {
    version: 1,
    generatedAt: "2026-03-18T00:00:00.000Z",
    entries: [lockEntry("rapidfuzz", "3.14.3", artifactUrl)],
  };
}

function makeRequest(code: string): RunRequest {
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

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("server native package layers", () => {
  it.runIf(isLinuxX64)(
    "fails closed when the native package artifact does not match the current target",
    async () => {
      process.env.AEGISPY_NODE_TRANSPORT = "process";

      await expect(
        createRuntime({
          host: "node",
          packages: ["rapidfuzz"],
          packageLockfile: makeNativeLockfile(
            "https://files.pythonhosted.org/packages/32/6f/1b88aaeade83abc5418788f9e6b01efefcd1a69d65ded37d89cd1662be41/rapidfuzz-3.14.3-cp314-cp314-macosx_10_15_x86_64.whl",
          ),
        }),
      ).rejects.toMatchObject({
        code: "AEG-ENGINE",
      });
    },
  );

  it.runIf(isLinuxX64)(
    "fails closed when the native package lockfile hash is tampered",
    async () => {
      process.env.AEGISPY_NODE_TRANSPORT = "process";

      const lockfile = makeNativeLockfile(
        "https://files.pythonhosted.org/packages/c9/bc/ef2cee3e4d8b3fc22705ff519f0d487eecc756abdc7c25d53686689d6cf2/rapidfuzz-3.14.3-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl",
      );
      lockfile.entries[0] = {
        ...lockfile.entries[0],
        sha256: "0".repeat(64),
      };

      await expect(
        createRuntime({
          host: "node",
          packages: ["rapidfuzz"],
          packageLockfile: lockfile,
        }),
      ).rejects.toMatchObject({
        code: "AEG-ENGINE",
      });
    },
  );

  it.runIf(isLinuxX64)(
    "imports a locked target-specific native package layer on the server runtime",
    async () => {
      process.env.AEGISPY_NODE_TRANSPORT = "process";

      const runtime = await createRuntime({
        host: "node",
        packages: ["rapidfuzz"],
        packageLockfile: makeNativeLockfile(
          "https://files.pythonhosted.org/packages/c9/bc/ef2cee3e4d8b3fc22705ff519f0d487eecc756abdc7c25d53686689d6cf2/rapidfuzz-3.14.3-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl",
        ),
      });
      const result = await runtime.run(
        makeRequest(
          [
            "import json",
            "import rapidfuzz",
            "from rapidfuzz import fuzz",
            "payload = {",
            "  'version': getattr(rapidfuzz, '__version__', None),",
            "  'ratio': fuzz.ratio('kitten', 'sitting'),",
            "}",
            "print(json.dumps(payload, sort_keys=True))",
          ].join("\n"),
        ),
      );
      await runtime.close();

      expect(result.status, JSON.stringify(result, null, 2)).toBe("ok");
      expect(result.stdoutUtf8).toContain('"version": "3.14.3"');
      expect(result.stdoutUtf8).toContain('"ratio": 61.53846153846154');
    },
    600_000,
  );
});
