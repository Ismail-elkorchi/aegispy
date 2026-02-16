import { writeEngineArtifact } from "./lib.mjs";

export function buildEmscripten() {
  const payload = Buffer.from("aegispy-emscripten-engine-v1", "utf8");
  return writeEngineArtifact(
    "cpython-emscripten.wasm",
    payload,
    "scripts/engine/build-emscripten.mjs",
  );
}

buildEmscripten();
