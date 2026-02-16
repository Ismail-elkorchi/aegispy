import fs from "node:fs";
import path from "node:path";
import { verifyEngineArtifacts, repoRoot } from "./lib.mjs";

const result = verifyEngineArtifacts();
const outPath = path.join(
  repoRoot,
  "artifacts",
  "tests",
  "engine-hash-verify.json",
);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

if (!result.ok) {
  process.exitCode = 1;
}
