import type {
  AuditEvent,
  ExecutionMeta,
  TerminationReason,
} from "../contracts/types";

export interface MetaDraft {
  startedTsMs: number;
  cpuMs: number;
  memoryPeakBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  termination: TerminationReason;
  audit: AuditEvent[];
}

export function makeMetaDraft(startedTsMs: number): MetaDraft {
  return {
    startedTsMs,
    cpuMs: 0,
    memoryPeakBytes: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    termination: "ok",
    audit: [],
  };
}

export function finalizeMeta(
  draft: MetaDraft,
  endedTsMs: number,
): ExecutionMeta {
  const durationMs = Math.max(0, endedTsMs - draft.startedTsMs);
  return {
    startedTsMs: draft.startedTsMs,
    endedTsMs,
    durationMs,
    cpuMs: draft.cpuMs,
    memoryPeakBytes: draft.memoryPeakBytes,
    stdoutBytes: draft.stdoutBytes,
    stderrBytes: draft.stderrBytes,
    termination: draft.termination,
    audit: draft.audit,
  };
}
