import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRequest, RunResult } from "@aegispy/core";
import {
  decodeFrames,
  decodeJsonFrame,
  encodeJsonFrame,
} from "../protocol/framing";
import type { WorkerRunRequest, WorkerRunResponse } from "../protocol/messages";
import type { WorkerTransport } from "./worker-transport";
import {
  resolveIsolationProfile,
  toWorkerIsolationEnv,
  type IsolationProfile,
} from "./isolation-profile";
import {
  resolveWorkerLaunchSpec,
  type WorkerExecutionBackendInfo,
  type WorkerExecutionMode,
} from "./worker-execution-mode";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../");
const defaultWorkerBinary = path.join(
  repoRoot,
  "target",
  "debug",
  "aegispy_worker",
);
const defaultComponentManifest = path.join(
  repoRoot,
  "artifacts",
  "component",
  "build.json",
);
const defaultComponentBinary = path.join(
  repoRoot,
  "artifacts",
  "component",
  "aegispy.component.wasm",
);
const workerBuildInputs = [
  path.join(repoRoot, "Cargo.lock"),
  path.join(repoRoot, "rust", "aegispy-worker", "Cargo.toml"),
  path.join(repoRoot, "rust", "aegispy-worker", "src", "main.rs"),
];

interface PendingRequest {
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
}

export interface RustWorkerTransportOptions {
  command: string;
  args: string[];
  isolationProfile?: IsolationProfile;
}

export class RustWorkerTransport implements WorkerTransport {
  private readonly options: RustWorkerTransportOptions;

  public readonly isolationProfile: IsolationProfile;

  public readonly executionMode: WorkerExecutionMode;

  public readonly executionBackend: WorkerExecutionBackendInfo;

  private child: ChildProcessWithoutNullStreams | null = null;

  private pending = new Map<string, PendingRequest>();

  private frameRemainder: Uint8Array = new Uint8Array();

  public constructor(
    options: RustWorkerTransportOptions = {
      command: defaultWorkerBinary,
      args: [],
    },
  ) {
    this.options = options;
    this.isolationProfile =
      options.isolationProfile ?? resolveIsolationProfile();
    const launchSpec = resolveWorkerLaunchSpec({
      command: this.options.command,
      args: this.options.args,
      componentBinaryPath: defaultComponentBinary,
      repoRoot,
      workerBinaryPath: this.options.command,
    });
    this.executionMode = launchSpec.backend.mode;
    this.executionBackend = launchSpec.backend;
  }

  private ensureWorkerBinary(env: NodeJS.ProcessEnv): void {
    if (this.options.command !== defaultWorkerBinary) return;
    const forceRebuild = env.AEGISPY_FORCE_WORKER_REBUILD === "1";
    if (
      !forceRebuild &&
      existsSync(defaultWorkerBinary) &&
      !this.isWorkerBinaryStale()
    )
      return;

    const build = spawnSync("cargo", ["build", "-q", "-p", "aegispy_worker"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    if ((build.status ?? 1) !== 0) {
      const message = build.stderr.trim() || build.stdout.trim();
      throw new Error(`failed to build worker binary: ${message}`);
    }
  }

  private isWorkerBinaryStale(): boolean {
    if (!existsSync(defaultWorkerBinary)) return true;
    const binaryMtimeMs = statSync(defaultWorkerBinary).mtimeMs;
    for (const inputPath of workerBuildInputs) {
      if (!existsSync(inputPath)) return true;
      if (statSync(inputPath).mtimeMs > binaryMtimeMs) {
        return true;
      }
    }
    return false;
  }

  private ensureComponentArtifact(env: NodeJS.ProcessEnv): void {
    if (
      existsSync(defaultComponentManifest) &&
      existsSync(defaultComponentBinary)
    )
      return;

    const build = spawnSync("node", ["scripts/component/build.mjs"], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
    });
    if ((build.status ?? 1) !== 0) {
      const message = build.stderr.trim() || build.stdout.trim();
      throw new Error(`failed to build component artifact: ${message}`);
    }
  }

  private resolveLinkerEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const hasCc = spawnSync("bash", ["-lc", "command -v cc >/dev/null 2>&1"], {
      env: baseEnv,
      cwd: repoRoot,
    }).status;
    if (hasCc === 0) return baseEnv;

    const bootstrap = spawnSync("bash", ["-lc", "bash scripts/setup_zig_cc"], {
      cwd: repoRoot,
      env: baseEnv,
      encoding: "utf8",
    });
    if ((bootstrap.status ?? 1) !== 0) {
      const message = bootstrap.stderr.trim() || bootstrap.stdout.trim();
      throw new Error(`failed to bootstrap linker: ${message}`);
    }

    const ccWrapper =
      bootstrap.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
    if (!ccWrapper) {
      throw new Error("failed to bootstrap linker: wrapper path missing");
    }

    return {
      ...baseEnv,
      CC: ccWrapper,
      CXX: path.join(path.dirname(ccWrapper), "cxx"),
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: ccWrapper,
    };
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child !== null) return this.child;

    const baseEnv = {
      ...process.env,
      ...toWorkerIsolationEnv(this.isolationProfile),
    };
    const env = this.resolveLinkerEnv(baseEnv);
    this.ensureComponentArtifact(env);
    this.ensureWorkerBinary(env);
    const launchSpec = resolveWorkerLaunchSpec({
      command: this.options.command,
      args: this.options.args,
      componentBinaryPath: defaultComponentBinary,
      repoRoot,
      workerBinaryPath: this.options.command,
      env,
    });
    if (!launchSpec.backend.available) {
      throw new Error(
        `microvm execution mode unavailable: ${launchSpec.backend.reason}`,
      );
    }

    const child = spawn(launchSpec.command, launchSpec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: repoRoot,
      env: launchSpec.env,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const merged = Buffer.concat([Buffer.from(this.frameRemainder), chunk]);
      const decoded = decodeFrames(merged);
      this.frameRemainder = decoded.remaining;

      for (const frame of decoded.frames) {
        const parsed = decodeJsonFrame(frame) as WorkerRunResponse;
        const pending = this.pending.get(parsed.requestId);
        if (!pending) continue;
        this.pending.delete(parsed.requestId);
        pending.resolve(parsed.result);
      }
    });

    child.on("error", (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    child.on("exit", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("worker process exited"));
      }
      this.pending.clear();
      this.child = null;
    });

    this.child = child;
    return child;
  }

  public async run(req: RunRequest): Promise<RunResult> {
    const child = this.ensureStarted();
    const requestId = randomUUID();
    const message: WorkerRunRequest = {
      type: "run",
      requestId,
      run: {
        code: req.code,
        argv: req.argv,
        stdinUtf8: req.stdinUtf8,
        permissions: req.permissions,
        limits: req.limits,
        determinism: req.determinism,
      },
    };

    const promise = new Promise<RunResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });

    child.stdin.write(encodeJsonFrame(message));
    return promise;
  }

  public async close(): Promise<void> {
    if (this.child === null) return;
    this.child.kill("SIGTERM");
    this.child = null;
    this.pending.clear();
    this.frameRemainder = new Uint8Array();
  }
}
