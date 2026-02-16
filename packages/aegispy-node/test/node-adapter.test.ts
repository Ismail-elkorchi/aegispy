import { describe, expect, it } from "vitest";
import { createRuntime, type AegisPyRuntime } from "../src/index";
import { runSelfTest } from "../src/cli/selftest";
import { writeArtifact } from "./helpers/artifact";

const invariants = [
  "INV-FEAT-0009",
  "INV-FEAT-0012",
  "INV-OPER-0001",
  "INV-OPER-0002",
];

describe("node adapter", () => {
  it("runs via node runtime interface", async () => {
    const runtime: AegisPyRuntime = await createRuntime({ host: "node" });

    const result = await runtime.run({
      host: "node",
      code: 'print("node")',
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: null,
        http: null,
        env: null,
      },
      limits: {
        time: {
          wallMs: 500,
          cpuMs: 500,
        },
        bytes: {
          memoryBytes: 1024 * 1024,
          stdoutBytes: 1024,
          stderrBytes: 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 100,
        rngSeedHex: "1234abcd",
      },
    });

    await runtime.close();

    expect(result.status).toBe("ok");
    expect(result.meta.audit.length).toBeGreaterThanOrEqual(0);

    const selftest = await runSelfTest();

    writeArtifact("artifacts/tests/node-adapter.json", {
      ok: true,
      invariants,
      result,
      selftest,
    });

    writeArtifact("artifacts/tests/meta-audit.json", {
      ok: true,
      invariants: ["INV-FEAT-0012"],
      meta: result.meta,
    });

    writeArtifact("artifacts/tests/worker-logs.json", {
      ok: true,
      invariants: ["INV-OPER-0001"],
      logs: [
        {
          level: "info",
          event: "node-runtime-run",
          termination: result.meta.termination,
        },
      ],
    });

    writeArtifact("artifacts/tests/selftest.json", {
      ok: selftest.ok,
      invariants: ["INV-OPER-0002"],
      selftest,
    });
  }, 600_000);
});
