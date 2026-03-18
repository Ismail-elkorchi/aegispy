import type { HostKind, RuntimeCapabilities } from "@aegispy/core";
import type { ServerBundleRecord } from "./server-bundle-manifest";

export function createServerRuntimeCapabilities(
  host: Extract<HostKind, "node" | "deno" | "bun">,
  transport:
    | RuntimeCapabilities["transport"]
    | "process"
    | "simulation"
    | "inprocess",
  bundle: ServerBundleRecord,
): RuntimeCapabilities {
  const hardened = transport === "process";
  return {
    host,
    profile: "server-hardened",
    transport,
    capabilityChannel: hardened ? "component-wit" : "none",
    runtimeFamily: bundle.runtimeFamily,
    bundleId: bundle.bundleId,
    pythonAbi: bundle.pythonAbi,
    packageSetVersion: bundle.packageSetVersion,
    fs: true,
    http: true,
    env: true,
    deterministic: true,
    hardened,
  };
}
