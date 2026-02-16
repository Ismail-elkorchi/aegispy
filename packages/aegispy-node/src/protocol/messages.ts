import type { RunRequest, RunResult } from "@aegispy/core";

export interface WorkerRunRequest {
  type: "run";
  requestId: string;
  run: Omit<RunRequest, "host">;
}

export interface WorkerRunResponse {
  type: "run_result";
  requestId: string;
  result: RunResult;
}

export type WorkerMessage = WorkerRunRequest | WorkerRunResponse;
