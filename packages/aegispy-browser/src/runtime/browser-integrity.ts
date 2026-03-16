import type { Lockfile } from "../../../aegispy-pack/src/index";

export interface BrowserEngineAssetManifest {
  engine: "pyodide";
  version: string;
  files: Record<string, string>;
}

type BrowserPackageSelection =
  | {
      ok: true;
      packages: string[];
    }
  | {
      ok: false;
      failures: string[];
    };

type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

const textEncoder = new TextEncoder();

export const pyodideEngineAssetManifest: BrowserEngineAssetManifest = {
  engine: "pyodide",
  version: "0.29.3",
  files: {
    "pyodide-lock.json":
      "3256ffc76388de0e37f4b34d42ab484268d1afc675179ff97b2a5bb14f84ccac",
    "pyodide.asm.wasm":
      "e2f4ee75b325e35eb31bfb8c613d4dd5098f5502c156a97847686875b5025480",
    "python_stdlib.zip":
      "4298b6ee445cb724c3973437da47789752b9e6ff4e26619026b283ec801fc46b",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePackages(packages: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of packages) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  if (!(globalThis.crypto && globalThis.crypto.subtle)) {
    return Promise.reject(new Error("crypto.subtle unavailable"));
  }
  const source = typeof value === "string" ? textEncoder.encode(value) : value;
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function verifyBrowserLockfile(lockfile: Lockfile): Promise<{
  ok: boolean;
  failures: string[];
  entriesByName: Map<string, { name: string; version: string }>;
}> {
  const failures: string[] = [];
  const entriesByName = new Map<string, { name: string; version: string }>();

  if (!isRecord(lockfile)) {
    return {
      ok: false,
      failures: ["package_lockfile_invalid"],
      entriesByName,
    };
  }
  if (lockfile.version !== 1) {
    failures.push("lockfile_version_invalid");
  }
  if (typeof lockfile.generatedAt !== "string") {
    failures.push("lockfile_generated_at_invalid");
  }
  if (!Array.isArray(lockfile.entries)) {
    failures.push("lockfile_entries_invalid");
    return {
      ok: false,
      failures,
      entriesByName,
    };
  }

  for (const entry of lockfile.entries) {
    if (!isRecord(entry)) {
      failures.push("lockfile_entry_invalid");
      continue;
    }
    if (
      typeof entry.name !== "string" ||
      typeof entry.version !== "string" ||
      typeof entry.kind !== "string" ||
      typeof entry.artifactUrl !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      failures.push("lockfile_entry_invalid");
      continue;
    }
    if (!isSha256Hex(entry.sha256)) {
      failures.push(
        `lockfile_entry_hash_invalid:${entry.name}@${entry.version}`,
      );
      continue;
    }
    if (!entry.artifactUrl.startsWith("https://")) {
      failures.push(`url_scheme_invalid:${entry.name}@${entry.version}`);
      continue;
    }
    const expectedHash = await sha256Hex(
      `${entry.name}@${entry.version}:${entry.artifactUrl}`,
    );
    if (expectedHash !== entry.sha256) {
      failures.push(`hash_mismatch:${entry.name}@${entry.version}`);
      continue;
    }
    if (entriesByName.has(entry.name)) {
      failures.push(`duplicate_package_name:${entry.name}`);
      continue;
    }
    entriesByName.set(entry.name, {
      name: entry.name,
      version: entry.version,
    });
  }

  return {
    ok: failures.length === 0,
    failures,
    entriesByName,
  };
}

export async function selectBrowserPackages(
  requestedPackages: string[],
  packageLockfile?: Lockfile,
): Promise<BrowserPackageSelection> {
  const packages = normalizePackages(requestedPackages);
  if (packageLockfile === undefined) {
    return packages.length === 0
      ? { ok: true, packages }
      : { ok: false, failures: ["package_lockfile_missing"] };
  }

  const verified = await verifyBrowserLockfile(packageLockfile);
  if (!verified.ok) {
    return {
      ok: false,
      failures: verified.failures,
    };
  }

  const missingPackages = packages.filter(
    (name) => !verified.entriesByName.has(name),
  );
  if (missingPackages.length > 0) {
    return {
      ok: false,
      failures: missingPackages.map((name) => `package_not_pinned:${name}`),
    };
  }

  return {
    ok: true,
    packages,
  };
}

function normalizeAssetBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export async function verifyBrowserEngineAssets(
  assetBaseUrl: string,
  manifest: BrowserEngineAssetManifest = pyodideEngineAssetManifest,
  fetchImpl: FetchLike = (url) => {
    if (typeof globalThis.fetch !== "function") {
      return Promise.reject(new Error("fetch unavailable"));
    }
    return globalThis.fetch(url);
  },
): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = [];
  const baseUrl = normalizeAssetBaseUrl(assetBaseUrl);

  for (const [fileName, expectedHash] of Object.entries(manifest.files)) {
    const response = await fetchImpl(`${baseUrl}/${fileName}`).catch(
      () => null,
    );
    if (response === null) {
      failures.push(`engine_asset_fetch_failed:${fileName}:network_error`);
      continue;
    }
    if (!response.ok) {
      failures.push(`engine_asset_fetch_failed:${fileName}:${response.status}`);
      continue;
    }
    const content = new Uint8Array(await response.arrayBuffer());
    const actualHash = await sha256Hex(content);
    if (actualHash !== expectedHash) {
      failures.push(`engine_asset_hash_mismatch:${fileName}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}
