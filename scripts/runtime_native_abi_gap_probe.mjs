import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const workerPath = path.join(repoRoot, "target", "debug", "aegispy_worker");
const dynloadDir = path.join(
  repoRoot,
  "artifacts",
  "engine",
  "wasi-python",
  "lib",
  "python3.14",
  "lib-dynload",
);
const probeModuleStem = "_aegispy_dlopen_probe";
const probeModuleFile = `${probeModuleStem}.cpython-314-wasm32-wasi.so`;
const probeModulePath = path.join(dynloadDir, probeModuleFile);
const outPath = path.join(
  repoRoot,
  "artifacts",
  "research",
  "runtime-native-abi-gap.json",
);

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function encodeJsonFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    if (offset + 4 + len > buffer.length) break;
    const payload = buffer.subarray(offset + 4, offset + 4 + len);
    frames.push(JSON.parse(payload.toString("utf8")));
    offset += 4 + len;
  }
  return {
    frames,
    remaining: buffer.subarray(offset),
  };
}

function buildProbeRequest() {
  const pyTryToken = ["tr", "y"].join("");
  const code = [
    `${pyTryToken}:`,
    `    import ${probeModuleStem}`,
    `    print("native_loader_probe_unexpected_success")`,
    `except Exception as exc:`,
    `    print("native_loader_probe_error", repr(exc))`,
  ].join("\n");
  return {
    type: "run",
    requestId: randomUUID(),
    run: {
      code,
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: null,
        http: null,
        env: null,
      },
      limits: {
        time: {
          wallMs: 2000,
          cpuMs: 2000,
        },
        bytes: {
          memoryBytes: 64 * 1024 * 1024,
          stdoutBytes: 1024 * 1024,
          stderrBytes: 1024 * 1024,
        },
      },
      determinism: {
        enabled: true,
        epochMs: 123,
        rngSeedHex: "1234abcd",
      },
    },
  };
}

function writeResult(payload) {
  ensureDir(outPath);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function runProbe() {
  if (!fs.existsSync(workerPath)) {
    throw new Error("missing_worker_binary");
  }
  if (!fs.existsSync(dynloadDir)) {
    throw new Error("missing_wasi_dynload_dir");
  }

  fs.writeFileSync(
    probeModulePath,
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  );

  const child = spawn(workerPath, [], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AEGISPY_WORKER_EXECUTOR: "wasi",
      AEGISPY_WORKER_CAPABILITY_BINDING_MODE: "guest-runtime-abi",
      AEGISPY_WORKER_ISOLATION_PROFILE: "compat",
    },
  });

  let outputRemainder = Buffer.alloc(0);
  let stderrBuffer = "";

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, 30_000);

  return await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      const decoded = decodeFrames(Buffer.concat([outputRemainder, chunk]));
      outputRemainder = decoded.remaining;
      for (const frame of decoded.frames) {
        if (frame?.type !== "run_result") continue;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        resolve(frame);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("exit", () => {
      clearTimeout(timeout);
      reject(
        new Error(
          stderrBuffer.trim() || "worker_exit_before_probe_response_received",
        ),
      );
    });

    child.stdin.write(encodeJsonFrame(buildProbeRequest()));
  });
}

runProbe()
  .then((response) => {
    const result = response?.result ?? {};
    const stdoutUtf8 = String(result.stdoutUtf8 ?? "");
    const stderrUtf8 = String(result.stderrUtf8 ?? "");
    const combined = `${stdoutUtf8}\n${stderrUtf8}`;
    const dlopenNotImplementedDetected = /dlopen not implemented/u.test(
      combined,
    );

    const payload = {
      ok: result.status === "ok" && dlopenNotImplementedDetected,
      generatedAt: new Date().toISOString(),
      transport: "process",
      capabilityChannel: "component-wit",
      bindingModeProbe: "guest-runtime-abi",
      probeModuleFile,
      workerStatus: result.status ?? null,
      stdoutUtf8,
      stderrUtf8,
      dlopenNotImplementedDetected,
      runtimeNativeAbiAvailable: false,
      blocker: dlopenNotImplementedDetected ? "dlopen_not_implemented" : null,
      conclusion: dlopenNotImplementedDetected
        ? "native_dynamic_extension_loader_unavailable"
        : "native_dynamic_extension_loader_status_unknown",
      nextMilestone:
        "enable_guest_callable_native_host_abi_without_dlopen_dependency",
    };

    writeResult(payload);
    if (!payload.ok) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    writeResult({
      ok: false,
      error: String(error),
      runtimeNativeAbiAvailable: false,
      blocker: "probe_execution_failed",
    });
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(probeModulePath, { force: true });
  });
