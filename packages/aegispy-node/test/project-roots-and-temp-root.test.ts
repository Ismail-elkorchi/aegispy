import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/index";
import type { AegisPyRuntime, RunRequest } from "@aegispy/core";

const sharedLimits = {
  time: {
    wallMs: 5_000,
    cpuMs: 5_000,
  },
  bytes: {
    memoryBytes: 64 * 1024 * 1024,
    stdoutBytes: 16 * 1024,
    stderrBytes: 16 * 1024,
  },
};

const originalEnv = { ...process.env };
const tempPaths: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
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

function auditDetails(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  result: Awaited<ReturnType<AegisPyRuntime["run"]>>,
  kind: string,
): string[] {
  void runtime;
  return result.meta.audit
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.detailJson);
}

afterEach(() => {
  process.env = { ...originalEnv };
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath) {
      fs.rmSync(tempPath, { recursive: true, force: true });
    }
  }
});

describe("project roots and guest temp root", () => {
  it("prepends projected project roots to guest imports in the provided order", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";

    const firstRoot = createTempDir("aegispy-project-root-first-");
    const secondRoot = createTempDir("aegispy-project-root-second-");
    fs.mkdirSync(path.join(firstRoot, "priority_pkg"), { recursive: true });
    fs.mkdirSync(path.join(secondRoot, "priority_pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(firstRoot, "priority_pkg", "__init__.py"),
      'VALUE = "first-root"\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(secondRoot, "priority_pkg", "__init__.py"),
      'VALUE = "second-root"\n',
      "utf8",
    );

    const runtime = await createRuntime({
      host: "node",
      projectRoots: [firstRoot, secondRoot],
    });
    const result = await runtime.run(
      makeRequest("import priority_pkg\nprint(priority_pkg.VALUE)"),
    );
    await runtime.close();

    expect(result.status).toBe("ok");
    expect(result.stdoutUtf8).toContain("first-root");
    expect(auditDetails(runtime, result, "runtime_projection")).toContain(
      "project_root:/workspace/projects/0",
    );
    expect(auditDetails(runtime, result, "runtime_projection")).toContain(
      "project_root:/workspace/projects/1",
    );
  }, 600_000);

  it("imports a package written into the guest writable root", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";

    const runtime = await createRuntime({ host: "node" });
    const request = makeRequest(
      "import importlib\n" +
        "import os\n" +
        'assert os.path.isdir("/workspace/bindings/fs/sandbox/write")\n' +
        'aegispy.fs_write("/sandbox/write/guest_pkg/__init__.py", \'VALUE = "guest-write"\\n\')\n' +
        "importlib.invalidate_caches()\n" +
        "import guest_pkg\n" +
        "print(guest_pkg.VALUE)\n",
    );
    request.permissions.fs = {
      readRoots: ["/sandbox/write"],
      writeRoots: ["/sandbox/write"],
      maxBytes: 4096,
      maxFiles: 8,
    };

    const result = await runtime.run(request);
    await runtime.close();

    expect(result.status).toBe("ok");
    expect(result.stdoutUtf8).toContain("guest-write");
    expect(auditDetails(runtime, result, "runtime_projection")).toContain(
      "writable_import_root:/workspace/bindings/fs/sandbox/write",
    );
  }, 600_000);

  it("maps tempfile.gettempdir to the guest temp root", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";

    const tempRoot = createTempDir("aegispy-guest-temp-root-");
    const runtime = await createRuntime({
      host: "node",
      tempRoot,
    });
    const result = await runtime.run(
      makeRequest("import tempfile\nprint(tempfile.gettempdir())"),
    );
    await runtime.close();

    expect(result.status).toBe("ok");
    expect(result.stdoutUtf8.trim()).toBe("/tmp");
    expect(auditDetails(runtime, result, "runtime_temp_root")).toContain(
      "guest_temp_root:/tmp",
    );
  }, 600_000);

  it("creates reads and removes files inside the guest temp root", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";

    const tempRoot = createTempDir("aegispy-guest-temp-files-");
    const runtime = await createRuntime({
      host: "node",
      tempRoot,
    });
    const result = await runtime.run(
      makeRequest(
        [
          "import json",
          "import os",
          "import tempfile",
          "fd, temp_path = tempfile.mkstemp(prefix='case-', suffix='.txt')",
          "os.close(fd)",
          "with open(temp_path, 'w', encoding='utf-8') as handle:",
          "    handle.write('temp-data')",
          "with open(temp_path, 'r', encoding='utf-8') as handle:",
          "    payload = handle.read()",
          "exists_before_remove = os.path.exists(temp_path)",
          "os.remove(temp_path)",
          "print(json.dumps({",
          "    'tempdir': tempfile.gettempdir(),",
          "    'tempPath': temp_path,",
          "    'payload': payload,",
          "    'existsBeforeRemove': exists_before_remove,",
          "    'existsAfterRemove': os.path.exists(temp_path),",
          "}))",
        ].join("\n"),
      ),
    );
    await runtime.close();

    expect(result.status).toBe("ok");
    const parsed = JSON.parse(result.stdoutUtf8.trim()) as {
      existsAfterRemove: boolean;
      existsBeforeRemove: boolean;
      payload: string;
      tempPath: string;
      tempdir: string;
    };
    expect(parsed.tempdir).toBe("/tmp");
    expect(parsed.tempPath.startsWith("/tmp/")).toBe(true);
    expect(parsed.payload).toBe("temp-data");
    expect(parsed.existsBeforeRemove).toBe(true);
    expect(parsed.existsAfterRemove).toBe(false);
  }, 600_000);
});
