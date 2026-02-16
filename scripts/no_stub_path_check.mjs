import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const outPath = path.join(repoRoot, "artifacts", "gates", "no-stubs.json");

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

function positionFromIndex(text, index) {
  const slice = text.slice(0, index);
  const lines = slice.split(/\r?\n/);
  const line = lines.length;
  const col = lines[lines.length - 1].length + 1;
  return { line, col };
}

function main() {
  const sourceRoots = [
    path.join(repoRoot, "packages"),
    path.join(repoRoot, "rust"),
    path.join(repoRoot, "scripts"),
  ];

  const sourceFiles = [];
  for (const root of sourceRoots) {
    if (!fs.existsSync(root)) continue;
    for (const full of walkDir(root)) {
      if (full.includes(`${path.sep}test${path.sep}`)) continue;
      sourceFiles.push(full);
    }
  }

  const todoMacroToken = ["t", "o", "d", "o"].join("");
  const patterns = [
    {
      name: "not_implemented_throw",
      re: /throw\s+new\s+Error\((["'`])not implemented\1\)/gi,
    },
    {
      name: "todo_macro",
      re: new RegExp(`\\b${todoMacroToken}!\\s*\\(`, "gi"),
    },
    { name: "unimplemented_macro", re: /\bunimplemented!\s*\(/gi },
  ];

  const failures = [];
  for (const full of sourceFiles) {
    const rel = path.relative(repoRoot, full).replaceAll("\\", "/");
    const text = fs.readFileSync(full, "utf8");
    for (const pat of patterns) {
      pat.re.lastIndex = 0;
      let m = pat.re.exec(text);
      while (m) {
        const pos = positionFromIndex(text, m.index);
        failures.push({
          file: rel,
          marker: pat.name,
          line: pos.line,
          col: pos.col,
        });
        m = pat.re.exec(text);
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
