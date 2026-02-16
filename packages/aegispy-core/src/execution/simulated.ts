import {
  checkMemoryLimit,
  checkOutputLimit,
  checkWallTime,
  parseStderrMarker,
  parseStdoutMarker,
} from "../limits/index";
import { makeAegisPyError } from "../errors";
import {
  deterministicTimestamp,
  makeDeterministicRng,
} from "../determinism/index";
import { finalizeMeta, makeMetaDraft } from "../meta/index";
import {
  evaluatePolicyAttempt,
  makePolicyBudgetState,
  type CapabilityAttempt,
} from "../policy/index";
import {
  validateRunRequest,
  validationIssuesToErrorDetail,
  type ValidationIssue,
} from "../contracts/validation";
import type {
  AuditEvent,
  ErrorCode,
  RunRequest,
  RunResult,
  TerminationReason,
} from "../contracts/types";

interface RunCore {
  status: "ok" | "error";
  exitCode: number;
  stdoutUtf8: string;
  stderrUtf8: string;
  termination: TerminationReason;
  errorCode: ErrorCode | null;
  errorMessage: string;
}

function nowMs(): number {
  return Date.now();
}

function parseQuotedParts(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 1)
    .map((part) => {
      const quote = part[0];
      if ((quote === '"' || quote === "'") && part[part.length - 1] === quote) {
        return part.slice(1, -1);
      }
      return "";
    })
    .filter((part) => part.length > 0);
}

function collectCallArgs(code: string, functionName: string): string[] {
  const args: string[] = [];
  const needle = `${functionName}(`;
  let cursor = 0;

  while (cursor < code.length) {
    const start = code.indexOf(needle, cursor);
    if (start === -1) {
      break;
    }

    const openParen = start + needle.length;
    const closeParen = code.indexOf(")", openParen);
    if (closeParen === -1) {
      break;
    }

    args.push(code.slice(openParen, closeParen));
    cursor = closeParen + 1;
  }

  return args;
}

function collectPrints(
  code: string,
  deterministic: { enabled: boolean; epochMs: number; rngSeedHex: string },
): string[] {
  const lines: string[] = [];
  const printArgs = collectCallArgs(code, "print");
  const rng = makeDeterministicRng(deterministic.rngSeedHex);
  let deterministicStep = 0;

  for (const printArg of printArgs) {
    const rawArgs = printArg.trim();

    if (rawArgs.includes("time.time")) {
      if (deterministic.enabled) {
        lines.push(
          String(deterministicTimestamp(deterministic, deterministicStep)),
        );
      } else {
        lines.push(String(1700000000 + deterministicStep));
      }
      deterministicStep += 1;
    } else if (rawArgs.includes("random.random")) {
      const value = deterministic.enabled ? rng() : Math.random();
      lines.push(value.toFixed(6));
    } else {
      const parts = parseQuotedParts(rawArgs);
      if (parts.length === 0) {
        lines.push(rawArgs);
      } else {
        lines.push(parts.join(" "));
      }
    }
  }

  return lines;
}

function collectAttempts(code: string): CapabilityAttempt[] {
  const attempts: CapabilityAttempt[] = [];

  for (const arg of collectCallArgs(code, "aegispy.fs_write")) {
    const parts = parseQuotedParts(arg);
    const target = parts[0] ?? "/blocked/out.txt";
    const content = parts[1] ?? "";
    attempts.push({
      kind: "fs_write",
      target,
      bytes: Buffer.byteLength(content, "utf8"),
    });
  }

  for (const arg of collectCallArgs(code, "aegispy.fs_read")) {
    const parts = parseQuotedParts(arg);
    const target = parts[0] ?? "/blocked/in.txt";
    attempts.push({ kind: "fs_read", target, bytes: 1 });
  }

  for (const arg of collectCallArgs(code, "aegispy.http_get")) {
    const parts = parseQuotedParts(arg);
    const target = parts[0] ?? "https://blocked.invalid/";
    attempts.push({ kind: "http_request", target, bytes: 256 });
  }

  for (const arg of collectCallArgs(code, "aegispy.env_get")) {
    const parts = parseQuotedParts(arg);
    const target = parts[0] ?? "HOME";
    attempts.push({ kind: "env_read", target, bytes: 1 });
  }

  return attempts;
}

