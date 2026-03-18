import { loadPyodide } from "pyodide";

let pyodidePromise = null;
let loadedPackages = new Set();
let stdoutLines = [];
let stderrLines = [];

function networkBridgePrelude(network) {
  if (!network) {
    return "";
  }

  const allowOrigins = JSON.stringify(network.allowOrigins);
  const denyOrigins = JSON.stringify(network.denyOrigins ?? []);

  return [
    "import asyncio",
    "import sys",
    "import types",
    "from urllib.parse import urlsplit",
    "from pyodide.http import pyfetch",
    `_aegispy_allow_origins = ${allowOrigins}`,
    `_aegispy_deny_origins = ${denyOrigins}`,
    `_aegispy_max_requests = ${network.maxRequests}`,
    `_aegispy_max_bytes = ${network.maxBytes}`,
    "class _AegisPyNetworkBridge:",
    "    def __init__(self):",
    "        self._requests_used = 0",
    "        self._bytes_used = 0",
    "    def _policy_denied(self, reason):",
    "        raise RuntimeError(f'AEG-POLICY-DENIED:{reason}')",
    "    def _engine_error(self, reason):",
    "        raise RuntimeError(f'AEG-ENGINE:{reason}')",
    "    def _origin(self, url):",
    "        parsed = urlsplit(url)",
    "        if not parsed.scheme or not parsed.netloc:",
    "            self._policy_denied('http_invalid_url')",
    "        return f'{parsed.scheme}://{parsed.netloc}'.lower()",
    "    def _check_origin(self, url):",
    "        origin = self._origin(url)",
    "        if origin in _aegispy_deny_origins:",
    "            self._policy_denied('http_origin_denied')",
    "        if len(_aegispy_allow_origins) > 0 and origin not in _aegispy_allow_origins:",
    "            self._policy_denied('http_origin_denied')",
    "        return origin",
    "    def http_get(self, url):",
    "        self._check_origin(url)",
    "        if _aegispy_max_requests > 0 and self._requests_used >= _aegispy_max_requests:",
    "            self._policy_denied('http_max_requests_exceeded')",
    "        async def _fetch_text():",
    "            response = await pyfetch(url)",
    "            if not response.ok:",
    "                raise RuntimeError(f'AEG-ENGINE:http_status_{response.status}')",
    "            return await response.text()",
    "        payload = asyncio.get_event_loop().run_until_complete(_fetch_text())",
    "        payload_bytes = len(payload.encode('utf-8'))",
    "        if _aegispy_max_bytes > 0 and self._bytes_used + payload_bytes > _aegispy_max_bytes:",
    "            self._policy_denied('http_byte_budget_reached')",
    "        self._requests_used += 1",
    "        self._bytes_used += payload_bytes",
    "        return payload",
    "__aegispy_module = types.ModuleType('aegispy')",
    "__aegispy_network_bridge = _AegisPyNetworkBridge()",
    "__aegispy_module.http_get = __aegispy_network_bridge.http_get",
    "sys.modules['aegispy'] = __aegispy_module",
    "aegispy = __aegispy_module",
  ].join("\n");
}

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

function pythonPrelude(stdinUtf8, determinism, network) {
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

  return [lines.join("\n"), networkBridgePrelude(network)]
    .filter((chunk) => chunk.length > 0)
    .join("\n");
}

function classifyTaggedError(stderrUtf8, error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const combined = `${stderrUtf8}\n${errorMessage}`;
  const policyMatch = combined.match(/AEG-POLICY-DENIED:([^\n\r]+)/u);
  if (policyMatch) {
    return {
      errorCode: "AEG-POLICY-DENIED",
      errorMessage: policyMatch[1],
      termination: "policy_denied",
    };
  }

  const engineMatch = combined.match(/AEG-ENGINE:([^\n\r]+)/u);
  if (engineMatch) {
    return {
      errorCode: "AEG-ENGINE",
      errorMessage: engineMatch[1],
      termination: "engine_error",
    };
  }

  return {
    errorCode: "AEG-ENGINE",
    errorMessage,
    termination: "engine_error",
  };
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
          `${pythonPrelude(request.stdinUtf8, request.determinism, request.network)}\n${request.code}`,
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
      const classified = classifyTaggedError(currentStderr(), error);
      port.postMessage({
        requestId: request.requestId,
        status: "error",
        stdoutUtf8: currentStdout(),
        stderrUtf8: currentStderr() || String(error),
        errorMessage: classified.errorMessage,
        errorCode: classified.errorCode,
        termination: classified.termination,
      });
    });
});
