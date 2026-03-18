import { afterEach, describe, expect, it } from "vitest";
import { createRuntime as createBunRuntime } from "../src/index";
import { createRuntime as createDenoRuntime } from "../../aegispy-deno/src/index";
import { createRuntime as createNodeRuntime } from "../../aegispy-node/src/index";
import { resolveCurrentServerBundle } from "../../aegispy-node/src/runtime/server-bundle-manifest";
import type { AegisPyRuntime } from "@aegispy/core";

const runtimes: AegisPyRuntime[] = [];

afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      await runtime.close();
    }),
  );
});

describe("server bundle contract", () => {
  it("reports shared bundle metadata across server hosts", async () => {
    const bundle = resolveCurrentServerBundle();
    const nodeRuntime = await createNodeRuntime({ host: "node" });
    const denoRuntime = await createDenoRuntime({ host: "deno" });
    const bunRuntime = await createBunRuntime({ host: "bun" });
    runtimes.push(nodeRuntime, denoRuntime, bunRuntime);

    const nodeCapabilities = nodeRuntime.capabilities();
    const denoCapabilities = denoRuntime.capabilities();
    const bunCapabilities = bunRuntime.capabilities();

    for (const capabilities of [
      nodeCapabilities,
      denoCapabilities,
      bunCapabilities,
    ]) {
      expect(capabilities.runtimeFamily).toBe("server-wasi-component");
      expect(capabilities.bundleId).toBe(bundle.bundleId);
      expect(capabilities.pythonAbi).toBe(bundle.pythonAbi);
      expect(capabilities.packageSetVersion).toBe(bundle.packageSetVersion);
      expect(capabilities.capabilityChannel).toBe("component-wit");
      expect(capabilities.portableIsolationFloorVersion).toBe(
        "portable-floor-draft-v1",
      );
      expect(Array.isArray(capabilities.hostStrengthening)).toBe(true);
    }

    expect(nodeCapabilities.runtimeFamily).toBe(denoCapabilities.runtimeFamily);
    expect(nodeCapabilities.runtimeFamily).toBe(bunCapabilities.runtimeFamily);
    expect(nodeCapabilities.bundleId).toBe(denoCapabilities.bundleId);
    expect(nodeCapabilities.bundleId).toBe(bunCapabilities.bundleId);
    expect(nodeCapabilities.pythonAbi).toBe(denoCapabilities.pythonAbi);
    expect(nodeCapabilities.pythonAbi).toBe(bunCapabilities.pythonAbi);
    expect(nodeCapabilities.packageSetVersion).toBe(
      denoCapabilities.packageSetVersion,
    );
    expect(nodeCapabilities.packageSetVersion).toBe(
      bunCapabilities.packageSetVersion,
    );
    expect(nodeCapabilities.portableIsolationFloorVersion).toBe(
      denoCapabilities.portableIsolationFloorVersion,
    );
    expect(nodeCapabilities.portableIsolationFloorVersion).toBe(
      bunCapabilities.portableIsolationFloorVersion,
    );
    expect(nodeCapabilities.hostStrengthening).toEqual(
      denoCapabilities.hostStrengthening,
    );
    expect(nodeCapabilities.hostStrengthening).toEqual(
      bunCapabilities.hostStrengthening,
    );
  });
});