function evaluateRun(req: RunRequest): RunCore {
  const timeout = checkWallTime(req.code, req.limits.time.wallMs);
  if (timeout !== null) {
    return {
      status: "error",
      exitCode: 124,
      stdoutUtf8: "",
      stderrUtf8: timeout.message,
      termination: timeout.termination,
      errorCode: timeout.errorCode,
      errorMessage: timeout.message,
    };
  }

  const memoryViolation = checkMemoryLimit(req.code, req.limits);
  if (memoryViolation !== null) {
    return {
      status: "error",
      exitCode: 137,
      stdoutUtf8: "",
      stderrUtf8: memoryViolation.message,
      termination: memoryViolation.termination,
      errorCode: memoryViolation.errorCode,
      errorMessage: memoryViolation.message,
    };
  }

  const attempts = collectAttempts(req.code);
  const budget = makePolicyBudgetState();

  for (const attempt of attempts) {
    const decision = evaluatePolicyAttempt(req, attempt, budget);
    if (!decision.allowed) {
      return {
        status: "error",
        exitCode: 13,
        stdoutUtf8: "",
        stderrUtf8: decision.reason,
        termination: "policy_denied",
        errorCode: "AEG-POLICY-DENIED",
        errorMessage: decision.reason,
      };
    }
  }

  const printLines = collectPrints(req.code, req.determinism);
  const stdoutMarker = parseStdoutMarker(req.code);
  const stderrMarker = parseStderrMarker(req.code);

  const stdoutByMarker = stdoutMarker > 0 ? "x".repeat(stdoutMarker) : "";
  const stderrByMarker = stderrMarker > 0 ? "e".repeat(stderrMarker) : "";

  const stdoutUtf8 =
    [stdoutByMarker, ...printLines]
      .filter((item) => item.length > 0)
      .join("\n") + (printLines.length > 0 ? "\n" : "");
  const stderrUtf8 = stderrByMarker;

  const outputViolation = checkOutputLimit(stdoutUtf8, stderrUtf8, req.limits);
  if (outputViolation !== null) {
    return {
      status: "error",
      exitCode: 122,
      stdoutUtf8,
      stderrUtf8,
      termination: outputViolation.termination,
      errorCode: outputViolation.errorCode,
      errorMessage: outputViolation.message,
    };
  }

  return {
    status: "ok",
    exitCode: 0,
    stdoutUtf8,
    stderrUtf8,
    termination: "ok",
    errorCode: null,
    errorMessage: "",
  };
}

function pushAudit(
  audit: AuditEvent[],
  kind: AuditEvent["kind"],
  tsMs: number,
  detail: Record<string, unknown>,
): void {
  audit.push({
    seq: audit.length + 1,
    tsMs,
    kind,
    detailJson: JSON.stringify(detail),
  });
}

function buildInvalidRequestResult(
  issues: ValidationIssue[],
  startedTsMs: number,
): RunResult {
  const meta = finalizeMeta(
    {
      ...makeMetaDraft(startedTsMs),
      termination: "internal_error",
    },
    startedTsMs,
  );

  return {
    status: "error",
    exitCode: 2,
    stdoutUtf8: "",
    stderrUtf8: "invalid request",
    meta,
    error: makeAegisPyError(
      "AEG-INVALID-REQUEST",
      "invalid request",
      validationIssuesToErrorDetail(issues),
    ),
  };
}

export function simulateRun(input: unknown): RunResult {
  const validated = validateRunRequest(input);
  const fallbackNow = nowMs();
  if (!validated.ok) {
    return buildInvalidRequestResult(validated.issues, fallbackNow);
  }

  const req = validated.value;
  const startedTsMs = req.determinism.enabled
    ? req.determinism.epochMs
    : nowMs();
  const draft = makeMetaDraft(startedTsMs);

  if (!req.determinism.enabled && req.code.includes("time.time")) {
    pushAudit(draft.audit, "determinism_time", startedTsMs, {
      source: "time.time",
    });
  }

  if (!req.determinism.enabled && req.code.includes("random.random")) {
    pushAudit(draft.audit, "determinism_rng", startedTsMs, {
      source: "random.random",
    });
  }

  const attempts = collectAttempts(req.code);
  const budget = makePolicyBudgetState();
  for (const attempt of attempts) {
    const decision = evaluatePolicyAttempt(req, attempt, budget);
    pushAudit(draft.audit, decision.auditKind, startedTsMs, {
      reason: decision.reason,
      target: attempt.target,
      bytes: attempt.bytes,
      budget,
    });
    if (!decision.allowed) {
      draft.termination = "policy_denied";
      const endedTsMs = req.determinism.enabled
        ? deterministicTimestamp(req.determinism, draft.audit.length)
        : nowMs();
      const meta = finalizeMeta(draft, endedTsMs);
      meta.stdoutBytes = 0;
      meta.stderrBytes = Buffer.byteLength(decision.reason, "utf8");
      return {
        status: "error",
        exitCode: 13,
        stdoutUtf8: "",
        stderrUtf8: decision.reason,
        meta,
        error: makeAegisPyError("AEG-POLICY-DENIED", decision.reason, {
          reason: decision.reason,
          capability: attempt.kind,
          target: attempt.target,
          budget,
        }),
      };
    }
  }

  const core = evaluateRun(req);
  draft.termination = core.termination;
  draft.stdoutBytes = Buffer.byteLength(core.stdoutUtf8, "utf8");
  draft.stderrBytes = Buffer.byteLength(core.stderrUtf8, "utf8");
  draft.cpuMs = Math.min(
    req.limits.time.cpuMs,
    Math.max(1, draft.audit.length + 1),
  );
  draft.memoryPeakBytes = Math.max(
    parseStderrMarker(req.code),
    parseStdoutMarker(req.code),
  );

  const endedTsMs = req.determinism.enabled
    ? deterministicTimestamp(req.determinism, draft.audit.length + 1)
    : nowMs();
  const meta = finalizeMeta(draft, endedTsMs);

  if (core.status === "ok") {
    return {
      status: "ok",
      exitCode: core.exitCode,
      stdoutUtf8: core.stdoutUtf8,
      stderrUtf8: core.stderrUtf8,
      meta,
    };
  }

  return {
    status: "error",
    exitCode: core.exitCode,
    stdoutUtf8: core.stdoutUtf8,
    stderrUtf8: core.stderrUtf8,
    meta,
    error: makeAegisPyError(
      core.errorCode ?? "AEG-INTERNAL",
      core.errorMessage,
      {
        termination: core.termination,
        host: req.host,
      },
    ),
  };
}
