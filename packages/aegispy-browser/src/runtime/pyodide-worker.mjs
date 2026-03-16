import { loadPyodide } from "pyodide";

let pyodidePromise = null;
let loadedPackages = new Set();
let stdoutLines = [];
let stderrLines = [];

async function resolvePort() {
  if (typeof process !== "undefined" && process.versions?.node) {
    const { parentPort } = await import("node:worker_threads");
    if (parentPort) {
      return {
        onMessage(handler) {
          parentPort.on("message", handler);
        },
        postMessage(payload) {
          parentPort.postMessage(payload);
        },
      };
    }
  }

  return {
    onMessage(handler) {
      globalThis.addEventListener("message", (event) => handler(event.data));
    },
    postMessage(payload) {
      globalThis.postMessage(payload);
    },
  };
}

function currentStdout() {
  return stdoutLines.join("\n") + (stdoutLines.length > 0 ? "\n" : "");
}

function currentStderr() {
  return stderrLines.join("\n") + (stderrLines.length > 0 ? "\n" : "");
}

function pythonPrelude(stdinUtf8, determinism) {
  const lines = [
    "import io",
    "import random",
    "import sys",
    "import time",
    `sys.stdin = io.StringIO(${JSON.stringify(stdinUtf8)})`,
  ];

  if (determinism?.enabled) {
    const epochSeconds = determinism.epochMs / 1000;
    const seedValue = Number.parseInt(determinism.rngSeedHex, 16) || 0;
    lines.push(`_aegispy_random = random.Random(${seedValue})`);
    lines.push(`time.time = lambda: ${epochSeconds}`);
    lines.push("random.random = _aegispy_random.random");
  }

  return lines.join("\n");
}

async function ensurePyodide(request) {
  if (pyodidePromise === null) {
    const options = {};
    if (request.assetBaseUrl) {
      options.indexURL = request.assetBaseUrl;
    }
    pyodidePromise = loadPyodide({
      ...options,
      stdout(line) {
        stdoutLines.push(String(line));
      },
      stderr(line) {
        stderrLines.push(String(line));
      },
    });
  }

  const pyodide = await pyodidePromise;
  const packages = request.packages.filter((name) => !loadedPackages.has(name));
  if (packages.length > 0) {
    await pyodide.loadPackage(packages);
    for (const name of packages) {
      loadedPackages.add(name);
    }
  }
  return pyodide;
}

function resetOutput() {
  stdoutLines = [];
  stderrLines = [];
}

const port = await resolvePort();

port.onMessage((request) => {
  resetOutput();

  ensurePyodide(request)
    .then((pyodide) => {
      return pyodide
        .runPythonAsync(
          `${pythonPrelude(request.stdinUtf8, request.determinism)}\n${request.code}`,
        )
        .then((result) => {
          if (result && typeof result.destroy === "function") {
            result.destroy();
          }
          port.postMessage({
            requestId: request.requestId,
            status: "ok",
            stdoutUtf8: currentStdout(),
            stderrUtf8: currentStderr(),
          });
        });
    })
    .catch((error) => {
      port.postMessage({
        requestId: request.requestId,
        status: "error",
        stdoutUtf8: currentStdout(),
        stderrUtf8: currentStderr() || String(error),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
});
