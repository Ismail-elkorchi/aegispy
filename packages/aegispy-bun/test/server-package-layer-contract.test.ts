import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime as createNodeRuntime } from "../../aegispy-node/src/index";
import { createRuntime as createDenoRuntime } from "../../aegispy-deno/src/index";
import { createRuntime as createBunRuntime } from "../src/index";
import type { AegisPyRuntime, RunRequest } from "@aegispy/core";
import type { Lockfile, LockfileEntry } from "../../aegispy-pack/src/index";

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
    kind: "pure_python",
    artifactUrl,
    sha256: lockDigest(name, version, artifactUrl),
  };
}

function makeServerLockfile(): Lockfile {
  return {
    version: 1,
    generatedAt: "2026-03-18T00:00:00.000Z",
    entries: [
      lockEntry(
        "packaging",
        "24.1",
        "https://files.pythonhosted.org/packages/source/p/packaging/packaging-24.1.tar.gz",
      ),
      lockEntry(
        "attrs",
        "24.2.0",
        "https://files.pythonhosted.org/packages/source/a/attrs/attrs-24.2.0.tar.gz",
      ),
      lockEntry(
        "jsonschema",
        "4.17.3",
        "https://files.pythonhosted.org/packages/source/j/jsonschema/jsonschema-4.17.3.tar.gz",
      ),
      lockEntry(
        "pyrsistent",
        "0.20.0",
        "https://files.pythonhosted.org/packages/source/p/pyrsistent/pyrsistent-0.20.0.tar.gz",
      ),
      lockEntry(
        "jinja2",
        "3.1.4",
        "https://files.pythonhosted.org/packages/source/j/jinja2/jinja2-3.1.4.tar.gz",
      ),
      lockEntry(
        "markupsafe",
        "3.0.2",
        "https://files.pythonhosted.org/packages/source/m/markupsafe/markupsafe-3.0.2.tar.gz",
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

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("server package layer contract", () => {
  it("imports the same locked pure-python package set across node deno and bun", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";
    process.env.AEGISPY_DENO_TRANSPORT = "process";
    process.env.AEGISPY_BUN_TRANSPORT = "process";

    const lockfile = makeServerLockfile();
    const code =
      "from packaging.version import Version\n" +
      "import attr\n" +
      "import jsonschema\n" +
      "from jinja2 import Template\n" +
      'print(Version("2.3.4"))\n' +
      "print(hasattr(attr, 'define'))\n" +
      'print(jsonschema.validators.validator_for({"type": "string"}).__name__)\n' +
      'print(Template("hello {{ name }}").render(name="AEGISPY"))\n';

    const cases: Array<{
      host: "node" | "deno" | "bun";
      createRuntime: () => Promise<AegisPyRuntime>;
    }> = [
      {
        host: "node",
        createRuntime: () =>
          createNodeRuntime({
            host: "node",
            packages: ["packaging", "attrs", "jsonschema", "jinja2"],
            packageLockfile: lockfile,
          }),
      },
      {
        host: "deno",
        createRuntime: () =>
          createDenoRuntime({
            host: "deno",
            packages: ["packaging", "attrs", "jsonschema", "jinja2"],
            packageLockfile: lockfile,
          }),
      },
      {
        host: "bun",
        createRuntime: () =>
          createBunRuntime({
            host: "bun",
            packages: ["packaging", "attrs", "jsonschema", "jinja2"],
            packageLockfile: lockfile,
          }),
      },
    ];

    for (const testCase of cases) {
      const runtime = await testCase.createRuntime();
      const result = await runtime.run(makeRequest(testCase.host, code));
      await runtime.close();

      expect(result.status, JSON.stringify(result, null, 2)).toBe("ok");
      expect(result.stdoutUtf8).toContain("2.3.4");
      expect(result.stdoutUtf8).toContain("True");
      expect(result.stdoutUtf8).toContain("Draft");
      expect(result.stdoutUtf8).toContain("hello AEGISPY");
    }
  }, 900_000);
});
