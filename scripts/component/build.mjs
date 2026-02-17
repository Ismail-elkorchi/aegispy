import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const outDir = path.join(repoRoot, "artifacts", "component");
const wasmPath = path.join(outDir, "aegispy.component.wasm");
const buildPath = path.join(outDir, "build.json");
const interfacePath = path.join(outDir, "interface.wit");
const witPath = path.join(repoRoot, "wit", "aegispy.wit");

const wasiCoreWasmPath =
  process.env.AEGISPY_COMPONENT_SOURCE_WASM ??
  path.join(repoRoot, "artifacts", "engine", "wasi-python", "python.wasm");

const adapterAsset = {
  url: "https://github.com/bytecodealliance/wasmtime/releases/download/v41.0.0/wasi_snapshot_preview1.command.wasm",
  sha256: "d58df294317d43feacad88f2bfa17fcb8bb03ceb6c17467a5cee67de50e7f22d",
  fileName: "wasi_snapshot_preview1.command.wasm",
};

const wasmToolsRelease = {
  version: "1.245.1",
  tag: "v1.245.1",
  linuxX64: {
    fileName: "wasm-tools-1.245.1-x86_64-linux.tar.gz",
    sha256: "b171e20fd107e63e89ef6c936b5581597666a086af677d7818de92b7cdd5a86d",
    unpackDir: "wasm-tools-1.245.1-x86_64-linux",
    binaryRelPath: "wasm-tools",
  },
};

const toolsDir = path.join(repoRoot, ".tools", "component");
const downloadDir = path.join(toolsDir, "downloads");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sha256Buffer(input) {
  return createHash("sha256").update(input).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function runOrThrow(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...opts,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`command failed: ${command} ${args.join(" ")}`);
  }
}

function runCaptureOrThrow(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  if ((result.status ?? 1) !== 0) {
    const message =
      result.stderr?.trim() || result.stdout?.trim() || "unknown error";
    throw new Error(
      `command failed: ${command} ${args.join(" ")} :: ${message}`,
    );
  }
  return result.stdout;
}

function ensureWasiCoreWasm() {
  if (fs.existsSync(wasiCoreWasmPath)) return;
  runOrThrow("node", ["scripts/engine/build-wasi.mjs"]);
  if (!fs.existsSync(wasiCoreWasmPath)) {
    throw new Error(`missing core WASI module: ${wasiCoreWasmPath}`);
  }
}

function ensureAdapter() {
  if (process.env.AEGISPY_COMPONENT_ADAPTER_PATH) {
    const adapterPath = path.resolve(
      process.env.AEGISPY_COMPONENT_ADAPTER_PATH,
    );
    if (!fs.existsSync(adapterPath)) {
      throw new Error(`missing adapter override: ${adapterPath}`);
    }
    return {
      path: adapterPath,
      sha256: sha256File(adapterPath),
      sourceUrl: "env:AEGISPY_COMPONENT_ADAPTER_PATH",
      expectedSha256: null,
    };
  }

  ensureDir(downloadDir);
  const adapterPath = path.join(downloadDir, adapterAsset.fileName);

  if (!fs.existsSync(adapterPath)) {
    runOrThrow("curl", ["-L", "-sSf", adapterAsset.url, "-o", adapterPath]);
  }

  const digest = sha256File(adapterPath);
  if (digest !== adapterAsset.sha256) {
    fs.rmSync(adapterPath, { force: true });
    throw new Error("adapter hash mismatch");
  }

  return {
    path: adapterPath,
    sha256: digest,
    sourceUrl: adapterAsset.url,
    expectedSha256: adapterAsset.sha256,
  };
}

function resolveBundledWasmTools() {
  const platformKey = `${process.platform}:${process.arch}`;
  if (platformKey !== "linux:x64") {
    throw new Error(
      `unsupported platform for bundled wasm-tools (${platformKey}); set AEGISPY_WASM_TOOLS_BIN`,
    );
  }
  return wasmToolsRelease.linuxX64;
}

