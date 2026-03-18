import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime as createNodeRuntime } from "../../aegispy-node/src/index";
import { createRuntime as createDenoRuntime } from "../../aegispy-deno/src/index";
import { createRuntime as createBunRuntime } from "../src/index";
import type { RunRequest } from "@aegispy/core";

const sharedLimits = {
  time: {
    wallMs: 5_000,
    cpuMs: 5_000,
  },
  bytes: {
    memoryBytes: 128 * 1024 * 1024,
    stdoutBytes: 32 * 1024,
    stderrBytes: 32 * 1024,
  },
};

const tempPaths: string[] = [];
const originalEnv = {
  node: process.env.AEGISPY_NODE_TRANSPORT,
  deno: process.env.AEGISPY_DENO_TRANSPORT,
  bun: process.env.AEGISPY_BUN_TRANSPORT,
};

type ServerHost = "node" | "deno" | "bun";

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

function makeRequest(host: ServerHost, code: string): RunRequest {
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

function writeProjectedPackage(root: string): void {
  const pkgDir = path.join(root, "workflow_probe");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "__init__.py"),
    'VALUE = "workflow-probe"\n',
  );
  fs.writeFileSync(
    path.join(pkgDir, "tasks.py"),
    [
      "from __future__ import annotations",
      "",
      "import datetime as dt",
      "import json",
      "import pathlib",
      "",
      "def _task_dir(tasks_root: pathlib.Path, task_id: str) -> pathlib.Path:",
      "    return tasks_root / task_id",
      "",
      "def bootstrap_probe(base_dir: str) -> str:",
      "    root = pathlib.Path(base_dir)",
      "    task_dir = root / 'tasks' / 'bootstrap_task'",
      "    (task_dir / 'artifacts').mkdir(parents=True, exist_ok=True)",
      "    (task_dir / 'metrics.json').write_text('{}', encoding='utf-8')",
      "    (task_dir / 'promotion.json').write_text('{\"passed\": true}', encoding='utf-8')",
      "    (task_dir / 'falsification.md').write_text('# ok\\n', encoding='utf-8')",
      "    payload = {",
      "        'metricsExists': (task_dir / 'metrics.json').exists(),",
      "        'artifactsExists': (task_dir / 'artifacts').exists(),",
      "        'taskDirStat': task_dir.stat().st_mtime,",
      "    }",
      "    return json.dumps(payload, sort_keys=True)",
      "",
      "def production_gate_probe(base_dir: str) -> str:",
      "    tasks_root = pathlib.Path(base_dir) / 'tasks'",
      "    dependencies = ['alpha', 'beta', 'gamma']",
      "    for dependency_id in dependencies:",
      "        task_dir = _task_dir(tasks_root, dependency_id)",
      "        (task_dir / 'artifacts').mkdir(parents=True, exist_ok=True)",
      "        (task_dir / 'metrics.json').write_text('{}', encoding='utf-8')",
      "        (task_dir / 'promotion.json').write_text('{\"passed\": true}', encoding='utf-8')",
      "        (task_dir / 'falsification.md').write_text('# ok\\n', encoding='utf-8')",
      "    now = dt.datetime.now(dt.timezone.utc)",
      "    freshness = []",
      "    missing = []",
      "    for dependency_id in dependencies:",
      "        task_dir = _task_dir(tasks_root, dependency_id)",
      "        freshness.append(",
      "            {",
      "                'taskId': dependency_id,",
      "                'hoursOld': (",
      "                    now - dt.datetime.fromtimestamp(task_dir.stat().st_mtime, dt.timezone.utc)",
      "                ).total_seconds() / 3600,",
      "            }",
      "        )",
      "        for required in ['metrics.json', 'falsification.md', 'promotion.json', 'artifacts']:",
      "            target = task_dir / required",
      "            missing.append({'taskId': dependency_id, 'required': required, 'exists': target.exists()})",
      "    return json.dumps({'freshness': freshness, 'missing': missing}, sort_keys=True)",
    ].join("\n"),
    "utf8",
  );
}

async function createRuntime(
  host: ServerHost,
  projectRoot: string,
  tempRoot: string,
) {
  const options = {
    host,
    projectRoots: [projectRoot],
    tempRoot,
  };
  if (host === "node") return createNodeRuntime(options);
  if (host === "deno") return createDenoRuntime(options);
  return createBunRuntime(options);
}

afterEach(() => {
  if (originalEnv.node === undefined) {
    delete process.env.AEGISPY_NODE_TRANSPORT;
  } else {
    process.env.AEGISPY_NODE_TRANSPORT = originalEnv.node;
  }
  if (originalEnv.deno === undefined) {
    delete process.env.AEGISPY_DENO_TRANSPORT;
  } else {
    process.env.AEGISPY_DENO_TRANSPORT = originalEnv.deno;
  }
  if (originalEnv.bun === undefined) {
    delete process.env.AEGISPY_BUN_TRANSPORT;
  } else {
    process.env.AEGISPY_BUN_TRANSPORT = originalEnv.bun;
  }
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath) {
      fs.rmSync(tempPath, { recursive: true, force: true });
    }
  }
});

describe("server runtime metadata contract", () => {
  it("keeps the distilled workflow bootstrap path green across server hosts", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";
    process.env.AEGISPY_DENO_TRANSPORT = "process";
    process.env.AEGISPY_BUN_TRANSPORT = "process";

    for (const host of ["node", "deno", "bun"] as const) {
      const projectRoot = createTempDir(`aegispy-${host}-project-root-`);
      const tempRoot = createTempDir(`aegispy-${host}-temp-root-`);
      writeProjectedPackage(projectRoot);

      const runtime = await createRuntime(host, projectRoot, tempRoot);
      const result = await runtime.run(
        makeRequest(
          host,
          [
            "import json",
            "import pathlib",
            "import tempfile",
            "from workflow_probe.tasks import bootstrap_probe",
            "print(bootstrap_probe(str(pathlib.Path(tempfile.gettempdir()) / 'run-a')))",
          ].join("\n"),
        ),
      );
      await runtime.close();

      expect(result.status, JSON.stringify(result, null, 2)).toBe("ok");
      expect(result.stdoutUtf8).toContain('"metricsExists": true');
      expect(result.stdoutUtf8).toContain('"artifactsExists": true');
    }
  }, 900_000);

  it("preserves generated task metadata traversal across server hosts", async () => {
    process.env.AEGISPY_NODE_TRANSPORT = "process";
    process.env.AEGISPY_DENO_TRANSPORT = "process";
    process.env.AEGISPY_BUN_TRANSPORT = "process";

    for (const host of ["node", "deno", "bun"] as const) {
      const projectRoot = createTempDir(`aegispy-${host}-project-root-`);
      const tempRoot = createTempDir(`aegispy-${host}-temp-root-`);
      writeProjectedPackage(projectRoot);

      const runtime = await createRuntime(host, projectRoot, tempRoot);
      const result = await runtime.run(
        makeRequest(
          host,
          [
            "import pathlib",
            "import tempfile",
            "from workflow_probe.tasks import production_gate_probe",
            "print(production_gate_probe(str(pathlib.Path(tempfile.gettempdir()) / 'run-b')))",
          ].join("\n"),
        ),
      );
      await runtime.close();

      expect(result.status, JSON.stringify(result, null, 2)).toBe("ok");
      expect(result.stdoutUtf8).toContain('"exists": true');
      expect(result.stdoutUtf8).toContain('"hoursOld"');
    }
  }, 900_000);
});
