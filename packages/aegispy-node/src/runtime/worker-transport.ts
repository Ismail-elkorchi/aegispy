import type { RunRequest, RunResult } from "@aegispy/core";

export interface WorkerTransport {
  run(req: RunRequest): Promise<RunResult>;
  close(): Promise<void>;
}
