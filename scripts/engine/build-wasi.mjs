import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { repoRoot, writeEngineArtifact, writeEngineBundle } from "./lib.mjs";

const SOURCE_URL =
  "https://github.com/brettcannon/cpython-wasi-build/releases/download/v3.14.3/python-3.14.3-wasi_sdk-24.zip";
const SOURCE_SHA256 =
  "39e08d5bb8ac2f445106f58840ff1285db66c6d87f79fb36cc53013249198ed8";
const WASM_SHA256 =
  "2bfcfcfb2bb33743e6abe7aab7a7be8e0ab6baaf3d8fcee578357cc67d19aa4d";
const CACHE_DIR = path.join(repoRoot, ".tools", "engine-cache");
const CACHE_ARCHIVE = path.join(CACHE_DIR, "cpython-wasi-3.14.3.zip");
const ENGINE_DIR = path.join(repoRoot, "artifacts", "engine");
const RUNTIME_DIR = path.join(ENGINE_DIR, "wasi-python");
const COMPILED_MODULE = path.join(ENGINE_DIR, "cpython-wasi.cwasm");
const BRIDGE_SOURCE_DIR = path.join(repoRoot, "engine", "python", "aegispy");
const BRIDGE_MODULE_NAME = "__init__.py";
const WASM_REL_PATH = "python.wasm";

const SUPPORTED_BUNDLE_TARGETS = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "windows", arch: "x64" },
  { os: "windows", arch: "arm64" },
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sha256Buffer(input) {
  return createHash("sha256").update(input).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function runOrThrow(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`command failed: ${command} ${args.join(" ")}`);
  }
}

function ensureArchive() {
  ensureDir(CACHE_DIR);

  if (fs.existsSync(CACHE_ARCHIVE)) {
    const existingHash = sha256File(CACHE_ARCHIVE);
    if (existingHash === SOURCE_SHA256) return;
    fs.rmSync(CACHE_ARCHIVE, { force: true });
  }

  const tmpArchive = `${CACHE_ARCHIVE}.tmp`;
  fs.rmSync(tmpArchive, { force: true });
  runOrThrow("curl", ["-L", "-sSf", SOURCE_URL, "-o", tmpArchive]);

  const downloadedHash = sha256File(tmpArchive);
  if (downloadedHash !== SOURCE_SHA256) {
    fs.rmSync(tmpArchive, { force: true });
    throw new Error("wasi-python archive hash mismatch");
  }

  fs.renameSync(tmpArchive, CACHE_ARCHIVE);
}

function extractArchive() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "aegispy-wasi-engine-"),
  );
  runOrThrow("unzip", ["-q", CACHE_ARCHIVE, "-d", tempRoot]);
  return tempRoot;
}

function writeSourceMetadata(payload) {
  const outPath = path.join(ENGINE_DIR, "cpython-wasi-source.json");
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function installBuiltinCapabilityBridge(runtimeDir) {
  const sourceModulePath = path.join(BRIDGE_SOURCE_DIR, BRIDGE_MODULE_NAME);
  if (!fs.existsSync(sourceModulePath)) {
    throw new Error("missing capability bridge source module");
  }

  const libDir = path.join(runtimeDir, "lib");
  if (!fs.existsSync(libDir)) {
    throw new Error("missing runtime lib directory");
  }

  const pythonLibDirs = fs
    .readdirSync(libDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("python"))
    .map((entry) => entry.name)
    .sort();

  if (pythonLibDirs.length === 0) {
    throw new Error("missing runtime python lib directory");
  }

  const installedModulePaths = [];
  for (const pythonLibDir of pythonLibDirs) {
    const targetDir = path.join(libDir, pythonLibDir, "aegispy");
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(BRIDGE_SOURCE_DIR, targetDir, { recursive: true });
    const installedPath = path
      .relative(repoRoot, path.join(targetDir, BRIDGE_MODULE_NAME))
      .replaceAll("\\", "/");
    installedModulePaths.push(installedPath);
  }

  return {
    sourceModulePath,
    installedModulePaths,
  };
}

export function buildWasi() {
  ensureArchive();
  const extractedRoot = extractArchive();
  const wasmPath = path.join(extractedRoot, WASM_REL_PATH);
  const libPath = path.join(extractedRoot, "lib");

  if (!fs.existsSync(wasmPath)) {
    throw new Error(`missing wasm payload in archive: ${WASM_REL_PATH}`);
  }
  if (!fs.existsSync(libPath)) {
    throw new Error("missing stdlib payload in archive: lib/");
  }

  const payload = fs.readFileSync(wasmPath);
  const payloadHash = sha256Buffer(payload);
  if (payloadHash !== WASM_SHA256) {
    throw new Error("wasi python wasm hash mismatch");
  }

  ensureDir(ENGINE_DIR);
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
  fs.cpSync(extractedRoot, RUNTIME_DIR, { recursive: true });
  const bridgeInstall = installBuiltinCapabilityBridge(RUNTIME_DIR);
  fs.rmSync(COMPILED_MODULE, { force: true });

  const result = writeEngineArtifact(
    "cpython-wasi.wasm",
    payload,
    `scripts/engine/build-wasi.mjs:${SOURCE_URL}`,
  );
  const bridgePayload = fs.readFileSync(bridgeInstall.sourceModulePath);
  const bridgeArtifact = writeEngineArtifact(
    "aegispy-capability-bridge.py",
    bridgePayload,
    "engine/python/aegispy/__init__.py",
  );

  writeSourceMetadata({
    source: SOURCE_URL,
    sourceSha256: SOURCE_SHA256,
    wasmSha256: WASM_SHA256,
    builtAt: new Date().toISOString(),
    runtimeDir: "artifacts/engine/wasi-python",
    runtimeLayout: {
      wasm: "python.wasm",
      stdlibRoot: "lib/",
      capabilityBridgeModule: {
        source: "engine/python/aegispy/__init__.py",
        sha256: bridgeArtifact.hash,
        installedModulePaths: bridgeInstall.installedModulePaths,
      },
    },
  });

  for (const target of SUPPORTED_BUNDLE_TARGETS) {
    const bundleId = [
      "server-wasi-component",
      target.os,
      target.arch,
      "cpython-3.14",
      "base",
    ].join("-");
    writeEngineBundle(bundleId, {
      runtimeFamily: "server-wasi-component",
      bundleId,
      os: target.os,
      arch: target.arch,
      pythonAbi: "cpython-3.14",
      packageSetVersion: "base",
      engine: {
        manifestPath: "artifacts/engine/manifest.json",
        modulePath: "artifacts/engine/cpython-wasi.wasm",
        runtimeDir: "artifacts/engine/wasi-python",
        sourceMetadataPath: "artifacts/engine/cpython-wasi-source.json",
        bridgeArtifactPath: "artifacts/engine/aegispy-capability-bridge.py",
      },
      component: {
        buildManifestPath: "artifacts/component/build.json",
        binaryPath: "artifacts/component/aegispy.component.wasm",
        compiledBinaryPath: "artifacts/component/aegispy.component.cwasm",
      },
      packageLayers: [],
    });
  }

  fs.rmSync(extractedRoot, { recursive: true, force: true });
  return result;
}

buildWasi();
