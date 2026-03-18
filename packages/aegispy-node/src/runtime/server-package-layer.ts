import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { makeAegisPyError } from "../../../aegispy-core/src/errors";
import {
  verifyLockfile,
  type Lockfile,
  type LockfileEntry,
} from "../../../aegispy-pack/src/index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../");
const packageLayerRoot = path.join(
  repoRoot,
  "artifacts",
  "engine",
  "package-layers",
  "pure-python",
);
const materializationPromises = new Map<
  string,
  Promise<ServerPackageLayerSelection>
>();

const attrsImportNames = ["attr", "attrs"];

interface ServerPackageLayerEntry {
  name: string;
  version: string;
  artifactUrl: string;
  lockfileSha256: string;
  archiveSha256: string;
  extractedRoot: string;
  importRoot: string;
  importRootSha256: string;
}

interface ServerPackageLayerManifest {
  version: 1;
  packageClass: "pure_python";
  packageSetVersion: string;
  generatedAt: string;
  requestedPackages: string[];
  entries: ServerPackageLayerEntry[];
}

export interface ServerPackageLayerSelection {
  packageRoots: string[];
  packageSetVersion: string;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
  requestedPackages: string[],
  lockfile: Lockfile,
): string {
  const input = JSON.stringify({
    requestedPackages,
    entries: [...lockfile.entries]
      .map((entry) => ({
        name: entry.name,
        version: entry.version,
        artifactUrl: entry.artifactUrl,
        sha256: entry.sha256,
      }))
      .sort((left, right) =>
        `${left.name}@${left.version}`.localeCompare(
          `${right.name}@${right.version}`,
        ),
      ),
  });
  return `pure-python-${sha256Hex(input).slice(0, 16)}`;
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

function createStageRoot(packageSet: string): string {
  const token = `${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 10)}`;
  return path.join(packageLayerRoot, `.stage-${packageSet}-${token}`);
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

function readManifest(cacheRoot: string): ServerPackageLayerManifest | null {
  const manifestFile = manifestPath(cacheRoot);
  if (!fs.existsSync(manifestFile)) return null;
  return JSON.parse(
    fs.readFileSync(manifestFile, "utf8"),
  ) as ServerPackageLayerManifest;
}

function verifyManifest(
  cacheRoot: string,
  packageSet: string,
  requestedPackages: string[],
  lockfile: Lockfile,
): ServerPackageLayerSelection | null {
  const manifest = readManifest(cacheRoot);
  if (!manifest) return null;
  if (manifest.version !== 1) return null;
  if (manifest.packageClass !== "pure_python") return null;
  if (manifest.packageSetVersion !== packageSet) return null;
  if (
    JSON.stringify(manifest.requestedPackages) !==
    JSON.stringify(requestedPackages)
  ) {
    return null;
  }

  const expectedEntries = [...lockfile.entries]
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`,
      ),
    )
    .map((entry) => `${entry.name}@${entry.version}:${entry.sha256}`);
  const actualEntries = [...manifest.entries]
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`,
      ),
    )
    .map((entry) => `${entry.name}@${entry.version}:${entry.lockfileSha256}`);

  if (JSON.stringify(expectedEntries) !== JSON.stringify(actualEntries)) {
    return null;
  }

  const packageRoots = manifest.entries.map((entry) => entry.importRoot);
  if (packageRoots.some((root) => !fs.existsSync(root))) {
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

function assertPurePythonLockfile(
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

  const nonPureEntries = lockfile.entries.filter(
    (entry) => entry.kind !== "pure_python",
  );
  if (nonPureEntries.length > 0) {
    throw makeAegisPyError("AEG-ENGINE", "server package kind unsupported", {
      reason: `package_kind_unsupported:${nonPureEntries[0]!.name}`,
      failures: nonPureEntries.map(
        (entry) => `package_kind_unsupported:${entry.name}:${entry.kind}`,
      ),
    });
  }

  const unsupportedArtifacts = lockfile.entries.filter(
    (entry) => !entry.artifactUrl.endsWith(".tar.gz"),
  );
  if (unsupportedArtifacts.length > 0) {
    throw makeAegisPyError(
      "AEG-ENGINE",
      "server package artifact unsupported",
      {
        reason: `package_artifact_unsupported:${unsupportedArtifacts[0]!.name}`,
        failures: unsupportedArtifacts.map(
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

  const lockfile = assertPurePythonLockfile(requestedPackages, packageLockfile);
  const packageSet = packageSetVersion(requestedPackages, lockfile);
  const cacheRoot = path.join(packageLayerRoot, packageSet);
  ensureDir(packageLayerRoot);
  const cached = verifyManifest(
    cacheRoot,
    packageSet,
    requestedPackages,
    lockfile,
  );
  if (cached) {
    return cached;
  }
  if (fs.existsSync(cacheRoot)) {
    await removeDirectory(cacheRoot);
  }
  const inFlight = materializationPromises.get(packageSet);
  if (inFlight) {
    return inFlight;
  }

  const materialization = (async () => {
    const freshCached = verifyManifest(
      cacheRoot,
      packageSet,
      requestedPackages,
      lockfile,
    );
    if (freshCached) {
      return freshCached;
    }

    const stageRoot = createStageRoot(packageSet);
    const downloadsRoot = path.join(stageRoot, "downloads");
    const extractionRoot = path.join(stageRoot, "sources");
    ensureDir(downloadsRoot);
    ensureDir(extractionRoot);

    const manifest: ServerPackageLayerManifest = {
      version: 1,
      packageClass: "pure_python",
      packageSetVersion: packageSet,
      generatedAt: new Date().toISOString(),
      requestedPackages,
      entries: [],
    };

    for (const entry of lockfile.entries) {
      const archiveBytes = await fetchArtifact(entry.artifactUrl);
      const archiveSha256 = sha256Hex(archiveBytes);
      const downloadPath = path.join(
        downloadsRoot,
        `${entry.name}-${entry.version}.tar.gz`,
      );
      fs.writeFileSync(downloadPath, archiveBytes);

      const entryExtractionRoot = path.join(
        extractionRoot,
        `${entry.name}-${entry.version}`,
      );
      fs.rmSync(entryExtractionRoot, { recursive: true, force: true });
      ensureDir(entryExtractionRoot);
      extractTarGz(archiveBytes, entryExtractionRoot);

      const extractedRoot = resolveExtractedRoot(entryExtractionRoot);
      const importRoot = resolveImportRoot(entryExtractionRoot, entry);
      manifest.entries.push({
        name: entry.name,
        version: entry.version,
        artifactUrl: entry.artifactUrl,
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
            packageSet,
            requestedPackages,
            lockfile,
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
      materializationPromises.delete(packageSet);
      throw error;
    },
  );
  materializationPromises.set(packageSet, materialization);
  return materialization;
}
