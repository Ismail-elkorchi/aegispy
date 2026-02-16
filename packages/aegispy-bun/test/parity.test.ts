import { describe, expect, it } from "vitest";
import { createRuntime, type AegisPyRuntime } from "../src/index";
import { createRuntime as createNodeRuntime } from "../../aegispy-node/src/index";
import { createRuntime as createDenoRuntime } from "../../aegispy-deno/src/index";
import { createRuntime as createBrowserRuntime } from "../../aegispy-browser/src/index";
import { writeArtifact } from "./helpers/artifact";

describe("bun adapter parity", () => {
  it("matches node contract shape", async () => {
    const runtime: AegisPyRuntime = await createRuntime({ host: "bun" });

    const result = await runtime.run({
      host: "bun",
      code: 'print("bun")',
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
        rngSeedHex: "feedface",
      },
    });

    await runtime.close();

    expect(result.meta.termination).toBe("ok");

    writeArtifact("artifacts/e2e/bun-parity.json", {
      ok: true,
      invariants: ["INV-FEAT-0018"],
      termination: result.meta.termination,
      status: result.status,
    });
  });

  it("writes cross-host parity contract", async () => {
    const request = {
      code: 'print("parity")',
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
        epochMs: 9,
        rngSeedHex: "0a0b0c0d",
      },
    };

    const nodeRuntime = await createNodeRuntime({ host: "node" });
    const denoRuntime = await createDenoRuntime({ host: "deno" });
    const bunRuntime = await createRuntime({ host: "bun" });
    const browserRuntime = await createBrowserRuntime({ host: "browser" });

    const nodeResult = await nodeRuntime.run({ host: "node", ...request });
    const denoResult = await denoRuntime.run({ host: "deno", ...request });
    const bunResult = await bunRuntime.run({ host: "bun", ...request });
    const browserResult = await browserRuntime.run({
      host: "browser",
      ...request,
    });

    await nodeRuntime.close();
    await denoRuntime.close();
    await bunRuntime.close();
    await browserRuntime.close();

    const terminations = {
      node: nodeResult.meta.termination,
      deno: denoResult.meta.termination,
      bun: bunResult.meta.termination,
      browser: browserResult.meta.termination,
    };

    expect(new Set(Object.values(terminations)).size).toBe(1);

    writeArtifact("artifacts/e2e/host-parity-contract.json", {
      ok: true,
      invariants: ["INV-FEAT-0025"],
      runs: {
        node: {
          termination: nodeResult.meta.termination,
          status: nodeResult.status,
          exceptionTag: null,
        },
        deno: {
          termination: denoResult.meta.termination,
          status: denoResult.status,
          exceptionTag: null,
        },
        bun: {
          termination: bunResult.meta.termination,
          status: bunResult.status,
          exceptionTag: null,
        },
        browser: {
          termination: browserResult.meta.termination,
          status: browserResult.status,
          exceptionTag: null,
        },
      },
    });
  }, 15_000);
});
