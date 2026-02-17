import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "native-host-import-check.json",
);
const witPath = path.join(repoRoot, "wit", "aegispy.wit");
const componentInterfacePath = path.join(
  repoRoot,
  "artifacts",
  "component",
  "interface.wit",
);
const expectedImportPath = "aegispy:runtime/capability";
const expectedContractWorld = "aegispy-runtime";

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() {
  const modeRaw = (
    process.env.AEGISPY_NATIVE_HOST_IMPORT_GATE_MODE ?? "report"
  ).trim();
  const mode = modeRaw.toLowerCase();
  const strict = mode === "strict";
  const failures = [];
  const warnings = [];

  if (mode !== "report" && mode !== "strict") {
    failures.push({
      error: "invalid_gate_mode",
      expected: ["report", "strict"],
      value: modeRaw,
    });
  }

  let contractDeclared = false;
  if (!fs.existsSync(witPath)) {
    failures.push({ error: "missing_wit_contract", path: "wit/aegispy.wit" });
  } else {
    const witSource = fs.readFileSync(witPath, "utf8");
    const worldPattern = new RegExp(
      String.raw`world\s+${expectedContractWorld}\s*\{[\s\S]*?\bimport\s+capability\s*;`,
      "m",
    );
    contractDeclared = worldPattern.test(witSource);
    if (!contractDeclared) {
      failures.push({
        error: "missing_native_host_import_contract_world",
        world: expectedContractWorld,
      });
    }
  }

  let componentInterfacePresent = false;
  let componentImportDetected = false;
  if (fs.existsSync(componentInterfacePath)) {
    componentInterfacePresent = true;
    const source = fs.readFileSync(componentInterfacePath, "utf8");
    componentImportDetected = new RegExp(
      String.raw`import\s+${expectedImportPath}(?:@[0-9A-Za-z._+\-]+)?\s*;`,
      "m",
    ).test(source);
  }

  if (strict) {
    if (!componentInterfacePresent) {
      failures.push({
        error: "missing_component_interface_artifact",
        path: "artifacts/component/interface.wit",
      });
    } else if (!componentImportDetected) {
      failures.push({
        error: "missing_native_host_import_in_component_interface",
        expectedImport: expectedImportPath,
      });
    }
  } else if (!componentInterfacePresent) {
    warnings.push({
      warning: "missing_component_interface_artifact",
      path: "artifacts/component/interface.wit",
    });
  } else if (!componentImportDetected) {
    warnings.push({
      warning: "native_host_import_not_detected_in_component_interface",
      expectedImport: expectedImportPath,
    });
  }

  const payload = {
    ok: failures.length === 0,
    enforcementMode: strict ? "strict" : "report",
    contract: {
      witPath: "wit/aegispy.wit",
      world: expectedContractWorld,
      importPath: expectedImportPath,
      declared: contractDeclared,
    },
    componentInterface: {
      path: "artifacts/component/interface.wit",
      present: componentInterfacePresent,
      nativeImportDetected: componentImportDetected,
    },
    warnings,
    failures,
  };

  ensureDir(outPath);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (failures.length > 0) process.exitCode = 1;
}

Promise.resolve()
  .then(() => main())
  .catch((e) => {
    ensureDir(outPath);
    fs.writeFileSync(
      outPath,
      `${JSON.stringify({ ok: false, error: String(e) }, null, 2)}\n`,
      "utf8",
    );
    process.exitCode = 1;
  });
