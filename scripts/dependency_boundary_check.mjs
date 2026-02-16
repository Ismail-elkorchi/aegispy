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
  "dependency-boundaries.json",
);

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function readPackage(pkgName) {
  const full = path.join(repoRoot, "packages", pkgName, "package.json");
  return readJson(full);
}

function allDeps(pkg) {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
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

function main() {
  const failures = [];
  const core = readPackage("aegispy-core");
  const coreDeps = allDeps(core);
  const forbiddenInCore = [
    "@aegispy/node",
    "@aegispy/deno",
    "@aegispy/bun",
    "@aegispy/browser",
    "@aegispy/pack",
  ];

  for (const dep of forbiddenInCore) {
    if (Object.prototype.hasOwnProperty.call(coreDeps, dep)) {
      failures.push({ error: "core_forbidden_dependency", dependency: dep });
    }
  }

  const hostPkgs = [
    "aegispy-node",
    "aegispy-deno",
    "aegispy-bun",
    "aegispy-browser",
  ];
  for (const host of hostPkgs) {
    const pkg = readPackage(host);
    const deps = allDeps(pkg);
    if (!Object.prototype.hasOwnProperty.call(deps, "@aegispy/core")) {
      failures.push({ error: "host_missing_core_dependency", package: host });
    }
  }

  const rustRoot = path.join(repoRoot, "rust");
  if (fs.existsSync(rustRoot)) {
    const rustFiles = walkDir(rustRoot).filter(
      (p) => p.endsWith(".toml") || p.endsWith(".rs"),
    );
    for (const full of rustFiles) {
      const rel = path.relative(repoRoot, full).replaceAll("\\", "/");
      const text = fs.readFileSync(full, "utf8");
      if (text.includes("@aegispy/") || text.includes("packages/aegispy-")) {
        failures.push({
          error: "rust_forbidden_ts_dependency_reference",
          file: rel,
        });
      }
    }
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
