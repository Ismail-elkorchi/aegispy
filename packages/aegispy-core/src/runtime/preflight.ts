import { makeAegisPyError } from "../errors";
import { finalizeMeta, makeMetaDraft } from "../meta/index";
import {
  validateRunRequest,
  validationIssuesToErrorDetail,
} from "../contracts/validation";
import type {
  AuditEvent,
  HostKind,
  Permissions,
  RunRequest,
  RunResult,
  RuntimeCapabilities,
  TerminationReason,
} from "../contracts/types";

export type RuntimePreflight =
  | {
      ok: true;
      request: RunRequest;
    }
  | {
      ok: false;
      result: RunResult;
    };

interface RuntimePreflightContext {
  runtimeHost: HostKind;
  capabilities: RuntimeCapabilities;
  closed: boolean;
}

function nextAuditEvent(
  audit: AuditEvent[],
  tsMs: number,
  kind: AuditEvent["kind"],
  detailJson: string,
): AuditEvent {
  return {
    seq: audit.length + 1,
    tsMs,
    kind,
    detailJson,
  };
}

function makeBoundaryAudit(
  capabilities: RuntimeCapabilities,
  startedTsMs: number,
): AuditEvent[] {
  const audit: AuditEvent[] = [];
  if (capabilities.capabilityChannel !== "none") {
    audit.push(
      nextAuditEvent(
        audit,
        startedTsMs,
        "runtime_channel",
        `capability_channel:${capabilities.capabilityChannel}`,
      ),
    );
  }
  audit.push(
    nextAuditEvent(
      audit,
      startedTsMs,
      "runtime_binding",
      `capability_binding_mode:${capabilities.transport}`,
    ),
  );
  return audit;
}

function withAuditPrefix(result: RunResult, prefix: AuditEvent[]): RunResult {
  if (prefix.length === 0) {
    return result;
  }

  const existingKinds = new Set(prefix.map((entry) => entry.kind));
  const trailing = result.meta.audit.filter(
    (entry) => !existingKinds.has(entry.kind),
  );
  const audit = [...prefix, ...trailing].map((entry, index) => ({
    ...entry,
    seq: index + 1,
  }));

  return {
    ...result,
    meta: {
      ...result.meta,
      audit,
    },
  };
}

export function withRuntimeBoundaryAudit(
  capabilities: RuntimeCapabilities,
  result: RunResult,
): RunResult {
  return withAuditPrefix(
    result,
    makeBoundaryAudit(capabilities, result.meta.startedTsMs),
  );
}

function unsupportedCapabilities(
  capabilities: RuntimeCapabilities,
  permissions: Permissions,
): string[] {
  const out: string[] = [];
  if (!capabilities.fs && permissions.fs !== null) out.push("fs");
  if (!capabilities.http && permissions.http !== null) out.push("http");
  if (!capabilities.env && permissions.env !== null) out.push("env");
  return out;
}

function boundaryErrorResult(args: {
  startedTsMs: number;
  capabilities: RuntimeCapabilities;
  exitCode: number;
  errorCode: "AEG-INTERNAL" | "AEG-INVALID-REQUEST" | "AEG-UNSUPPORTED-HOST";
  message: string;
  termination: TerminationReason;
  detail: Record<string, unknown>;
  terminalAuditKind: "policy_denied" | "engine_error" | null;
  terminalAuditDetailJson: string | null;
}): RunResult {
  const draft = makeMetaDraft(args.startedTsMs);
  draft.termination = args.termination;
  draft.stderrBytes = args.message.length;
  const base = finalizeMeta(draft, args.startedTsMs);

  const result: RunResult = {
    status: "error",
    exitCode: args.exitCode,
    stdoutUtf8: "",
    stderrUtf8: args.message,
    meta: base,
    error: makeAegisPyError(args.errorCode, args.message, args.detail),
  };

  const terminalAudit =
    args.terminalAuditKind === null || args.terminalAuditDetailJson === null
      ? []
      : [
          nextAuditEvent(
            [],
            args.startedTsMs,
            args.terminalAuditKind,
            args.terminalAuditDetailJson,
          ),
        ];

  return withAuditPrefix(
    result,
    makeBoundaryAudit(args.capabilities, args.startedTsMs).concat(
      terminalAudit,
    ),
  );
}

export function preflightRuntimeRequest(
  context: RuntimePreflightContext,
  input: unknown,
): RuntimePreflight {
  const startedTsMs = Date.now();

  if (context.closed) {
    return {
      ok: false,
      result: boundaryErrorResult({
        startedTsMs,
        capabilities: context.capabilities,
        exitCode: 1,
        errorCode: "AEG-INTERNAL",
        message: "runtime closed",
        termination: "internal_error",
        detail: {
          host: context.runtimeHost,
        },
        terminalAuditKind: "engine_error",
        terminalAuditDetailJson: "runtime_closed",
      }),
    };
  }

  const validated = validateRunRequest(input);
  if (!validated.ok) {
    return {
      ok: false,
      result: boundaryErrorResult({
        startedTsMs,
        capabilities: context.capabilities,
        exitCode: 2,
        errorCode: "AEG-INVALID-REQUEST",
        message: "invalid request",
        termination: "internal_error",
        detail: validationIssuesToErrorDetail(validated.issues),
        terminalAuditKind: "engine_error",
        terminalAuditDetailJson: "invalid_request",
      }),
    };
  }

  if (validated.value.host !== context.runtimeHost) {
    return {
      ok: false,
      result: boundaryErrorResult({
        startedTsMs,
        capabilities: context.capabilities,
        exitCode: 2,
        errorCode: "AEG-UNSUPPORTED-HOST",
        message: "host mismatch",
        termination: "engine_error",
        detail: {
          requestHost: validated.value.host,
          runtimeHost: context.runtimeHost,
        },
        terminalAuditKind: "engine_error",
        terminalAuditDetailJson: "request_host_mismatch",
      }),
    };
  }

  const unsupported = unsupportedCapabilities(
    context.capabilities,
    validated.value.permissions,
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      result: boundaryErrorResult({
        startedTsMs,
        capabilities: context.capabilities,
        exitCode: 2,
        errorCode: "AEG-UNSUPPORTED-HOST",
        message: "unsupported runtime capability request",
        termination: "policy_denied",
        detail: {
          host: context.runtimeHost,
          unsupportedCapabilities: unsupported,
          profile: context.capabilities.profile,
          reason: unsupported.join(","),
        },
        terminalAuditKind: "policy_denied",
        terminalAuditDetailJson: JSON.stringify({
          reason: "host_profile_capability_unsupported",
          unsupportedCapabilities: unsupported,
          profile: context.capabilities.profile,
        }),
      }),
    };
  }

  return {
    ok: true,
    request: validated.value,
  };
}
