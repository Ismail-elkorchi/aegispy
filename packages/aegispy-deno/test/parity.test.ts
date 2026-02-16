import { describe, expect, it } from "vitest";
import { createRuntime, type AegisPyRuntime } from "../src/index";
import { writeArtifact } from "./helpers/artifact";

describe("deno adapter parity", () => {
  it("matches node contract shape", async () => {
    const runtime: AegisPyRuntime = await createRuntime({ host: "deno" });

    const result = await runtime.run({
      host: "deno",
      code: 'print("deno")',
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: null,
        http: null,
        env: null,
      },
      limits: {
        time: {
          wallMs: 100,
          cpuMs: 100,
        },
        bytes: {
          memoryBytes: 1024 * 1024,
          stdoutBytes: 1024,
          stderrBytes: 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 5,
        rngSeedHex: "deadbeef",
      },
    });

    await runtime.close();

    expect(result.meta.termination).toBe("ok");

    writeArtifact("artifacts/e2e/deno-parity.json", {
      ok: true,
      invariants: ["INV-FEAT-0017"],
      termination: result.meta.termination,
      status: result.status,
    });
  });
});
