import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { makeAegisPyError } from "../../../aegispy-core/src/errors";
import {
  verifyLockfile,
  type Lockfile,
  type LockfileEntry,
} from "../../../aegispy-pack/src/index";
import {
  normalizeBundleTarget,
  type NormalizedBundleTarget,
} from "./server-bundle-manifest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../");
type SupportedServerPackageClass = "pure_python" | "native_platform";
const materializationPromises = new Map<
  string,
  Promise<ServerPackageLayerSelection>
>();

const attrsImportNames = ["attr", "attrs"];

interface ServerPackageLayerEntry {
  name: string;
  version: string;
  artifactUrl: string;
  artifactFilename: string;
  lockfileSha256: string;
  archiveSha256: string;
  extractedRoot: string;
  importRoot: string;
  importRootSha256: string;
}

interface ServerPackageLayerManifest {
  version: 1;
  packageClass: SupportedServerPackageClass;
  packageSetVersion: string;
  generatedAt: string;
  requestedPackages: string[];
  target?: {
    os: NormalizedBundleTarget["os"];
    arch: NormalizedBundleTarget["arch"];
    pythonAbi: string;
  };
  entries: ServerPackageLayerEntry[];
}

export interface ServerPackageLayerSelection {
  packageRoots: string[];
  packageSetVersion: string;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNativePlatformEntry(entry: LockfileEntry): boolean {
  return entry.kind === "native_platform" || entry.kind === "native_wasm";
}

function packageLayerRoot(packageClass: SupportedServerPackageClass): string {
  return path.join(
    repoRoot,
    "artifacts",
    "engine",
    "package-layers",
    packageClass === "pure_python" ? "pure-python" : "native-platform",
  );
}

function artifactFilename(artifactUrl: string): string {
  const parsed = new URL(artifactUrl);
  return path.basename(parsed.pathname);
}

function normalizeRequestedPackages(packages?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of packages ?? []) {
    const normalized = name.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function packageSetVersion(
  prefix: string,
  requestedPackages: string[],
  entries: LockfileEntry[],
  target?: Pick<NormalizedBundleTarget, "os" | "arch" | "pythonAbi">,
): string {
  const input = JSON.stringify({
    requestedPackages,
    entries: [...entries]
      .map((entry) => ({
        name: entry.name,
        version: entry.version,
        kind: entry.kind,
        artifactUrl: entry.artifactUrl,
        sha256: entry.sha256,
      }))
      .sort((left, right) =>
        `${left.name}@${left.version}`.localeCompare(
          `${right.name}@${right.version}`,
        ),
      ),
    target: target ?? null,
  });
  return `${prefix}-${sha256Hex(input).slice(0, 16)}`;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeArchivePath(entryPath: string): string {
  const normalized = entryPath.replaceAll("\\", "/").replace(/^\.?\//u, "");
  const parts = normalized
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) {
    throw new Error("archive entry path invalid");
  }
  for (const part of parts) {
    if (part === "..") {
      throw new Error("archive entry path escapes extraction root");
    }
  }
  return parts.join("/");
}

function bufferString(value: Uint8Array, start: number, end: number): string {
  return Buffer.from(value.subarray(start, end))
    .toString("utf8")
    .replace(/\0+$/u, "")
    .trim();
}

function parseTarOctal(value: Uint8Array, start: number, end: number): number {
  const raw = bufferString(value, start, end).replace(/\0/g, "").trim();
  if (raw === "") return 0;
  return Number.parseInt(raw, 8);
}

function extractTarGz(content: Uint8Array, destination: string): void {
  const tarBytes = gunzipSync(content);
  let offset = 0;

  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = bufferString(header, 0, 100);
    const prefix = bufferString(header, 345, 500);
    const typeFlag = bufferString(header, 156, 157);
    const size = parseTarOctal(header, 124, 136);
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const safePath = sanitizeArchivePath(entryPath);
    const targetPath = path.join(destination, safePath);
    const payloadStart = offset + 512;
    const payloadEnd = payloadStart + size;

    if (typeFlag === "" || typeFlag === "0") {
      ensureDir(path.dirname(targetPath));
      fs.writeFileSync(targetPath, tarBytes.subarray(payloadStart, payloadEnd));
    } else if (typeFlag === "5") {
      ensureDir(targetPath);
    }

    offset = payloadStart + Math.ceil(size / 512) * 512;
  }
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function findZipEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumSize = 22;
  const maxCommentLength = 0xffff;
  const start = Math.max(0, bytes.length - minimumSize - maxCommentLength);
  for (let offset = bytes.length - minimumSize; offset >= start; offset -= 1) {
    if (readUInt32LE(bytes, offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("zip end of central directory not found");
}

function extractZip(content: Uint8Array, destination: string): void {
  const eocdOffset = findZipEndOfCentralDirectory(content);
  const totalEntries = readUInt16LE(content, eocdOffset + 10);
  let offset = readUInt32LE(content, eocdOffset + 16);

  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32LE(content, offset) !== 0x02014b50) {
      throw new Error("zip central directory entry invalid");
    }

    const compressionMethod = readUInt16LE(content, offset + 10);
    const compressedSize = readUInt32LE(content, offset + 20);
    const fileNameLength = readUInt16LE(content, offset + 28);
    const extraLength = readUInt16LE(content, offset + 30);
    const commentLength = readUInt16LE(content, offset + 32);
    const localHeaderOffset = readUInt32LE(content, offset + 42);
    const entryName = Buffer.from(
      content.subarray(offset + 46, offset + 46 + fileNameLength),
    ).toString("utf8");
    const safePath = sanitizeArchivePath(entryName);
    const targetPath = path.join(destination, safePath);

    if (readUInt32LE(content, localHeaderOffset) !== 0x04034b50) {
      throw new Error("zip local file header invalid");
    }
    const localFileNameLength = readUInt16LE(content, localHeaderOffset + 26);
    const localExtraLength = readUInt16LE(content, localHeaderOffset + 28);
    const dataStart =
      localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    const compressedBytes = content.subarray(dataStart, dataEnd);

    if (entryName.endsWith("/")) {
      ensureDir(targetPath);
    } else {
      ensureDir(path.dirname(targetPath));
      const extractedBytes =
        compressionMethod === 0
          ? compressedBytes
          : compressionMethod === 8
            ? inflateRawSync(compressedBytes)
            : null;
      if (extractedBytes === null) {
        throw new Error(
          `zip compression method unsupported: ${compressionMethod}`,
        );
      }
      fs.writeFileSync(targetPath, extractedBytes);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }
}

function directorySha256(root: string): string {
  const hash = createHash("sha256");
  const stack = [root];
  const files: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  for (const absolute of files) {
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(absolute));
    hash.update("\0");
  }

  return hash.digest("hex");
}

function importNameCandidates(name: string): string[] {
  if (name === "attrs") return attrsImportNames;
  return [name.replaceAll("-", "_")];
}

function packageRootCandidates(extractedRoot: string): string[] {
  const direct = extractedRoot;
  const src = path.join(extractedRoot, "src");
  return fs.existsSync(src) ? [src, direct] : [direct];
}

function resolveExtractedRoot(extractionRoot: string): string {
  const entries = fs.readdirSync(extractionRoot, { withFileTypes: true });
  if (entries.length === 1 && entries[0]?.isDirectory()) {
    return path.join(extractionRoot, entries[0].name);
  }
  return extractionRoot;
}

function resolveImportRoot(
  extractionRoot: string,
  entry: LockfileEntry,
): string {
  const extractedRoot = resolveExtractedRoot(extractionRoot);
  for (const candidateRoot of packageRootCandidates(extractedRoot)) {
    for (const importName of importNameCandidates(entry.name)) {
      const packageDir = path.join(candidateRoot, importName);
      const moduleFile = path.join(candidateRoot, `${importName}.py`);
      if (fs.existsSync(packageDir) || fs.existsSync(moduleFile)) {
        return candidateRoot;
      }
    }
  }
  throw new Error(`unable to resolve import root for ${entry.name}`);
}

function manifestPath(cacheRoot: string): string {
  return path.join(cacheRoot, "manifest.json");
}

function createStageRoot(
  packageClass: SupportedServerPackageClass,
  packageSet: string,
): string {
  const token = `${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 10)}`;
  return path.join(
    packageLayerRoot(packageClass),
    `.stage-${packageSet}-${token}`,
  );
}

function removeDirectory(root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.rm(root, { recursive: true, force: true }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function promoteStageRoot(
  stageRoot: string,
  cacheRoot: string,
): Promise<"promoted" | "exists"> {
  return new Promise((resolve, reject) => {
    fs.rename(stageRoot, cacheRoot, (error) => {
      if (!error) {
        resolve("promoted");
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        resolve("exists");
        return;
      }
      reject(error);
    });
  });
}

function rebaseStagePath(
  stageRoot: string,
  cacheRoot: string,
  targetPath: string,
): string {
  return path.join(cacheRoot, path.relative(stageRoot, targetPath));
}

function currentTarget(): NormalizedBundleTarget {
  return normalizeBundleTarget();
}

function parseWheelTags(entry: LockfileEntry): {
  artifactFilename: string;
  pythonTags: string[];
  abiTags: string[];
  platformTags: string[];
} {
  const filename = artifactFilename(entry.artifactUrl);
  if (!filename.endsWith(".whl")) {
    throw new Error(`wheel filename invalid for ${entry.name}`);
  }
  const baseName = filename.slice(0, -4);
  const parts = baseName.split("-");
  if (parts.length < 5) {
    throw new Error(`wheel filename invalid for ${entry.name}`);
  }
  return {
    artifactFilename: filename,
    pythonTags: parts[parts.length - 3]!.split("."),
    abiTags: parts[parts.length - 2]!.split("."),
    platformTags: parts[parts.length - 1]!.split("."),
  };
}

function matchesPythonAbi(
  pythonTag: string,
  abiTag: string,
  pythonAbi: string,
): boolean {
  if (pythonAbi !== "cpython-3.14") return false;
  return pythonTag === "cp314" && abiTag === "cp314";
}

function matchesPlatformTag(
  platformTag: string,
  target: Pick<NormalizedBundleTarget, "os" | "arch">,
): boolean {
  if (target.os === "linux" && target.arch === "x64") {
    return platformTag.includes("linux") && platformTag.includes("x86_64");
  }
  if (target.os === "linux" && target.arch === "arm64") {
    return platformTag.includes("linux") && platformTag.includes("aarch64");
  }
  if (target.os === "darwin" && target.arch === "x64") {
    return platformTag.startsWith("macosx_") && platformTag.endsWith("_x86_64");
  }
  if (target.os === "darwin" && target.arch === "arm64") {
    return platformTag.startsWith("macosx_") && platformTag.endsWith("_arm64");
  }
  if (target.os === "windows" && target.arch === "x64") {
    return platformTag === "win_amd64";
  }
  if (target.os === "windows" && target.arch === "arm64") {
    return platformTag === "win_arm64";
  }
  return false;
}

function wheelMatchesTarget(
  entry: LockfileEntry,
  target: NormalizedBundleTarget,
): { artifactFilename: string; matches: boolean } {
  const tags = parseWheelTags(entry);
  const pythonCompatible = tags.pythonTags.some((pythonTag) =>
    tags.abiTags.some((abiTag) =>
      matchesPythonAbi(pythonTag, abiTag, target.pythonAbi),
    ),
  );
  const platformCompatible = tags.platformTags.some((platformTag) =>
    matchesPlatformTag(platformTag, target),
  );
  return {
    artifactFilename: tags.artifactFilename,
    matches: pythonCompatible && platformCompatible,
  };
}

function readManifest(cacheRoot: string): ServerPackageLayerManifest | null {
  const manifestFile = manifestPath(cacheRoot);
  if (!fs.existsSync(manifestFile)) return null;
  return JSON.parse(
    fs.readFileSync(manifestFile, "utf8"),
  ) as ServerPackageLayerManifest;
}

function verifyManifest(
  cacheRoot: string,
  packageClass: SupportedServerPackageClass,
  packageSet: string,
  requestedPackages: string[],
  lockfile: Lockfile,
  target?: Pick<NormalizedBundleTarget, "os" | "arch" | "pythonAbi">,
): ServerPackageLayerSelection | null {
  const manifest = readManifest(cacheRoot);
  if (!manifest) return null;
  if (manifest.version !== 1) return null;
  if (manifest.packageClass !== packageClass) return null;
  if (manifest.packageSetVersion !== packageSet) return null;
  if (
    JSON.stringify(manifest.requestedPackages) !==
    JSON.stringify(requestedPackages)
  ) {
    return null;
  }
  if (packageClass === "native_platform") {
    if (
      manifest.target?.os !== target?.os ||
      manifest.target?.arch !== target?.arch ||
      manifest.target?.pythonAbi !== target?.pythonAbi
    ) {
      return null;
    }
  }

  const expectedEntries = [...lockfile.entries]
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`,
      ),
    )
    .map(
      (entry) =>
        `${entry.name}@${entry.version}:${entry.sha256}:${artifactFilename(entry.artifactUrl)}`,
    );
  const actualEntries = [...manifest.entries]
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`,
      ),
    )
    .map(
      (entry) =>
        `${entry.name}@${entry.version}:${entry.lockfileSha256}:${entry.artifactFilename}`,
    );

  if (JSON.stringify(expectedEntries) !== JSON.stringify(actualEntries)) {
    return null;
  }

  const packageRoots = manifest.entries.map((entry) => entry.importRoot);
  if (packageRoots.some((root) => !fs.existsSync(root))) {
    return null;
  }
  if (
    manifest.entries.some((entry) => {
      const cachedArtifactPath = path.join(
        cacheRoot,
        "downloads",
        entry.artifactFilename,
      );
      if (!fs.existsSync(cachedArtifactPath)) {
        return true;
      }
      return (
        sha256Hex(fs.readFileSync(cachedArtifactPath)) !== entry.archiveSha256
      );
    })
  ) {
    return null;
  }
  if (
    manifest.entries.some(
      (entry) => directorySha256(entry.importRoot) !== entry.importRootSha256,
    )
  ) {
    return null;
  }

  return {
    packageRoots,
    packageSetVersion: manifest.packageSetVersion,
  };
}

async function fetchArtifact(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch package artifact: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function assertServerPackageLockfile(
  requestedPackages: string[],
  lockfile?: Lockfile,
): Lockfile {
  if (!lockfile) {
    throw makeAegisPyError("AEG-ENGINE", "server package lockfile missing", {
      reason: "package_lockfile_missing",
      requestedPackages,
    });
  }

  const verified = verifyLockfile(lockfile);
  if (!verified.ok) {
    throw makeAegisPyError("AEG-ENGINE", "server package lockfile invalid", {
      reason: verified.failures[0] ?? "package_lockfile_invalid",
      failures: verified.failures,
    });
  }

  const entriesByName = new Map(
    lockfile.entries.map((entry) => [entry.name, entry]),
  );
  const missingPackages = requestedPackages.filter(
    (name) => !entriesByName.has(name),
  );
  if (missingPackages.length > 0) {
    throw makeAegisPyError("AEG-ENGINE", "server package lockfile incomplete", {
      reason: `package_not_pinned:${missingPackages[0]}`,
      failures: missingPackages.map((name) => `package_not_pinned:${name}`),
    });
  }

  const unsupportedEntries = lockfile.entries.filter(
    (entry) => entry.kind !== "pure_python" && !isNativePlatformEntry(entry),
  );
  if (unsupportedEntries.length > 0) {
    throw makeAegisPyError("AEG-ENGINE", "server package kind unsupported", {
      reason: `package_kind_unsupported:${unsupportedEntries[0]!.name}`,
      failures: unsupportedEntries.map(
        (entry) => `package_kind_unsupported:${entry.name}:${entry.kind}`,
      ),
    });
  }

  const unsupportedPureArtifacts = lockfile.entries.filter(
    (entry) =>
      entry.kind === "pure_python" && !entry.artifactUrl.endsWith(".tar.gz"),
  );
  if (unsupportedPureArtifacts.length > 0) {
    throw makeAegisPyError(
      "AEG-ENGINE",
      "server package artifact unsupported",
      {
        reason: `package_artifact_unsupported:${unsupportedPureArtifacts[0]!.name}`,
        failures: unsupportedPureArtifacts.map(
          (entry) => `package_artifact_unsupported:${entry.name}`,
        ),
      },
    );
  }

  const unsupportedNativeArtifacts = lockfile.entries.filter(
    (entry) =>
      isNativePlatformEntry(entry) && !entry.artifactUrl.endsWith(".whl"),
  );
  if (unsupportedNativeArtifacts.length > 0) {
    throw makeAegisPyError(
      "AEG-ENGINE",
      "server package artifact unsupported",
      {
        reason: `package_artifact_unsupported:${unsupportedNativeArtifacts[0]!.name}`,
        failures: unsupportedNativeArtifacts.map(
          (entry) => `package_artifact_unsupported:${entry.name}`,
        ),
      },
    );
  }

  return lockfile;
}

export async function resolveServerPackageLayer(
  requestedPackagesInput?: string[],
  packageLockfile?: Lockfile,
): Promise<ServerPackageLayerSelection> {
  const requestedPackages = normalizeRequestedPackages(requestedPackagesInput);
  if (requestedPackages.length === 0) {
    return {
      packageRoots: [],
      packageSetVersion: "base",
    };
  }

  const lockfile = assertServerPackageLockfile(
    requestedPackages,
    packageLockfile,
  );
  const entriesByName = new Map(
    lockfile.entries.map((entry) => [entry.name, entry]),
  );
  const pureRequestedPackages = requestedPackages.filter(
    (name) => entriesByName.get(name)?.kind === "pure_python",
  );
  const nativeRequestedPackages = requestedPackages.filter((name) =>
    isNativePlatformEntry(entriesByName.get(name) as LockfileEntry),
  );
  const pureEntries = lockfile.entries.filter(
    (entry) => entry.kind === "pure_python",
  );
  const nativeEntries = lockfile.entries.filter((entry) =>
    isNativePlatformEntry(entry),
  );
  const target = currentTarget();

  const selections: ServerPackageLayerSelection[] = [];

  async function resolvePackageClassLayer(
    packageClass: SupportedServerPackageClass,
    layerRequestedPackages: string[],
    layerEntries: LockfileEntry[],
    layerTarget?: Pick<NormalizedBundleTarget, "os" | "arch" | "pythonAbi">,
  ): Promise<ServerPackageLayerSelection | null> {
    if (layerEntries.length === 0) return null;

    if (packageClass === "native_platform") {
      const unsupportedTargetEntry = layerEntries.find(
        (entry) => !wheelMatchesTarget(entry, target).matches,
      );
      if (unsupportedTargetEntry) {
        throw makeAegisPyError(
          "AEG-ENGINE",
          "server native package target unsupported",
          {
            reason: `package_target_unsupported:${unsupportedTargetEntry.name}`,
            hostTarget: `${target.os}/${target.arch}/${target.pythonAbi}`,
            artifactUrl: unsupportedTargetEntry.artifactUrl,
          },
        );
      }
    }

    const scopedLockfile: Lockfile = {
      ...lockfile,
      entries: layerEntries,
    };
    const packageSet = packageSetVersion(
      packageClass === "pure_python" ? "pure-python" : "native-platform",
      layerRequestedPackages,
      layerEntries,
      layerTarget,
    );
    const cacheRoot = path.join(packageLayerRoot(packageClass), packageSet);
    ensureDir(packageLayerRoot(packageClass));
    const cached = verifyManifest(
      cacheRoot,
      packageClass,
      packageSet,
      layerRequestedPackages,
      scopedLockfile,
      layerTarget,
    );
    if (cached) {
      return cached;
    }
    if (fs.existsSync(cacheRoot)) {
      await removeDirectory(cacheRoot);
    }
    const inFlight = materializationPromises.get(cacheRoot);
    if (inFlight) {
      return inFlight;
    }

    const materialization = (async () => {
      const freshCached = verifyManifest(
        cacheRoot,
        packageClass,
        packageSet,
        layerRequestedPackages,
        scopedLockfile,
        layerTarget,
      );
      if (freshCached) {
        return freshCached;
      }

      const stageRoot = createStageRoot(packageClass, packageSet);
      const downloadsRoot = path.join(stageRoot, "downloads");
      const extractionRoot = path.join(stageRoot, "sources");
      ensureDir(downloadsRoot);
      ensureDir(extractionRoot);

      const manifest: ServerPackageLayerManifest = {
        version: 1,
        packageClass,
        packageSetVersion: packageSet,
        generatedAt: new Date().toISOString(),
        requestedPackages: layerRequestedPackages,
        ...(layerTarget
          ? {
              target: {
                os: layerTarget.os,
                arch: layerTarget.arch,
                pythonAbi: layerTarget.pythonAbi,
              },
            }
          : {}),
        entries: [],
      };

      for (const entry of layerEntries) {
        const archiveBytes = await fetchArtifact(entry.artifactUrl);
        const archiveSha256 = sha256Hex(archiveBytes);
        const fileName = artifactFilename(entry.artifactUrl);
        const downloadPath = path.join(downloadsRoot, fileName);
        fs.writeFileSync(downloadPath, archiveBytes);

        const entryExtractionRoot = path.join(
          extractionRoot,
          `${entry.name}-${entry.version}`,
        );
        fs.rmSync(entryExtractionRoot, { recursive: true, force: true });
        ensureDir(entryExtractionRoot);
        if (packageClass === "pure_python") {
          extractTarGz(archiveBytes, entryExtractionRoot);
        } else {
          extractZip(archiveBytes, entryExtractionRoot);
        }

        const extractedRoot = resolveExtractedRoot(entryExtractionRoot);
        const importRoot = resolveImportRoot(entryExtractionRoot, entry);
        manifest.entries.push({
          name: entry.name,
          version: entry.version,
          artifactUrl: entry.artifactUrl,
          artifactFilename: fileName,
          lockfileSha256: entry.sha256,
          archiveSha256,
          extractedRoot: rebaseStagePath(stageRoot, cacheRoot, extractedRoot),
          importRoot: rebaseStagePath(stageRoot, cacheRoot, importRoot),
          importRootSha256: directorySha256(importRoot),
        });
      }

      fs.writeFileSync(
        manifestPath(stageRoot),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );

      const selection = {
        packageRoots: manifest.entries.map((entry) => entry.importRoot),
        packageSetVersion: manifest.packageSetVersion,
      };

      return promoteStageRoot(stageRoot, cacheRoot).then(
        (status) => {
          if (status === "promoted") {
            return selection;
          }

          return removeDirectory(stageRoot).then(() => {
            const promoted = verifyManifest(
              cacheRoot,
              packageClass,
              packageSet,
              layerRequestedPackages,
              scopedLockfile,
              layerTarget,
            );
            if (promoted) {
              return promoted;
            }
            throw new Error(
              `package layer promotion did not yield a verified cache: ${packageSet}`,
            );
          });
        },
        (error: unknown) =>
          removeDirectory(stageRoot).then(
            () => Promise.reject(error),
            () => Promise.reject(error),
          ),
      );
    })().then(
      (selection) => selection,
      (error: unknown) => {
        materializationPromises.delete(cacheRoot);
        throw error;
      },
    );
    materializationPromises.set(cacheRoot, materialization);
    return materialization;
  }

  const pureSelection = await resolvePackageClassLayer(
    "pure_python",
    pureRequestedPackages,
    pureEntries,
  );
  if (pureSelection) {
    selections.push(pureSelection);
  }
  const nativeSelection = await resolvePackageClassLayer(
    "native_platform",
    nativeRequestedPackages,
    nativeEntries,
    target,
  );
  if (nativeSelection) {
    selections.push(nativeSelection);
  }

  if (selections.length === 1) {
    return selections[0]!;
  }

  return {
    packageRoots: selections.flatMap((selection) => selection.packageRoots),
    packageSetVersion: packageSetVersion(
      "server-package-set",
      requestedPackages,
      lockfile.entries,
      target,
    ),
  };
}
