import fs from "node:fs/promises";
import path from "node:path";

const rootPackagePath = "package.json";
const workspacePackagesDir = "packages";
const workerCargoPath = "rust/aegispy-worker/Cargo.toml";

export async function loadReleaseVersion() {
  const rootPackage = JSON.parse(await fs.readFile(rootPackagePath, "utf8"));
  const rootVersion = readPackageVersion(rootPackage, rootPackagePath);
  const sources = [{ path: rootPackagePath, version: rootVersion }];

  const workspaceEntries = await fs.readdir(workspacePackagesDir, {
    withFileTypes: true,
  });
  for (const entry of workspaceEntries) {
    if (!entry.isDirectory()) continue;
    const packagePath = path.join(
      workspacePackagesDir,
      entry.name,
      "package.json",
    );
    const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
    sources.push({
      path: packagePath,
      version: readPackageVersion(packageJson, packagePath),
    });
  }

  const cargoToml = await fs.readFile(workerCargoPath, "utf8");
  sources.push({
    path: workerCargoPath,
    version: readCargoVersion(cargoToml, workerCargoPath),
  });

  const mismatches = sources.filter((entry) => entry.version !== rootVersion);
  if (mismatches.length > 0) {
    const detail = mismatches
      .map((entry) => `${entry.path}=${entry.version}`)
      .join(", ");
    throw new Error(
      `release-version: version mismatch (root=${rootVersion}; ${detail})`,
    );
  }

  return {
    version: rootVersion,
    sources,
  };
}

function readPackageVersion(packageJson, filePath) {
  const version = packageJson.version;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(`release-version: missing version in ${filePath}`);
  }
  return version.trim();
}

function readCargoVersion(source, filePath) {
  const match = source.match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) {
    throw new Error(`release-version: missing Cargo version in ${filePath}`);
  }
  return match[1];
}
