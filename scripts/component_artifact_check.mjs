import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const buildPath = path.join(repoRoot, "artifacts", "component", "build.json");
const outPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "component-artifact-check.json",
);

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function checkWasmMagic(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 4) return false;
  return buf.subarray(0, 4).toString("hex") === "0061736d";
}

function main() {
  const failures = [];

  if (!fs.existsSync(buildPath)) {
    failures.push({
      error: "missing_component_build_manifest",
      path: "artifacts/component/build.json",
    });
  }

  if (failures.length > 0) {
    const payload = { ok: false, failures };
    ensureDir(outPath);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    process.exitCode = 1;
    return;
  }

  const doc = JSON.parse(fs.readFileSync(buildPath, "utf8"));

  if (doc.ok !== true) failures.push({ error: "component_manifest_not_ok" });
  if (doc.runtimeBridge !== "component-host-guest-runtime-native-abi-dispatch")
    failures.push({ error: "component_runtime_bridge_unexpected" });
  if (doc.nativeHostImportDetected !== true)
    failures.push({ error: "component_native_host_import_not_detected" });
  if (doc.requiredHostImportContract !== "aegispy:runtime/capability")
    failures.push({ error: "component_required_host_import_contract_unset" });
  if (!Array.isArray(doc.worldImports) || doc.worldImports.length === 0)
    failures.push({ error: "component_world_imports_missing" });
  if (!Array.isArray(doc.worldExports) || doc.worldExports.length === 0)
    failures.push({ error: "component_world_exports_missing" });

  const importSet = new Set(
    Array.isArray(doc.worldImports) ? doc.worldImports : [],
  );
  const exportSet = new Set(
    Array.isArray(doc.worldExports) ? doc.worldExports : [],
  );
  if (!importSet.has("wasi:cli/stdin@0.2.6"))
    failures.push({ error: "component_missing_wasi_cli_stdin_import" });
  if (!exportSet.has("wasi:cli/run@0.2.6"))
    failures.push({ error: "component_missing_wasi_cli_run_export" });

  const artifactRel =
    typeof doc.artifact === "string"
      ? doc.artifact
      : "artifacts/component/aegispy.component.wasm";
  const artifactPath = path.join(repoRoot, artifactRel);
  if (!fs.existsSync(artifactPath)) {
    failures.push({
      error: "missing_component_binary",
      path: artifactRel,
    });
  } else {
    if (!checkWasmMagic(artifactPath))
      failures.push({ error: "component_binary_invalid_magic" });
    if (typeof doc.sha256 === "string") {
      const digest = sha256File(artifactPath);
      if (digest !== doc.sha256)
        failures.push({ error: "component_binary_hash_mismatch" });
    }
  }

  if (typeof doc.interfaceWit !== "string") {
    failures.push({ error: "component_interface_wit_path_missing" });
  } else {
    const interfacePath = path.join(repoRoot, doc.interfaceWit);
    if (!fs.existsSync(interfacePath)) {
      failures.push({
        error: "component_interface_wit_missing",
        path: doc.interfaceWit,
      });
    } else {
      const source = fs.readFileSync(interfacePath, "utf8");
      if (!source.includes("world root")) {
        failures.push({ error: "component_interface_wit_missing_world_root" });
      }
    }
  }

  const payload = {
    ok: failures.length === 0,
    checked: [
      "artifacts/component/build.json",
      "artifacts/component/aegispy.component.wasm",
      "artifacts/component/interface.wit",
    ],
    failures,
  };
  ensureDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  if (failures.length > 0) process.exitCode = 1;
}

Promise.resolve()
  .then(() => main())
  .catch((e) => {
    ensureDir(outPath);
    fs.writeFileSync(
      outPath,
      JSON.stringify({ ok: false, error: String(e) }, null, 2) + "\n",
      "utf8",
    );
    process.exitCode = 1;
  });
