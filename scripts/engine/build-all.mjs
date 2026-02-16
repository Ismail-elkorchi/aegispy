import { buildWasi } from "./build-wasi.mjs";
import { buildEmscripten } from "./build-emscripten.mjs";

const wasi = buildWasi();
const emscripten = buildEmscripten();

console.log(
  JSON.stringify(
    {
      ok: true,
      artifacts: [
        {
          name: "cpython-wasi.wasm",
          hash: wasi.hash,
        },
        {
          name: "cpython-emscripten.wasm",
          hash: emscripten.hash,
        },
      ],
    },
    null,
    2,
  ),
);
