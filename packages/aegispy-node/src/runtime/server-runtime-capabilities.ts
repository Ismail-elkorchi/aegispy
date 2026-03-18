import type { HostKind, RuntimeCapabilities } from "@aegispy/core";
import type { ServerBundleRecord } from "./server-bundle-manifest";

const PORTABLE_ISOLATION_FLOOR_VERSION = "portable-floor-draft-v1";

function hostStrengtheningFor(
  transport: RuntimeCapabilities["transport"],
): string[] | undefined {
  if (transport !== "process") return undefined;
  if (process.platform === "linux") {
    return ["linux-kernel-controls"];
  }
  return [];
}

export function createServerRuntimeCapabilities(
  host: Extract<HostKind, "node" | "deno" | "bun">,
  transport:
    | RuntimeCapabilities["transport"]
    | "process"
    | "simulation"
    | "inprocess",
  bundle: ServerBundleRecord,
  packageSetVersion: string = bundle.packageSetVersion,
): RuntimeCapabilities {
  const hardened = transport === "process";
  const portableIsolationFloorVersion = hardened
    ? PORTABLE_ISOLATION_FLOOR_VERSION
    : undefined;
  return {
    host,
    profile: "server-hardened",
    transport,
    capabilityChannel: hardened ? "component-wit" : "none",
    runtimeFamily: bundle.runtimeFamily,
    bundleId: bundle.bundleId,
    pythonAbi: bundle.pythonAbi,
    packageSetVersion,
    portableIsolationFloorVersion,
    hostStrengthening: hostStrengtheningFor(transport),
    fs: true,
    http: true,
    env: true,
    deterministic: true,
    hardened,
  };
}
