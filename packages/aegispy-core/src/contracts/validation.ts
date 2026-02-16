import type {
  AegisPyError,
  AuditEvent,
  DeterminismConfig,
  ErrorCode,
  ExecutionMeta,
  HostKind,
  RunRequest,
  RunResult,
} from "./types";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      issues: ValidationIssue[];
    };

const HOSTS = new Set<HostKind>(["node", "deno", "bun", "browser"]);
const TERMINATIONS = new Set([
  "ok",
  "engine_error",
  "policy_denied",
  "timeout",
  "memory_limit",
  "output_limit",
  "internal_error",
]);

const ERROR_CODES = new Set<ErrorCode>([
  "AEG-POLICY-DENIED",
  "AEG-TIMEOUT",
  "AEG-MEMORY-LIMIT",
  "AEG-OUTPUT-LIMIT",
  "AEG-ENGINE",
  "AEG-UNSUPPORTED-HOST",
  "AEG-INVALID-REQUEST",
  "AEG-INTERNAL",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkNumber(
  path: string,
  value: unknown,
  issues: ValidationIssue[],
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    issues.push({ path, message: "number_expected" });
    return false;
  }
  return true;
}

function checkString(
  path: string,
  value: unknown,
  issues: ValidationIssue[],
): value is string {
  if (typeof value !== "string") {
    issues.push({ path, message: "string_expected" });
    return false;
  }
  return true;
}

function checkStringArray(
  path: string,
  value: unknown,
  issues: ValidationIssue[],
): value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    issues.push({ path, message: "string_array_expected" });
    return false;
  }
  return true;
}

function validateDeterminism(
  path: string,
  value: unknown,
  issues: ValidationIssue[],
): value is DeterminismConfig {
  if (!isRecord(value)) {
    issues.push({ path, message: "object_expected" });
    return false;
  }
  if (typeof value.enabled !== "boolean") {
    issues.push({ path: `${path}.enabled`, message: "boolean_expected" });
  }
  checkNumber(`${path}.epochMs`, value.epochMs, issues);
  const okSeed = checkString(`${path}.rngSeedHex`, value.rngSeedHex, issues);
  const seedHex = okSeed ? (value.rngSeedHex as string) : "";
  if (okSeed && !/^[0-9a-fA-F]+$/.test(seedHex)) {
    issues.push({ path: `${path}.rngSeedHex`, message: "hex_string_expected" });
  }
  return issues.length === 0;
}

function validatePermissions(
  path: string,
  value: unknown,
  issues: ValidationIssue[],
): boolean {
  if (!isRecord(value)) {
    issues.push({ path, message: "object_expected" });
    return false;
  }

  const fs = value.fs;
  if (fs !== null) {
    if (!isRecord(fs)) {
      issues.push({ path: `${path}.fs`, message: "object_or_null_expected" });
    } else {
      checkStringArray(`${path}.fs.readRoots`, fs.readRoots, issues);
      checkStringArray(`${path}.fs.writeRoots`, fs.writeRoots, issues);
      checkNumber(`${path}.fs.maxBytes`, fs.maxBytes, issues);
      checkNumber(`${path}.fs.maxFiles`, fs.maxFiles, issues);
    }
  }

  const http = value.http;
  if (http !== null) {
    if (!isRecord(http)) {
      issues.push({ path: `${path}.http`, message: "object_or_null_expected" });
    } else {
      checkStringArray(`${path}.http.allowOrigins`, http.allowOrigins, issues);
      checkStringArray(`${path}.http.denyOrigins`, http.denyOrigins, issues);
      checkNumber(`${path}.http.maxRequests`, http.maxRequests, issues);
      checkNumber(`${path}.http.maxBytes`, http.maxBytes, issues);
    }
  }

  const env = value.env;
  if (env !== null) {
    if (!isRecord(env)) {
      issues.push({ path: `${path}.env`, message: "object_or_null_expected" });
    } else {
      checkStringArray(`${path}.env.allowKeys`, env.allowKeys, issues);
    }
  }

  return true;
}

