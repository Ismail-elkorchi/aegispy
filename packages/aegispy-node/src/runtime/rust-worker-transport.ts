import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { RunRequest, RunResult } from "@aegispy/core";
import {
  decodeFrames,
  decodeJsonFrame,
  encodeJsonFrame,
} from "../protocol/framing";
import type { WorkerRunRequest, WorkerRunResponse } from "../protocol/messages";
import type { WorkerTransport } from "./worker-transport";

interface PendingRequest {
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
}

export interface RustWorkerTransportOptions {
  command: string;
  args: string[];
}

export class RustWorkerTransport implements WorkerTransport {
  private readonly options: RustWorkerTransportOptions;

  private child: ChildProcessWithoutNullStreams | null = null;

  private pending = new Map<string, PendingRequest>();

  private frameRemainder: Uint8Array = new Uint8Array();

  public constructor(
    options: RustWorkerTransportOptions = {
      command: "cargo",
      args: ["run", "-q", "-p", "aegispy_worker"],
    },
  ) {
    this.options = options;
  }

  private hasCcInPath(env: NodeJS.ProcessEnv): boolean {
    const check = spawnSync("bash", ["-lc", "command -v cc >/dev/null 2>&1"], {
      env,
      stdio: "ignore",
    });
    return (check.status ?? 1) === 0;
  }

  private buildWorkerEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.hasCcInPath(env)) return env;

    const setup = spawnSync("bash", ["scripts/setup_zig_cc"], {
      env,
      encoding: "utf8",
    });
    if ((setup.status ?? 1) !== 0) return env;

    const ccWrapper = (setup.stdout ?? "").trim();
    if (ccWrapper.length === 0) return env;

    env.CC = ccWrapper;
    env.CXX = path.join(path.dirname(ccWrapper), "cxx");
    env.CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER = ccWrapper;
    return env;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child !== null) return this.child;

    const env = this.buildWorkerEnv();
    const child = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
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
