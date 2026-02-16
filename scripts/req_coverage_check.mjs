import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const outPath = path.join(repoRoot, "artifacts", "gates", "req-coverage.json");

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function walkDir(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function listPackageDirs() {
  const pkgRoot = path.join(repoRoot, "packages");
  if (!fs.existsSync(pkgRoot)) return [];
  const entries = fs.readdirSync(pkgRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(pkgRoot, e.name));
}

function extractExportsFromIndex(indexText) {
  const failures = [];
  const exports = new Set();

  const starRe = /^\s*export\s+\*\s+from\s+/m;
  if (starRe.test(indexText))
    failures.push({ error: "export_star_prohibited" });

  const defaultRe = /^\s*export\s+default\s+/m;
  if (defaultRe.test(indexText))
    failures.push({ error: "export_default_prohibited" });

  const braceRe =
    /^\s*export\s*\{\s*([^}]+)\s*\}\s*from\s*["'][^"']+["']\s*;?\s*$/gm;
  let m = braceRe.exec(indexText);
  while (m) {
    const parts = m[1]
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    for (const p of parts) {
      const name = p
        .split(/\s+as\s+/)[0]
        .replace(/^type\s+/, "")
        .trim();
      if (name.length > 0) exports.add(name);
    }
    m = braceRe.exec(indexText);
  }

  const declRe =
    /^\s*export\s+(?:type\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z0-9_]+)/gm;
  let d = declRe.exec(indexText);
  while (d) {
    exports.add(d[1]);
    d = declRe.exec(indexText);
  }

  return { exports: Array.from(exports).sort(), failures };
}

function listTestFiles(pkgDir) {
  const testDir = path.join(pkgDir, "test");
  if (!fs.existsSync(testDir)) return [];
  return walkDir(testDir).filter(
    (p) =>
      p.endsWith(".test.ts") ||
      p.endsWith(".test.tsx") ||
      p.endsWith(".test.js") ||
      p.endsWith(".test.mjs"),
  );
}

function hasInvariantRef(text) {
  return /INV-[A-Z]{4}-[0-9]{4}/.test(text);
}

function symbolHasCoverage(symbol, testFiles) {
  for (const tf of testFiles) {
    const text = readText(tf);
    if (text.includes(symbol) && hasInvariantRef(text)) return true;
  }
  return false;
}

function main() {
  const pkgDirs = listPackageDirs();
  const failures = [];
  const coverage = [];

  for (const pkgDir of pkgDirs) {
    const indexPath = path.join(pkgDir, "src", "index.ts");
    if (!fs.existsSync(indexPath)) continue;

    const indexText = readText(indexPath);
    const ex = extractExportsFromIndex(indexText);
    for (const f of ex.failures) {
      failures.push({
        package: path.relative(repoRoot, pkgDir).replaceAll("\\", "/"),
        ...f,
      });
    }

    const testFiles = listTestFiles(pkgDir);
    for (const sym of ex.exports) {
      const ok = symbolHasCoverage(sym, testFiles);
      coverage.push({
        package: path.relative(repoRoot, pkgDir).replaceAll("\\", "/"),
        symbol: sym,
        ok,
      });
      if (!ok)
        failures.push({
          package: path.relative(repoRoot, pkgDir).replaceAll("\\", "/"),
          error: "missing_invariant_test_reference",
          symbol: sym,
        });
    }
  }

  const payload =
    failures.length === 0
      ? { ok: true, coverage }
      : { ok: false, failures, coverage };
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