function validateLimits(
  path: string,
  value: unknown,
  issues: ValidationIssue[],
): boolean {
  if (!isRecord(value)) {
    issues.push({ path, message: "object_expected" });
    return false;
  }

  if (!isRecord(value.time)) {
    issues.push({ path: `${path}.time`, message: "object_expected" });
  } else {
    checkNumber(`${path}.time.wallMs`, value.time.wallMs, issues);
    checkNumber(`${path}.time.cpuMs`, value.time.cpuMs, issues);
  }

  if (!isRecord(value.bytes)) {
    issues.push({ path: `${path}.bytes`, message: "object_expected" });
  } else {
    checkNumber(`${path}.bytes.memoryBytes`, value.bytes.memoryBytes, issues);
    checkNumber(`${path}.bytes.stdoutBytes`, value.bytes.stdoutBytes, issues);
    checkNumber(`${path}.bytes.stderrBytes`, value.bytes.stderrBytes, issues);
  }

  return true;
}

function validateAuditEvent(
  path: string,
  value: unknown,
  issues: ValidationIssue[],
): value is AuditEvent {
  if (!isRecord(value)) {
    issues.push({ path, message: "object_expected" });
    return false;
  }

  checkNumber(`${path}.seq`, value.seq, issues);
  checkNumber(`${path}.tsMs`, value.tsMs, issues);
  if (typeof value.kind !== "string") {
    issues.push({ path: `${path}.kind`, message: "string_expected" });
  }
  checkString(`${path}.detailJson`, value.detailJson, issues);
  return true;
}

function validateMeta(
  path: string,
  value: unknown,
  issues: ValidationIssue[],
): value is ExecutionMeta {
  if (!isRecord(value)) {
    issues.push({ path, message: "object_expected" });
    return false;
  }

  checkNumber(`${path}.startedTsMs`, value.startedTsMs, issues);
  checkNumber(`${path}.endedTsMs`, value.endedTsMs, issues);
  checkNumber(`${path}.durationMs`, value.durationMs, issues);
  checkNumber(`${path}.cpuMs`, value.cpuMs, issues);
  checkNumber(`${path}.memoryPeakBytes`, value.memoryPeakBytes, issues);
  checkNumber(`${path}.stdoutBytes`, value.stdoutBytes, issues);
  checkNumber(`${path}.stderrBytes`, value.stderrBytes, issues);

  if (
    typeof value.termination !== "string" ||
    !TERMINATIONS.has(value.termination)
  ) {
    issues.push({
      path: `${path}.termination`,
      message: "termination_expected",
    });
  }

  if (!Array.isArray(value.audit)) {
    issues.push({ path: `${path}.audit`, message: "array_expected" });
  } else {
    value.audit.forEach((item, index) => {
      validateAuditEvent(`${path}.audit.${index}`, item, issues);
    });
  }

  return true;
}

function validateError(
  path: string,
  value: unknown,
  issues: ValidationIssue[],
): value is AegisPyError {
  if (!isRecord(value)) {
    issues.push({ path, message: "object_expected" });
    return false;
  }

  if (
    typeof value.code !== "string" ||
    !ERROR_CODES.has(value.code as ErrorCode)
  ) {
    issues.push({ path: `${path}.code`, message: "error_code_expected" });
  }

  checkString(`${path}.message`, value.message, issues);
  checkString(`${path}.detailJson`, value.detailJson, issues);
  return true;
}

export function validateRunRequest(
  input: unknown,
): ValidationResult<RunRequest> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "", message: "object_expected" }] };
  }

  if (typeof input.host !== "string" || !HOSTS.has(input.host as HostKind)) {
    issues.push({ path: "host", message: "host_expected" });
  }

  checkString("code", input.code, issues);
  checkStringArray("argv", input.argv, issues);
  checkString("stdinUtf8", input.stdinUtf8, issues);

  validatePermissions("permissions", input.permissions, issues);
  validateLimits("limits", input.limits, issues);
  validateDeterminism("determinism", input.determinism, issues);

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value: input as unknown as RunRequest };
}

export function validateRunResult(input: unknown): ValidationResult<RunResult> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "", message: "object_expected" }] };
  }

  if (input.status !== "ok" && input.status !== "error") {
    issues.push({ path: "status", message: "status_expected" });
  }
  checkNumber("exitCode", input.exitCode, issues);
  checkString("stdoutUtf8", input.stdoutUtf8, issues);
  checkString("stderrUtf8", input.stderrUtf8, issues);
  validateMeta("meta", input.meta, issues);

  if (input.status === "error") {
    validateError("error", input.error, issues);
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value: input as unknown as RunResult };
}

export function validationIssuesToErrorDetail(
  issues: ValidationIssue[],
): Record<string, unknown> {
  return {
    issueCount: issues.length,
    issues,
  };
}
