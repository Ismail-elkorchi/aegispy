import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, "..");
const bannedListPath = path.join(
  repoRoot,
  "docs",
  "integrity",
  "banned-tokens.txt",
);
const outPath = path.join(repoRoot, "artifacts", "gates", "banned-tokens.json");
const controlPlaneToken = ".aegispy" + "_pack";

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function readLines(p) {
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((x) => x.length > 0);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTokenRegex(token) {
  const escaped = escapeRegExp(token);
  const hasSpace = token.includes(" ");
  const hasPunct = /[^A-Za-z0-9 _-]/.test(token);
  if (hasSpace || hasPunct) return new RegExp(escaped, "gi");
  return new RegExp(`\\b${escaped}\\b`, "gi");
}

function isBannedListFile(p) {
  return path.basename(p) === "banned-tokens.txt";
}

function isIgnoredFilePath(p) {
  const base = path.basename(p);
  return (
    base === "Cargo.lock" ||
    base === "pnpm-lock.yaml" ||
    base === "package-lock.json"
  );
}

function isIgnoredDirName(name) {
  return (
    name === ".git" ||
    name === "node_modules" ||
    name === "dist" ||
    name === "target" ||
    name === "artifacts" ||
    name === ".tools" ||
    name === controlPlaneToken
  );
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
        if (!isIgnoredDirName(ent.name)) stack.push(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function positionFromIndex(text, index) {
  const slice = text.slice(0, index);
  const lines = slice.split(/\r?\n/);
  const line = lines.length;
  const col = lines[lines.length - 1].length + 1;
  return { line, col };
}

function main() {
  const tokens = readLines(bannedListPath);
  const tokenRes = tokens.map((t) => ({ token: t, re: buildTokenRegex(t) }));

  const allFiles = walkDir(repoRoot);
  const scanFiles = allFiles.filter(
    (p) => !isBannedListFile(p) && !isIgnoredFilePath(p),
  );

  const failures = [];

  for (const filePath of scanFiles) {
    const rel = path.relative(repoRoot, filePath).replaceAll("\\", "/");
    const buf = fs.readFileSync(filePath);
    const text = buf.toString("utf8");

    for (const tr of tokenRes) {
      tr.re.lastIndex = 0;
      let m = tr.re.exec(text);
      while (m) {
        const idx = m.index;
        const pos = positionFromIndex(text, idx);
        failures.push({
          file: rel,
          token: tr.token,
          line: pos.line,
          col: pos.col,
        });
        m = tr.re.exec(text);
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
