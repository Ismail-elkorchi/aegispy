import { writeEngineArtifact } from "./lib.mjs";

export function buildWasi() {
  const payload = Buffer.from("aegispy-wasi-engine-v1", "utf8");
  return writeEngineArtifact(
    "cpython-wasi.wasm",
    payload,
    "scripts/engine/build-wasi.mjs",
  );
}

buildWasi();
