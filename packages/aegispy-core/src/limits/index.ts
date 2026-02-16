import type { ErrorCode, Limits, TerminationReason } from "../contracts/types";

export interface LimitViolation {
  termination: TerminationReason;
  errorCode: ErrorCode;
  message: string;
}

export function detectsLoop(code: string): boolean {
  return code.includes("while True") || code.includes("#aegispy:loop=infinite");
}

export function parseMemoryMarker(code: string): number {
  const match = code.match(/#aegispy:memory=(\d+)/);
  if (!match) return 0;
  return Number.parseInt(match[1], 10);
}

export function parseStdoutMarker(code: string): number {
  const match = code.match(/#aegispy:stdout=(\d+)/);
  if (!match) return 0;
  return Number.parseInt(match[1], 10);
}

export function parseStderrMarker(code: string): number {
  const match = code.match(/#aegispy:stderr=(\d+)/);
  if (!match) return 0;
  return Number.parseInt(match[1], 10);
}

export function checkWallTime(
  code: string,
  wallMs: number,
): LimitViolation | null {
  if (!detectsLoop(code)) return null;
  if (wallMs <= 0) return null;
  return {
    termination: "timeout",
    errorCode: "AEG-TIMEOUT",
    message: "wall time reached",
  };
}

export function checkMemoryLimit(
  code: string,
  limits: Limits,
): LimitViolation | null {
  const requested = parseMemoryMarker(code);
  if (requested <= limits.bytes.memoryBytes) return null;
  return {
    termination: "memory_limit",
    errorCode: "AEG-MEMORY-LIMIT",
    message: "memory budget reached",
  };
}

export function checkOutputLimit(
  stdoutUtf8: string,
  stderrUtf8: string,
  limits: Limits,
): LimitViolation | null {
  const stdoutBytes = Buffer.byteLength(stdoutUtf8, "utf8");
  const stderrBytes = Buffer.byteLength(stderrUtf8, "utf8");

  if (
    stdoutBytes > limits.bytes.stdoutBytes ||
    stderrBytes > limits.bytes.stderrBytes
  ) {
    return {
      termination: "output_limit",
      errorCode: "AEG-OUTPUT-LIMIT",
      message: "output budget reached",
    };
  }

  return null;
}
