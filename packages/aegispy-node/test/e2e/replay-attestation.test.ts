import { describe, expect, it } from "vitest";
import { createRuntime as createNodeRuntime } from "../../src/index";
import { createRuntime as createDenoRuntime } from "../../../aegispy-deno/src/index";
import { createRuntime as createBunRuntime } from "../../../aegispy-bun/src/index";
import { createRuntime as createBrowserRuntime } from "../../../aegispy-browser/src/index";
import { computeReplayHash } from "../../../aegispy-core/src/determinism/index";
import type { HostKind, RunRequest } from "@aegispy/core";
import { writeArtifact } from "../helpers/artifact";

const invariants = ["INV-FEAT-0024", "INV-SECU-0010"];
const replayRunBudgetMs = 3_000;

interface ReplayWorkload {
  workloadId: string;
  code: string;
}

const replayWorkloads: ReplayWorkload[] = [
  {
    workloadId: "time-random-basic",
    code: "import random\nimport time\nprint(time.time())\nprint(random.random())",
  },
  {
    workloadId: "json-random-hash",
    code: [
      "import json",
      "import random",
      "import time",
      'print(json.dumps({"rnd": random.random(), "ts": time.time()}, sort_keys=True, separators=(",", ":")))',
    ].join("\n"),
  },
  {
    workloadId: "text-random-sequence",
    code: [
      "import random",
      "import time",
      "print(time.time())",
      'print("-".join(str(int(random.random() * 1000)) for _ in range(3)))',
    ].join("\n"),
  },
];

function makeRequest(
  host: HostKind,
  seedHex: string,
  workload: ReplayWorkload,
): RunRequest {
  return {
    host,
    code: workload.code,
    argv: ["python"],
    stdinUtf8: "",
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    limits: {
      time: {
        wallMs: replayRunBudgetMs,
        cpuMs: replayRunBudgetMs,
      },
      bytes: {
        memoryBytes: 16 * 1024 * 1024,
        stdoutBytes: 8 * 1024,
        stderrBytes: 8 * 1024,
      },
    },
    determinism: {
      enabled: true,
      epochMs: 777,
      rngSeedHex: seedHex,
    },
  };
}

function capabilityChannel(result: {
  meta: { audit: Array<{ detailJson: string; kind: string }> };
}): string | null {
  const marker = result.meta.audit.find(
    (entry) => entry.kind === "runtime_channel",
  );
  if (!marker) return null;
  const prefix = "capability_channel:";
  return marker.detailJson.startsWith(prefix)
    ? marker.detailJson.slice(prefix.length) || null
    : null;
}

const runtimeFactories = {
  node: () => createNodeRuntime({ host: "node" }),
  deno: () => createDenoRuntime({ host: "deno" }),
  bun: () => createBunRuntime({ host: "bun" }),
  browser: () => createBrowserRuntime({ host: "browser" }),
} as const;

describe("replay attestation", () => {
  it("records stable replay hashes across a broader host workload corpus", async () => {
    const hosts = [];

    for (const host of ["node", "deno", "bun", "browser"] as const) {
      const runtime = await runtimeFactories[host]();
      const workloads = [];
      let hostCapabilityChannel: string | null = null;

      for (const workload of replayWorkloads) {
        const first = await runtime.run(
          makeRequest(host, "abcdef01", workload),
        );
        const second = await runtime.run(
          makeRequest(host, "abcdef01", workload),
        );
        const third = await runtime.run(
          makeRequest(host, "1234abcd", workload),
        );

        expect(first.status).toBe("ok");
        expect(second.status).toBe("ok");
        expect(third.status).toBe("ok");

        const firstHash = computeReplayHash(first);
        const secondHash = computeReplayHash(second);
        const thirdHash = computeReplayHash(third);

        if (hostCapabilityChannel === null) {
          hostCapabilityChannel = capabilityChannel(first);
        }

        expect(firstHash).toBe(secondHash);
        expect(firstHash).not.toBe(thirdHash);

        workloads.push({
          workloadId: workload.workloadId,
          cases: [
            {
              caseId: "same-seed",
              hashA: firstHash,
              hashB: secondHash,
              match: firstHash === secondHash,
            },
            {
              caseId: "different-seed",
              hashA: firstHash,
              hashB: thirdHash,
              match: firstHash === thirdHash,
            },
          ],
        });
      }

      await runtime.close();

      hosts.push({
        host,
        capabilityChannel: hostCapabilityChannel,
        workloads,
      });
    }

    writeArtifact("artifacts/security/replay-attestation.json", {
      ok: true,
      invariants,
      hosts,
    });
  }, 600_000);
});
