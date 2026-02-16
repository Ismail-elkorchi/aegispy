import type { RunRequest, RunResult } from "@aegispy/core";
import { simulateRun } from "../../../aegispy-core/src/execution/simulated";
import type { WorkerTransport } from "./worker-transport";

export class InProcessTransport implements WorkerTransport {
  public async run(req: RunRequest): Promise<RunResult> {
    return simulateRun(req);
  }

  public async close(): Promise<void> {
    return;
  }
}
