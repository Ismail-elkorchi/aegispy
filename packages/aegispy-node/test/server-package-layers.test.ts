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

describe("server package layers", () => {
  it("fails closed when packages are requested without a lockfile", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";

    await expect(
      createRuntime({
        host: "node",
        packages: ["packaging"],
      }),
    ).rejects.toMatchObject({
      code: "AEG-ENGINE",
    });
  });

  it("fails closed when the lockfile hash is tampered", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";

    const lockfile = makeServerLockfile();
    lockfile.entries[0] = {
      ...lockfile.entries[0],
      sha256: "0".repeat(64),
    };

    await expect(
      createRuntime({
        host: "node",
        packages: ["packaging"],
        packageLockfile: lockfile,
      }),
    ).rejects.toMatchObject({
      code: "AEG-ENGINE",
    });
  });

  it("fails closed when a requested package is not pinned", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";

    const lockfile = makeServerLockfile();
    lockfile.entries = lockfile.entries.filter(
      (entry) => entry.name !== "jinja2",
    );

    await expect(
      createRuntime({
        host: "node",
        packages: ["packaging", "jinja2"],
        packageLockfile: lockfile,
      }),
    ).rejects.toMatchObject({
      code: "AEG-ENGINE",
    });
  });

  it("imports the locked pure-python package set on the server runtime", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";
    const cases = [
      {
        packages: ["packaging"],
        code: 'from packaging.version import Version\nprint(Version("2.3.4"))\n',
        expectStdout: "2.3.4",
      },
      {
        packages: ["attrs"],
        code: "import attr\nprint(hasattr(attr, 'define'))\n",
        expectStdout: "True",
      },
      {
        packages: ["attrs", "jsonschema"],
        code: 'import jsonschema\nprint(jsonschema.validators.validator_for({"type": "string"}).__name__)\n',
        expectStdout: "Draft",
      },
      {
        packages: ["jinja2", "markupsafe"],
        code: 'from jinja2 import Template\nprint(Template("hello {{ name }}").render(name="AEGISPY"))\n',
        expectStdout: "hello AEGISPY",
      },
    ] as const;

    for (const testCase of cases) {
      const runtime = await createRuntime({
        host: "node",
        packages: [...testCase.packages],
        packageLockfile: makeServerLockfile(),
      });
      const result = await runtime.run(makeRequest(testCase.code));
      await runtime.close();

      expect(result.status, JSON.stringify(result, null, 2)).toBe("ok");
      expect(result.stdoutUtf8).toContain(testCase.expectStdout);
    }
  }, 600_000);
});
