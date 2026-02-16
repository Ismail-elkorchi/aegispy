import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const outPath = path.join(repoRoot, "artifacts", "gates", "entrypoints.json");

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function listPackageDirs() {
  const pkgRoot = path.join(repoRoot, "packages");
  if (!fs.existsSync(pkgRoot)) return [];
  const entries = fs.readdirSync(pkgRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(pkgRoot, e.name));
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function validatePackage(pkgDir) {
  const rel = path.relative(repoRoot, pkgDir).replaceAll("\\", "/");
  const failures = [];

  const pjPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pjPath)) {
    failures.push({ package: rel, error: "missing_package_json" });
    return failures;
  }

  const pj = readJson(pjPath);
  const name = pj.name;
  if (typeof name !== "string" || !name.startsWith("@aegispy/")) {
    failures.push({ package: rel, error: "invalid_package_name", value: name });
  }

  const indexTs = path.join(pkgDir, "src", "index.ts");
  if (!fs.existsSync(indexTs)) {
    failures.push({ package: rel, error: "missing_src_index_ts" });
  }

  const exp = pj.exports;
  if (typeof exp === "undefined") {
    failures.push({ package: rel, error: "missing_exports_field" });
  } else if (typeof exp === "string") {
    failures.push({ package: rel, error: "exports_string_prohibited" });
  } else if (typeof exp === "object" && exp !== null) {
    const keys = Object.keys(exp);
    for (const k of keys) {
      if (k !== ".")
        failures.push({
          package: rel,
          error: "subpath_export_prohibited",
          key: k,
        });
    }
  } else {
    failures.push({ package: rel, error: "invalid_exports_field" });
  }

  return failures;
}

function main() {
  const pkgDirs = listPackageDirs();
  const failures = [];

  for (const pkgDir of pkgDirs) {
    for (const f of validatePackage(pkgDir)) failures.push(f);
  }

  const payload =
    failures.length === 0 ? { ok: true } : { ok: false, failures };
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
