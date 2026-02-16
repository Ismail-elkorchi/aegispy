import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const outDir = path.join(repoRoot, "artifacts", "component");
const wasmPath = path.join(outDir, "aegispy.component.wasm");
const buildPath = path.join(outDir, "build.json");

fs.mkdirSync(outDir, { recursive: true });
const payload = Buffer.from("aegispy-component-v1", "utf8");
fs.writeFileSync(wasmPath, payload);

const sha256 = createHash("sha256").update(payload).digest("hex");
const manifest = {
  ok: true,
  artifact: "artifacts/component/aegispy.component.wasm",
  sha256,
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(buildPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify(manifest, null, 2));
