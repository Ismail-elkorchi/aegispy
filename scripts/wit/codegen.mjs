import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

const witPath = path.join(repoRoot, "wit", "aegispy.wit");
const outPath = path.join(
  repoRoot,
  "packages",
  "aegispy-core",
  "src",
  "wit",
  "bindings.ts",
);
const gatePath = path.join(repoRoot, "artifacts", "gates", "wit-codegen.json");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function buildBindings() {
  return `export interface WITFsRead {
  path: string;
}

export interface WITFsWrite {
  path: string;
  dataUtf8: string;
}

export interface WITHttpGet {
  url: string;
}

export interface WITCapabilityResult {
  ok: boolean;
  payloadUtf8: string;
  errorCode: string;
}

export interface WITHost {
  fs_read(input: WITFsRead): WITCapabilityResult;
  fs_write(input: WITFsWrite): WITCapabilityResult;
  http_get(input: WITHttpGet): WITCapabilityResult;
}
`;
}

function main() {
  const source = fs.readFileSync(witPath, "utf8");
  const generated = buildBindings();

  ensureDir(outPath);
  fs.writeFileSync(outPath, generated, "utf8");

  ensureDir(gatePath);
  fs.writeFileSync(
    gatePath,
    `${JSON.stringify(
      {
        ok: true,
        witPath: "wit/aegispy.wit",
        outPath: "packages/aegispy-core/src/wit/bindings.ts",
        sourceBytes: Buffer.byteLength(source, "utf8"),
        generatedBytes: Buffer.byteLength(generated, "utf8"),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

main();
