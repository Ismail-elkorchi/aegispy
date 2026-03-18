import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const architectureModelPath = path.join(
  repoRoot,
  "tools",
  "architecture-model.v1.json",
);
const evidenceMatrixPath = path.join(
  repoRoot,
  "tools",
  "evidence-matrix.v1.json",
);
const serverOutPath = path.join(
  repoRoot,
  "artifacts",
  "compat",
  "server-compatibility-matrix.json",
);
const browserOutPath = path.join(
  repoRoot,
  "artifacts",
  "compat",
  "browser-capability-matrix.json",
);

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function requireEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function normalizeServerRow(row, model) {
  return {
    host: requireEnum(row.host, ["node", "deno", "bun"], "server_host"),
    os: requireEnum(row.os, ["linux", "macos", "windows"], "server_os"),
    arch: requireEnum(row.arch, ["x64", "arm64"], "server_arch"),
    runtimeFamily: requireEnum(
      row.runtimeFamily,
      ["server-wasi-component"],
      "server_runtime_family",
    ),
    packageClass: requireEnum(
      row.packageClass,
      model.packageClasses,
      "server_package_class",
    ),
    capabilityFamily: requireEnum(
      row.capabilityFamily,
      model.serverCapabilityFamilies,
      "server_capability_family",
    ),
    isolationFloorVersion: requireEnum(
      row.isolationFloorVersion,
      [String(row.isolationFloorVersion)],
      "server_isolation_floor_version",
    ),
    evidenceStatus: requireEnum(
      row.evidenceStatus,
      model.evidenceStatuses,
      "server_evidence_status",
    ),
  };
}

function normalizeBrowserRow(row, model) {
  return {
    browserEngine: requireEnum(
      row.browserEngine,
      ["pyodide"],
      "browser_engine",
    ),
    browserVersionBand: requireEnum(
      row.browserVersionBand,
      ["0.29.x"],
      "browser_version_band",
    ),
    capabilityFamily: requireEnum(
      row.capabilityFamily,
      model.browserCapabilityFamilies,
      "browser_capability_family",
    ),
    featureState: requireEnum(
      row.featureState,
      model.browserFeatureStates,
      "browser_feature_state",
    ),
    permissionState: requireEnum(
      row.permissionState,
      model.browserPermissionStates,
      "browser_permission_state",
    ),
    packageClass: requireEnum(
      row.packageClass,
      model.packageClasses,
      "browser_package_class",
    ),
    evidenceStatus: requireEnum(
      row.evidenceStatus,
      model.evidenceStatuses,
      "browser_evidence_status",
    ),
  };
}

function sortRows(rows, keys) {
  return [...rows].sort((left, right) =>
    keys
      .map((key) => String(left[key]))
      .join("\u0000")
      .localeCompare(keys.map((key) => String(right[key])).join("\u0000")),
  );
}

export function generateEvidenceMatrices() {
  const model = readJson(architectureModelPath);
  const source = readJson(evidenceMatrixPath);

  const serverRows = sortRows(
    source.server.rows.map((row) => normalizeServerRow(row, model)),
    [
      "host",
      "os",
      "arch",
      "runtimeFamily",
      "packageClass",
      "capabilityFamily",
      "isolationFloorVersion",
      "evidenceStatus",
    ],
  );
  const browserRows = sortRows(
    source.browser.rows.map((row) => normalizeBrowserRow(row, model)),
    [
      "browserEngine",
      "browserVersionBand",
      "capabilityFamily",
      "featureState",
      "permissionState",
      "packageClass",
      "evidenceStatus",
    ],
  );

  const serverDoc = {
    ok: true,
    version: source.version,
    generatedAt: new Date().toISOString(),
    dimensions: model.serverMatrixDimensions,
    rows: serverRows,
    supportedRows: serverRows.filter(
      (row) => row.evidenceStatus === "supported",
    ),
    supportedPurePythonImports: source.server.supportedPurePythonImports,
    supportedNativePlatformClaims:
      source.server.supportedNativePlatformClaims ?? [],
  };
  const browserDoc = {
    ok: true,
    version: source.version,
    generatedAt: new Date().toISOString(),
    dimensions: model.browserMatrixDimensions,
    rows: browserRows,
    supportedRows: browserRows.filter(
      (row) => row.evidenceStatus === "supported",
    ),
    browserExecutedFixtureFamilies:
      source.browser.browserExecutedFixtureFamilies,
  };

  writeJson(serverOutPath, serverDoc);
  writeJson(browserOutPath, browserDoc);

  return { serverDoc, browserDoc };
}

if (process.argv[1] === __filename) {
  Promise.resolve()
    .then(() => generateEvidenceMatrices())
    .catch((error) => {
      writeJson(serverOutPath, { ok: false, error: String(error) });
      writeJson(browserOutPath, { ok: false, error: String(error) });
      process.exitCode = 1;
    });
}
