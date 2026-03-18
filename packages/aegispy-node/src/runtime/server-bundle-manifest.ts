import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../");
const defaultManifestPath = path.join(
  repoRoot,
  "artifacts",
  "engine",
  "manifest.json",
);

export type BundleTargetOs = "linux" | "darwin" | "windows";

export type BundleTargetArch = "x64" | "arm64";

export interface BundleTargetInput {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  pythonAbi?: string;
  packageSetVersion?: string;
}

export interface NormalizedBundleTarget {
  os: BundleTargetOs;
  arch: BundleTargetArch;
  pythonAbi: string;
  packageSetVersion: string;
}

export interface ServerBundleArtifactRecord {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ServerBundleEngineArtifacts {
  manifestPath: string;
  modulePath: string;
  runtimeDir: string;
  sourceMetadataPath: string;
  bridgeArtifactPath: string;
}

export interface ServerBundleComponentArtifacts {
  buildManifestPath: string;
  binaryPath: string;
  compiledBinaryPath: string;
}

export interface ServerBundleLayerRecord {
  packageClass:
    | "base_interpreter"
    | "pure_python"
    | "native_platform"
    | "project_overlay";
  layerId: string;
  path: string;
}

export interface ServerBundleRecord {
  runtimeFamily: string;
  bundleId: string;
  os: BundleTargetOs;
  arch: BundleTargetArch;
  pythonAbi: string;
  packageSetVersion: string;
  engine: ServerBundleEngineArtifacts;
  component: ServerBundleComponentArtifacts;
  packageLayers: ServerBundleLayerRecord[];
}

export interface ServerBundleManifest {
  schemaVersion: 1;
  artifacts: Record<string, ServerBundleArtifactRecord>;
  bundles: Record<string, ServerBundleRecord>;
}

function mapPlatform(platform: NodeJS.Platform): BundleTargetOs {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "windows";
  throw new Error(`unsupported bundle platform: ${platform}`);
}

function mapArch(arch: NodeJS.Architecture): BundleTargetArch {
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  throw new Error(`unsupported bundle architecture: ${arch}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asBundleRecord(value: unknown): ServerBundleRecord | null {
  if (!isObject(value)) return null;
  if (!isObject(value.engine) || !isObject(value.component)) return null;
  if (
    typeof value.runtimeFamily !== "string" ||
    typeof value.bundleId !== "string" ||
    typeof value.os !== "string" ||
    typeof value.arch !== "string" ||
    typeof value.pythonAbi !== "string" ||
    typeof value.packageSetVersion !== "string" ||
    !Array.isArray(value.packageLayers)
  ) {
    return null;
  }
  return {
    runtimeFamily: value.runtimeFamily,
    bundleId: value.bundleId,
    os: value.os as BundleTargetOs,
    arch: value.arch as BundleTargetArch,
    pythonAbi: value.pythonAbi,
    packageSetVersion: value.packageSetVersion,
    engine: {
      manifestPath: String(value.engine.manifestPath),
      modulePath: String(value.engine.modulePath),
      runtimeDir: String(value.engine.runtimeDir),
      sourceMetadataPath: String(value.engine.sourceMetadataPath),
      bridgeArtifactPath: String(value.engine.bridgeArtifactPath),
    },
    component: {
      buildManifestPath: String(value.component.buildManifestPath),
      binaryPath: String(value.component.binaryPath),
      compiledBinaryPath: String(value.component.compiledBinaryPath),
    },
    packageLayers: value.packageLayers.map((layer) => {
      const record = isObject(layer) ? layer : {};
      return {
        packageClass: String(
          record.packageClass,
        ) as ServerBundleLayerRecord["packageClass"],
        layerId: String(record.layerId),
        path: String(record.path),
      };
    }),
  };
}

function normalizeManifestShape(value: unknown): ServerBundleManifest {
  if (!isObject(value)) {
    throw new Error("invalid engine bundle manifest, expected an object");
  }

  const schemaVersion = value.schemaVersion;
  const artifacts = value.artifacts;
  const bundles = value.bundles;

  if (schemaVersion !== 1 || !isObject(artifacts) || !isObject(bundles)) {
    throw new Error("invalid engine bundle manifest schema");
  }

  const normalizedBundles: Record<string, ServerBundleRecord> = {};
  for (const [bundleId, entry] of Object.entries(bundles)) {
    const bundle = asBundleRecord(entry);
    if (bundle === null) {
      throw new Error(`invalid engine bundle manifest entry: ${bundleId}`);
    }
    normalizedBundles[bundleId] = bundle;
  }

  return {
    schemaVersion: 1,
    artifacts: artifacts as Record<string, ServerBundleArtifactRecord>,
    bundles: normalizedBundles,
  };
}

export function normalizeBundleTarget(
  input: BundleTargetInput = {},
): NormalizedBundleTarget {
  return {
    os: mapPlatform(input.platform ?? process.platform),
    arch: mapArch(input.arch ?? process.arch),
    pythonAbi: input.pythonAbi ?? "cpython-3.14",
    packageSetVersion: input.packageSetVersion ?? "base",
  };
}

export function readServerBundleManifest(
  manifestPath = defaultManifestPath,
): ServerBundleManifest {
  return normalizeManifestShape(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  );
}

export function resolveServerBundle(
  manifest: ServerBundleManifest,
  target: NormalizedBundleTarget,
): ServerBundleRecord {
  for (const bundle of Object.values(manifest.bundles)) {
    if (
      bundle.os === target.os &&
      bundle.arch === target.arch &&
      bundle.pythonAbi === target.pythonAbi &&
      bundle.packageSetVersion === target.packageSetVersion
    ) {
      return bundle;
    }
  }

  throw new Error(
    `missing server bundle for ${target.os}/${target.arch}/${target.pythonAbi}/${target.packageSetVersion}`,
  );
}

export function resolveCurrentServerBundle(
  input: BundleTargetInput = {},
  manifestPath = defaultManifestPath,
): ServerBundleRecord {
  return resolveServerBundle(
    readServerBundleManifest(manifestPath),
    normalizeBundleTarget(input),
  );
}
