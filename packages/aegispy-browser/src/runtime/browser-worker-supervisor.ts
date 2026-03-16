import type { DeterminismConfig } from "@aegispy/core";

export interface BrowserWorkerRunRequest {
  requestId: string;
  code: string;
  stdinUtf8: string;
  determinism: DeterminismConfig;
  assetBaseUrl?: string;
  packages: string[];
}

interface BrowserWorkerRunResultOk {
  requestId: string;
  status: "ok";
  stdoutUtf8: string;
  stderrUtf8: string;
}

interface BrowserWorkerRunResultError {
  requestId: string;
  status: "error";
  stdoutUtf8: string;
  stderrUtf8: string;
  errorMessage: string;
}

export type BrowserWorkerRunResult =
  | BrowserWorkerRunResultOk
  | BrowserWorkerRunResultError;

interface WorkerPortHandle {
  postMessage(payload: BrowserWorkerRunRequest): void;
  terminate(): Promise<void>;
  onMessage(handler: (payload: BrowserWorkerRunResult) => void): void;
  onError(handler: (error: unknown) => void): void;
}

type WorkerPortFactory = () => Promise<WorkerPortHandle>;

interface PendingRequest {
  resolve: (payload: BrowserWorkerRunResult) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

function workerModuleUrl(): URL {
  return new URL("./pyodide-worker.mjs", import.meta.url);
}

async function defaultWorkerPortFactory(): Promise<WorkerPortHandle> {
  if (typeof process !== "undefined" && process.versions?.node) {
    const { Worker: NodeWorker } = await import("node:worker_threads");
    const worker = new NodeWorker(workerModuleUrl());
    return {
      postMessage(payload) {
        worker.postMessage(payload);
      },
      async terminate() {
        await worker.terminate();
      },
      onMessage(handler) {
        worker.on("message", (payload: BrowserWorkerRunResult) => {
          handler(payload);
        });
      },
      onError(handler) {
        worker.on("error", handler);
        worker.on("exit", (code) => {
          if (code !== 0) {
            handler(new Error(`browser worker exited with code ${code}`));
          }
        });
      },
    };
  }

  if (typeof Worker === "undefined") {
    throw new Error("browser worker runtime unavailable");
  }

  const worker = new Worker(workerModuleUrl(), { type: "module" });
  return {
    postMessage(payload) {
      worker.postMessage(payload);
    },
    async terminate() {
      worker.terminate();
    },
    onMessage(handler) {
      worker.addEventListener("message", (event: MessageEvent) => {
        handler(event.data as BrowserWorkerRunResult);
      });
    },
    onError(handler) {
      worker.addEventListener("error", (event: ErrorEvent) => {
        handler(event.error ?? new Error(event.message));
      });
    },
  };
}

export class BrowserWorkerSupervisor {
  private readonly createWorkerPort: WorkerPortFactory;

  private workerPromise: Promise<WorkerPortHandle> | null = null;

  private workerToken = 0;

  private pending = new Map<string, PendingRequest>();

  public constructor(
    createWorkerPort: WorkerPortFactory = defaultWorkerPortFactory,
  ) {
    this.createWorkerPort = createWorkerPort;
  }

  private async worker(): Promise<WorkerPortHandle> {
    if (this.workerPromise !== null) {
      return this.workerPromise;
    }

    const token = ++this.workerToken;
    this.workerPromise = this.createWorkerPort().then((worker) => {
      worker.onMessage((payload) => {
        this.resolvePending(payload.requestId, payload);
      });
      worker.onError((error) => {
        if (token !== this.workerToken) {
          return;
        }
        const message =
          error instanceof Error ? error.message : "browser worker failure";
        const pendingEntries = Array.from(this.pending.values());
        this.pending.clear();
        this.workerPromise = null;
        for (const pending of pendingEntries) {
          clearTimeout(pending.timeoutHandle);
          pending.reject(new Error(message));
        }
      });
      return worker;
    });

    return this.workerPromise;
  }

  public async run(
    request: BrowserWorkerRunRequest,
    wallMs: number,
  ): Promise<BrowserWorkerRunResult> {
    const worker = await this.worker();

    const resultPromise = new Promise<BrowserWorkerRunResult>(
      (resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          const pending = this.pending.get(request.requestId);
          if (!pending) {
            return;
          }
          this.pending.delete(request.requestId);
          void this.reset().then(() => {
            resolve({
              requestId: request.requestId,
              status: "error",
              stdoutUtf8: "",
              stderrUtf8: "wall time reached",
              errorMessage: "wall time reached",
            });
          });
        }, wallMs);

        this.pending.set(request.requestId, {
          resolve,
          reject,
          timeoutHandle,
        });
      },
    );

    worker.postMessage(request);
    return resultPromise;
  }

  public async reset(): Promise<void> {
    if (this.workerPromise === null) return;
    const workerPromise = this.workerPromise;
    this.workerPromise = null;
    this.workerToken += 1;
    const worker = await workerPromise;
    await worker.terminate();
  }

  public async close(): Promise<void> {
    await this.reset();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutHandle);
    }
    this.pending.clear();
  }

  private resolvePending(
    requestId: string,
    payload: BrowserWorkerRunResult,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timeoutHandle);
    pending.resolve(payload);
  }
}
