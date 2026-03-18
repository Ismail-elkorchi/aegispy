import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const expectedWasiSource = {
  url: "https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.14.3/python-3.14.3-wasi_sdk-24.zip",
  sourceSha256:
    "39e08d5bb8ac2f445106f58840ff1285db66c6d87f79fb36cc53013249198ed8",
};

const paths = {
  packageJson: path.join(repoRoot, "package.json"),
  pnpmLock: path.join(repoRoot, "pnpm-lock.yaml"),
  cargoLock: path.join(repoRoot, "Cargo.lock"),
  engineManifest: path.join(repoRoot, "artifacts", "engine", "manifest.json"),
  engineProvenance: path.join(
    repoRoot,
    "artifacts",
    "engine",
    "provenance.json",
  ),
  engineSource: path.join(
    repoRoot,
    "artifacts",
    "engine",
    "cpython-wasi-source.json",
  ),
  componentBuild: path.join(repoRoot, "artifacts", "component", "build.json"),
  outGate: path.join(repoRoot, "artifacts", "gates", "supply-chain-check.json"),
  outSbom: path.join(
    repoRoot,
    "artifacts",
    "security",
    "supply-chain-sbom.json",
  ),
  outAttestation: path.join(
    repoRoot,
    "artifacts",
    "security",
    "supply-chain-attestation.json",
  ),
};

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256String(value) {
  return sha256Buffer(Buffer.from(value, "utf8"));
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeEngineManifest(value) {
  if (
    value &&
    value.schemaVersion === 1 &&
    typeof value.artifacts === "object" &&
    value.artifacts !== null &&
    typeof value.bundles === "object" &&
    value.bundles !== null
  ) {
    return value;
  }

  const artifacts = {};
  for (const [name, entry] of Object.entries(value ?? {})) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof entry.sha256 === "string" &&
      typeof entry.bytes === "number"
    ) {
      artifacts[name] = {
        path: `artifacts/engine/${name}`,
        sha256: entry.sha256,
        bytes: entry.bytes,
      };
    }
  }

  return {
    schemaVersion: 1,
    artifacts,
    bundles: {},
  };
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function parseCargoPackages(lockText) {
  const packages = [];
  const re =
    /\[\[package\]\][\s\S]*?name = "([^"]+)"[\s\S]*?version = "([^"]+)"/gu;
  let match = re.exec(lockText);
  while (match) {
    packages.push({
      name: match[1],
      version: match[2],
    });
    match = re.exec(lockText);
  }
  return packages;
}

function parsePnpmPackages(lockText) {
  const marker = "\npackages:\n";
  const markerIndex = lockText.indexOf(marker);
  if (markerIndex < 0) return [];
  const entries = [];
  const tail = lockText.slice(markerIndex + marker.length);
  for (const line of tail.split(/\r?\n/u)) {
    if (!line.startsWith("  ")) continue;
    if (line.startsWith("    ")) continue;
    const trimmed = line.trim();
    if (!trimmed.endsWith(":")) continue;
    let key = trimmed.slice(0, -1).trim();
    if (
      (key.startsWith('"') && key.endsWith('"')) ||
      (key.startsWith("'") && key.endsWith("'"))
    ) {
      key = key.slice(1, -1);
    }
    if (key.length === 0) continue;
    const peerSuffixIndex = key.indexOf("(");
    const withoutPeerSuffix =
      peerSuffixIndex >= 0 ? key.slice(0, peerSuffixIndex) : key;
    const versionSep = withoutPeerSuffix.lastIndexOf("@");
    if (versionSep <= 0) {
      entries.push({
        spec: key,
        name: key,
        version: "",
      });
      continue;
    }
    entries.push({
      spec: key,
      name: withoutPeerSuffix.slice(0, versionSep),
      version: withoutPeerSuffix.slice(versionSep + 1),
    });
  }
  return entries;
}

function sortedUniquePackages(packages) {
  const seen = new Set();
  const out = [];
  for (const entry of packages) {
    const key = `${entry.name}@${entry.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  out.sort((a, b) => {
    if (a.name === b.name) return a.version.localeCompare(b.version);
    return a.name.localeCompare(b.name);
  });
  return out;
}

function fileRef(filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function main() {
  const failures = [];
  const requiredFiles = [
    paths.packageJson,
    paths.pnpmLock,
    paths.cargoLock,
    paths.engineManifest,
    paths.engineProvenance,
    paths.engineSource,
    paths.componentBuild,
  ];

  for (const filePath of requiredFiles) {
    if (!fs.existsSync(filePath)) {
      failures.push({
        error: "missing_supply_chain_input",
        path: fileRef(filePath),
      });
    }
  }

  if (failures.length > 0) {
    const payload = { ok: false, failures };
    ensureDir(paths.outGate);
    fs.writeFileSync(paths.outGate, JSON.stringify(payload, null, 2) + "\n");
    process.exitCode = 1;
    return;
  }

  const packageJson = readJson(paths.packageJson);
  const engineManifest = normalizeEngineManifest(
    readJson(paths.engineManifest),
  );
  const engineProvenance = readJson(paths.engineProvenance);
  const engineSource = readJson(paths.engineSource);
  const componentBuild = readJson(paths.componentBuild);

  if (
    typeof packageJson.packageManager !== "string" ||
    !/^pnpm@\d+\.\d+\.\d+$/u.test(packageJson.packageManager)
  ) {
    failures.push({ error: "invalid_package_manager_pin" });
  }

  const pnpmLockText = fs.readFileSync(paths.pnpmLock, "utf8");
  const cargoLockText = fs.readFileSync(paths.cargoLock, "utf8");
  const pnpmPackages = sortedUniquePackages(parsePnpmPackages(pnpmLockText));
  const cargoPackages = sortedUniquePackages(parseCargoPackages(cargoLockText));
  if (pnpmPackages.length === 0) {
    failures.push({ error: "pnpm_lock_package_set_empty" });
  }
  if (cargoPackages.length === 0) {
    failures.push({ error: "cargo_lock_package_set_empty" });
  }

  const requiredEngineArtifacts = [
    "cpython-wasi.wasm",
    "aegispy-capability-bridge.py",
  ];
  const engineArtifacts = [];
  for (const name of requiredEngineArtifacts) {
    const manifestEntry = engineManifest.artifacts[name];
    const provenanceEntry = engineProvenance[name];
    if (typeof manifestEntry !== "object" || manifestEntry === null) {
      failures.push({ error: "engine_manifest_entry_missing", artifact: name });
      continue;
    }
    if (typeof provenanceEntry !== "object" || provenanceEntry === null) {
      failures.push({
        error: "engine_provenance_entry_missing",
        artifact: name,
      });
      continue;
    }
    const artifactPath = path.join(repoRoot, "artifacts", "engine", name);
    if (!fs.existsSync(artifactPath)) {
      failures.push({ error: "engine_artifact_missing", artifact: name });
      continue;
    }
    const sha = sha256File(artifactPath);
    const bytes = fs.statSync(artifactPath).size;
    if (manifestEntry.sha256 !== sha) {
      failures.push({ error: "engine_manifest_hash_mismatch", artifact: name });
    }
    if (provenanceEntry.sha256 !== sha) {
      failures.push({
        error: "engine_provenance_hash_mismatch",
        artifact: name,
      });
    }
    if (manifestEntry.bytes !== bytes) {
      failures.push({ error: "engine_manifest_size_mismatch", artifact: name });
    }
    engineArtifacts.push({
      name,
      path: fileRef(artifactPath),
      sha256: sha,
      bytes,
      source: provenanceEntry.source,
    });
  }

  if (engineSource.source !== expectedWasiSource.url) {
    failures.push({ error: "wasi_source_url_unpinned" });
  }
  if (engineSource.sourceSha256 !== expectedWasiSource.sourceSha256) {
    failures.push({ error: "wasi_source_archive_hash_unpinned" });
  }
  if (!isSha256(engineSource.wasmSha256)) {
    failures.push({ error: "wasi_source_wasm_hash_invalid" });
  }

  const wasiManifestSha = engineManifest.artifacts["cpython-wasi.wasm"]?.sha256;
  if (
    isSha256(engineSource.wasmSha256) &&
    engineSource.wasmSha256 !== wasiManifestSha
  ) {
    failures.push({ error: "wasi_source_hash_differs_from_manifest" });
  }

  if (componentBuild.ok !== true) {
    failures.push({ error: "component_build_manifest_not_ok" });
  }
  if (
    componentBuild.runtimeBridge !==
    "component-host-guest-runtime-native-abi-dispatch"
  ) {
    failures.push({ error: "component_runtime_bridge_unexpected" });
  }
  if (componentBuild.nativeHostImportDetected !== true) {
    failures.push({ error: "component_native_host_import_not_detected" });
  }
  if (
    componentBuild.adapter?.sha256 !== componentBuild.adapter?.expectedSha256
  ) {
    failures.push({ error: "component_adapter_hash_not_verified" });
  }
  if (
    componentBuild.tooling?.wasmTools?.archiveSha256 !==
    componentBuild.tooling?.wasmTools?.expectedArchiveSha256
  ) {
    failures.push({ error: "component_tooling_hash_not_verified" });
  }
  if (!componentBuild.tooling?.wac) {
    failures.push({ error: "component_wac_tooling_missing" });
  } else if (
    componentBuild.tooling.wac.assetSha256 !==
    componentBuild.tooling.wac.expectedAssetSha256
  ) {
    failures.push({ error: "component_wac_hash_not_verified" });
  }
  if (componentBuild.sourceCoreWasmSha256 !== engineSource.wasmSha256) {
    failures.push({ error: "component_source_core_hash_mismatch" });
  }

  const bundleRecords = Object.values(engineManifest.bundles);
  if (bundleRecords.length === 0) {
    failures.push({ error: "engine_bundle_manifest_empty" });
  }

  const lockDigests = {
    pnpmLock: {
      path: fileRef(paths.pnpmLock),
      sha256: sha256File(paths.pnpmLock),
    },
    cargoLock: {
      path: fileRef(paths.cargoLock),
      sha256: sha256File(paths.cargoLock),
    },
  };

  const generatedAt = new Date().toISOString();
  const sbom = {
    ok: failures.length === 0,
    schema: "aegispy-sbom-v1",
    generatedAt,
    packageManager: packageJson.packageManager,
    lockfiles: lockDigests,
    packages: {
      pnpm: pnpmPackages,
      cargo: cargoPackages,
      counts: {
        pnpm: pnpmPackages.length,
        cargo: cargoPackages.length,
      },
    },
    artifacts: {
      engineManifest: {
        schemaVersion: engineManifest.schemaVersion,
        bundles: bundleRecords,
      },
      engine: engineArtifacts,
      component: {
        path:
          typeof componentBuild.artifact === "string"
            ? componentBuild.artifact
            : "artifacts/component/aegispy.component.wasm",
        sha256: componentBuild.sha256,
        adapter: componentBuild.adapter,
        tooling: componentBuild.tooling,
      },
      sourcePin: {
        url: engineSource.source,
        sourceSha256: engineSource.sourceSha256,
        wasmSha256: engineSource.wasmSha256,
      },
    },
  };
  ensureDir(paths.outSbom);
  fs.writeFileSync(paths.outSbom, JSON.stringify(sbom, null, 2) + "\n");

  const attestationInputs = [
    { path: fileRef(paths.packageJson), sha256: sha256File(paths.packageJson) },
    { path: fileRef(paths.pnpmLock), sha256: lockDigests.pnpmLock.sha256 },
    { path: fileRef(paths.cargoLock), sha256: lockDigests.cargoLock.sha256 },
    {
      path: fileRef(paths.engineManifest),
      sha256: sha256File(paths.engineManifest),
    },
    {
      path: fileRef(paths.engineProvenance),
      sha256: sha256File(paths.engineProvenance),
    },
    {
      path: fileRef(paths.engineSource),
      sha256: sha256File(paths.engineSource),
    },
    {
      path: fileRef(paths.componentBuild),
      sha256: sha256File(paths.componentBuild),
    },
  ];
  const attestationStatement = {
    schema: "aegispy-supply-chain-attestation-v1",
    generatedAt,
    sources: {
      wasiUrl: expectedWasiSource.url,
      wasiSourceSha256: expectedWasiSource.sourceSha256,
    },
    inputs: attestationInputs,
    summary: {
      pnpmPackages: pnpmPackages.length,
      cargoPackages: cargoPackages.length,
      engineArtifacts: engineArtifacts.length,
      componentSha256: componentBuild.sha256,
    },
  };
  const attestation = {
    ok: failures.length === 0,
    ...attestationStatement,
    statementSha256: sha256String(JSON.stringify(attestationStatement)),
  };
  ensureDir(paths.outAttestation);
  fs.writeFileSync(
    paths.outAttestation,
    JSON.stringify(attestation, null, 2) + "\n",
  );

  const payload = {
    ok: failures.length === 0,
    checked: requiredFiles.map((filePath) => fileRef(filePath)),
    outputs: [
      fileRef(paths.outSbom),
      fileRef(paths.outAttestation),
      fileRef(paths.outGate),
    ],
    failures,
  };
  ensureDir(paths.outGate);
  fs.writeFileSync(paths.outGate, JSON.stringify(payload, null, 2) + "\n");
  if (failures.length > 0) process.exitCode = 1;
}

Promise.resolve()
  .then(() => main())
  .catch((error) => {
    ensureDir(paths.outGate);
    fs.writeFileSync(
      paths.outGate,
      JSON.stringify({ ok: false, error: String(error) }, null, 2) + "\n",
    );
    process.exitCode = 1;
  });
