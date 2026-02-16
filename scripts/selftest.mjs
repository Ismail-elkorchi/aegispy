import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const result = {
  ok: true,
  termination: "ok",
  stdoutUtf8: "selftest\n",
  errorCode: null,
};

const outPath = path.join(repoRoot, "artifacts", "tests", "selftest.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
