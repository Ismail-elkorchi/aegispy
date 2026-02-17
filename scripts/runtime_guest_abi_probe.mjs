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
const outPath = path.join(
  repoRoot,
  "artifacts",
  "research",
  "runtime-guest-capability-probe.json",
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
  return {
    type: "run",
    requestId: randomUUID(),
    run: {
      code: [
        "import aegispy",
        "meta = aegispy._bridge_info()",
        "print(aegispy.env_get('AEGISPY_CAP_ENV'))",
        'print(meta.get("dispatch_mode", ""))',
        "print(getattr(aegispy, '__file__', ''))",
      ].join("\n"),
      argv: ["python"],
      stdinUtf8: "",
      permissions: {
        fs: null,
        http: null,
        env: {
          allowKeys: ["AEGISPY_CAP_ENV"],
        },
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

  const child = spawn(workerPath, [], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AEGISPY_WORKER_EXECUTOR: "wasi",
      AEGISPY_WORKER_CAPABILITY_BINDING_MODE: "guest-runtime-abi",
      AEGISPY_WORKER_ISOLATION_PROFILE: "compat",
      AEGISPY_CAP_ENV: "guest-capability-probe",
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
    if (result.status !== "ok") {
      throw new Error(
        result?.error?.message ||
          result?.stderrUtf8 ||
          "probe_runtime_returned_error",
      );
    }

    const outputLines = String(result.stdoutUtf8 ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const guestCapabilityModuleDetected = outputLines.includes(
      "guest-capability-probe",
    );
    const guestCapabilityExecutionDetected = outputLines.includes(
      "guest-capability-probe",
    );
    const dispatchModeDetected = outputLines.includes(
      "host-runtime-call-dispatch",
    );
    const moduleFileLine =
      outputLines.find((line) => line.includes("/aegispy/__init__.py")) ?? "";
    const builtinBridgeRuntimePathDetected =
      moduleFileLine.includes("/runtime/lib/python") &&
      moduleFileLine.endsWith("/aegispy/__init__.py");
    const probeOk =
      guestCapabilityModuleDetected &&
      guestCapabilityExecutionDetected &&
      dispatchModeDetected &&
      builtinBridgeRuntimePathDetected;

    writeResult({
      ok: probeOk,
      generatedAt: new Date().toISOString(),
      transport: "process",
      capabilityChannel: "component-wit",
      bindingModeProbe: "guest-runtime-abi",
      outputLines,
      builtinBridgeModuleFile: moduleFileLine,
      builtinBridgeRuntimePathDetected,
      bridgeDispatchMode: dispatchModeDetected
        ? "host-runtime-call-dispatch"
        : "unknown",
      guestCapabilityModuleDetected,
      guestCapabilityExecutionDetected,
      conclusion: probeOk
        ? "guest_capability_runtime_binding_ok"
        : "guest_capability_runtime_binding_not_ok",
    });
    if (!probeOk) {
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    writeResult({
      ok: false,
      error: String(error),
    });
    process.exitCode = 1;
  });
