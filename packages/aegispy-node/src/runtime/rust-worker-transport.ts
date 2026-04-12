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
import {
  SERVER_ENGINE_PROTOCOL_MAX_FRAME_BYTES,
  SERVER_ENGINE_PROTOCOL_VERSION,
  type WorkerHelloRequest,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerRunRequest,
  type WorkerRunResponse,
  type WorkerShutdownRequest,
} from "../protocol/messages";
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
import {
  resolveCurrentServerBundle,
  type ServerBundleRecord,
} from "./server-bundle-manifest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../");
const defaultWorkerBinary = path.join(
  repoRoot,
  "target",
  "debug",
  "aegispy_worker",
);
const workerBuildInputs = [
  path.join(repoRoot, "Cargo.lock"),
  path.join(repoRoot, "rust", "aegispy-worker", "Cargo.toml"),
  path.join(repoRoot, "rust", "aegispy-worker", "src", "main.rs"),
];

interface PendingRequest {
  expectedType: WorkerResponse["type"];
  resolve: (message: WorkerResponse) => void;
  reject: (error: Error) => void;
}

export interface RustWorkerTransportOptions {
  command: string;
  args: string[];
  host: "node" | "deno" | "bun";
  isolationProfile?: IsolationProfile;
  projectRoots?: string[];
  packageRoots?: string[];
  tempRoot?: string;
}

type RustWorkerTransportOptionsInput = Partial<
  Pick<RustWorkerTransportOptions, "command" | "args" | "host">
> &
  Omit<RustWorkerTransportOptions, "command" | "args" | "host">;

export class RustWorkerTransport implements WorkerTransport {
  private readonly options: RustWorkerTransportOptions;

  public readonly bundle: ServerBundleRecord;

  public readonly isolationProfile: IsolationProfile;

  public readonly executionMode: WorkerExecutionMode;

  public readonly executionBackend: WorkerExecutionBackendInfo;

  private child: ChildProcessWithoutNullStreams | null = null;

  private pending = new Map<string, PendingRequest>();

  private frameRemainder: Uint8Array = new Uint8Array();

  private helloPromise: Promise<void> | null = null;