function ensureWasmTools() {
  if (process.env.AEGISPY_WASM_TOOLS_BIN) {
    const binPath = path.resolve(process.env.AEGISPY_WASM_TOOLS_BIN);
    if (!fs.existsSync(binPath)) {
      throw new Error(`missing wasm-tools override: ${binPath}`);
    }
    return {
      binPath,
      source: "env:AEGISPY_WASM_TOOLS_BIN",
      archiveSha256: null,
      expectedArchiveSha256: null,
      version: runCaptureOrThrow(binPath, ["--version"]).trim(),
    };
  }

  const bundle = resolveBundledWasmTools();
  ensureDir(downloadDir);

  const archivePath = path.join(downloadDir, bundle.fileName);
  const unpackRoot = path.join(toolsDir, bundle.unpackDir);
  const binPath = path.join(unpackRoot, bundle.binaryRelPath);

  if (!fs.existsSync(archivePath)) {
    const assetUrl = `https://github.com/bytecodealliance/wasm-tools/releases/download/${wasmToolsRelease.tag}/${bundle.fileName}`;
    runOrThrow("curl", ["-L", "-sSf", assetUrl, "-o", archivePath]);
  }

  const archiveSha256 = sha256File(archivePath);
  if (archiveSha256 !== bundle.sha256) {
    fs.rmSync(archivePath, { force: true });
    throw new Error("wasm-tools archive hash mismatch");
  }

  if (!fs.existsSync(binPath)) {
    ensureDir(toolsDir);
    runOrThrow("tar", ["-xzf", archivePath, "-C", toolsDir]);
    if (!fs.existsSync(binPath)) {
      throw new Error(`failed to extract wasm-tools binary: ${binPath}`);
    }
  }

  const version = runCaptureOrThrow(binPath, ["--version"]).trim();
  return {
    binPath,
    source: `github:${wasmToolsRelease.tag}/${bundle.fileName}`,
    archiveSha256,
    expectedArchiveSha256: bundle.sha256,
    version,
  };
}

function assertWasmMagic(filePath) {
  const header = fs.readFileSync(filePath).subarray(0, 4);
  const magic = header.toString("hex");
  if (magic !== "0061736d") {
    throw new Error(`invalid wasm magic for ${filePath}`);
  }
}

function parseWorldSummary(witText) {
  const imports = [];
  const exports = [];
  for (const rawLine of witText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("import "))
      imports.push(line.slice("import ".length).replace(/;$/, ""));
    if (line.startsWith("export "))
      exports.push(line.slice("export ".length).replace(/;$/, ""));
  }
  return { imports, exports };
}

function main() {
  ensureDir(outDir);
  ensureWasiCoreWasm();

  const adapter = ensureAdapter();
  const wasmTools = ensureWasmTools();

  const componentArgs = [
    "component",
    "new",
    wasiCoreWasmPath,
    "--adapt",
    `wasi_snapshot_preview1=${adapter.path}`,
    "-o",
    wasmPath,
  ];
  runOrThrow(wasmTools.binPath, componentArgs);
  runOrThrow(wasmTools.binPath, ["validate", wasmPath]);

  assertWasmMagic(wasmPath);

  const witText = runCaptureOrThrow(wasmTools.binPath, [
    "component",
    "wit",
    wasmPath,
  ]);
  fs.writeFileSync(interfacePath, witText, "utf8");

  const witSource = fs.readFileSync(witPath, "utf8");
  const witSha256 = sha256Buffer(witSource);
  const sourceWasmSha256 = sha256File(wasiCoreWasmPath);
  const componentSha256 = sha256File(wasmPath);
  const worldSummary = parseWorldSummary(witText);
  const nativeHostImportPath = "aegispy:runtime/capability";
  const nativeHostImportDetected = worldSummary.imports.some((entry) =>
    entry.startsWith(nativeHostImportPath),
  );

  const manifest = {
    ok: true,
    artifact: "artifacts/component/aegispy.component.wasm",
    sha256: componentSha256,
    bytes: fs.statSync(wasmPath).size,
    sourceCoreWasm: path.relative(repoRoot, wasiCoreWasmPath),
    sourceCoreWasmSha256: sourceWasmSha256,
    sourceWit: "wit/aegispy.wit",
    sourceWitSha256: witSha256,
    interfaceWit: "artifacts/component/interface.wit",
    worldImports: worldSummary.imports,
    worldExports: worldSummary.exports,
    adapter: {
      sourceUrl: adapter.sourceUrl,
      path: path.relative(repoRoot, adapter.path),
      sha256: adapter.sha256,
      expectedSha256: adapter.expectedSha256,
    },
    tooling: {
      wasmTools: {
        source: wasmTools.source,
        version: wasmTools.version,
        archiveSha256: wasmTools.archiveSha256,
        expectedArchiveSha256: wasmTools.expectedArchiveSha256,
      },
    },
    hostImportChannelDefault: "component-wit",
    runtimeBridge: "component-wit-stream",
    requiredHostImportContract: nativeHostImportPath,
    nativeHostImportDetected,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(buildPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

main();