  public constructor(options: RustWorkerTransportOptionsInput = {}) {
    this.options = {
      command: options.command ?? defaultWorkerBinary,
      args: options.args ?? [],
      host: options.host ?? "node",
      isolationProfile: options.isolationProfile,
      projectRoots: options.projectRoots,
      packageRoots: options.packageRoots,
      tempRoot: options.tempRoot,
    };
    this.bundle = resolveCurrentServerBundle();
    this.isolationProfile =
      this.options.isolationProfile ?? resolveIsolationProfile();
    const launchSpec = resolveWorkerLaunchSpec({
      command: this.options.command,
      args: this.options.args,
      componentBinaryPath: path.join(
        repoRoot,
        this.bundle.component.binaryPath,
      ),
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
    const componentManifestPath = path.join(
      repoRoot,
      this.bundle.component.buildManifestPath,
    );
    const componentBinaryPath = path.join(
      repoRoot,
      this.bundle.component.binaryPath,
    );
    if (existsSync(componentManifestPath) && existsSync(componentBinaryPath))
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
      componentBinaryPath: path.join(
        repoRoot,
        this.bundle.component.binaryPath,
      ),
      repoRoot,
      workerBinaryPath: this.options.command,
      env: {
        ...env,
        AEGISPY_WORKER_WASI_COMPONENT: path.join(
          repoRoot,
          this.bundle.component.binaryPath,
        ),
        AEGISPY_WORKER_WASI_COMPILED_COMPONENT: path.join(
          repoRoot,
          this.bundle.component.compiledBinaryPath,
        ),
        AEGISPY_WORKER_BUNDLE_METADATA_JSON: JSON.stringify({
          runtimeFamily: this.bundle.runtimeFamily,
          bundleId: this.bundle.bundleId,
          os: this.bundle.os,
          arch: this.bundle.arch,
          pythonAbi: this.bundle.pythonAbi,
          packageSetVersion: this.bundle.packageSetVersion,
        }),
        ...(this.options.projectRoots
          ? {
              AEGISPY_WORKER_PROJECT_ROOTS_JSON: JSON.stringify(
                this.options.projectRoots,
              ),
            }
          : {}),
        ...(this.options.packageRoots
          ? {
              AEGISPY_WORKER_PACKAGE_ROOTS_JSON: JSON.stringify(
                this.options.packageRoots,
              ),
              PYTHONDONTWRITEBYTECODE: "1",
            }
          : {}),
        ...(this.options.tempRoot
          ? {
              AEGISPY_WORKER_TEMP_ROOT: this.options.tempRoot,
            }
          : {}),
      },
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
      const decoded = decodeFrames(merged, {
        maxFrameBytes: SERVER_ENGINE_PROTOCOL_MAX_FRAME_BYTES,
      });
      if (decoded.error !== undefined) {
        const failure = new Error(decoded.error);
        for (const pending of this.pending.values()) {
          pending.reject(failure);
        }
        this.pending.clear();
        child.kill("SIGTERM");
        return;
      }
      this.frameRemainder = decoded.remaining;

      for (const frame of decoded.frames) {
        const parsed = decodeJsonFrame(frame) as WorkerResponse;
        const pending = this.pending.get(parsed.requestId);
        if (!pending) continue;
        this.pending.delete(parsed.requestId);
        if (parsed.type === "error") {
          pending.reject(
            new Error(
              `worker protocol error ${parsed.error.code}: ${parsed.error.message}`,
            ),
          );
          continue;
        }
        if (parsed.type !== pending.expectedType) {
          pending.reject(
            new Error(
              `worker protocol response mismatch: expected ${pending.expectedType}, received ${parsed.type}`,
            ),
          );
          continue;
        }
        pending.resolve(parsed);
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
    this.helloPromise = this.sendProtocolMessage(
      {
        protocolVersion: SERVER_ENGINE_PROTOCOL_VERSION,
        type: "hello",
        requestId: randomUUID(),
        client: {
          name: "aegispy-js-adapter",
          host: this.options.host,
        },
        maxFrameBytes: SERVER_ENGINE_PROTOCOL_MAX_FRAME_BYTES,
      } satisfies WorkerHelloRequest,
      "hello_result",
    ).then(() => undefined);
    return child;
  }

  private async sendProtocolMessage<T extends WorkerResponse>(
    message: WorkerRequest,
    expectedType: T["type"],
  ): Promise<T> {
    const child = this.ensureStarted();
    const requestId = message.requestId;
    const promise = new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(requestId, {
        expectedType,
        resolve,
        reject,
      });
    });

    child.stdin.write(encodeJsonFrame(message));
    return (await promise) as T;
  }

  public async run(req: RunRequest): Promise<RunResult> {
    this.ensureStarted();
    await this.helloPromise;
    const requestId = randomUUID();
    const message: WorkerRunRequest = {
      protocolVersion: SERVER_ENGINE_PROTOCOL_VERSION,
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

    const response = await this.sendProtocolMessage<WorkerRunResponse>(
      message,
      "run_result",
    );
    return response.result;
  }

  public async close(): Promise<void> {
    const child = this.child;
    if (child === null) return;
    const message: WorkerShutdownRequest = {
      protocolVersion: SERVER_ENGINE_PROTOCOL_VERSION,
      type: "shutdown",
      requestId: randomUUID(),
    };
    await Promise.race([
      this.sendProtocolMessage(message, "shutdown_result").catch(() => null),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (this.child !== null) {
      child.kill("SIGTERM");
    }
    this.child = null;
    this.pending.clear();
    this.frameRemainder = new Uint8Array();
    this.helloPromise = null;
  }
}
