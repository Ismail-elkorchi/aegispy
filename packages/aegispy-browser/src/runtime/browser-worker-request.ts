import type {
  DeterminismConfig,
  RequestedNetworkCapability,
  TerminationReason,
} from "@aegispy/core";
import type { ErrorCode } from "../../../aegispy-core/src/contracts/types";

export interface BrowserWorkerRunRequest {
  requestId: string;
  code: string;
  stdinUtf8: string;
  determinism: DeterminismConfig;
  assetBaseUrl?: string;
  packages: string[];
  network?: RequestedNetworkCapability;
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
  errorCode?: ErrorCode;
  termination?: TerminationReason;
}

export type BrowserWorkerRunResult =
  | BrowserWorkerRunResultOk
  | BrowserWorkerRunResultError;

type ValidationResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      issues: string[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function validateNetworkCapability(
  value: unknown,
  issues: string[],
): value is RequestedNetworkCapability {
  if (!isRecord(value)) {
    issues.push("network:object_expected");
    return false;
  }
  if (!isStringArray(value.allowOrigins)) {
    issues.push("network.allowOrigins:string_array_expected");
  }
  if (value.denyOrigins !== undefined && !isStringArray(value.denyOrigins)) {
    issues.push("network.denyOrigins:string_array_expected");
  }
  if (
    typeof value.maxRequests !== "number" ||
    !Number.isFinite(value.maxRequests) ||
    value.maxRequests < 0
  ) {
    issues.push("network.maxRequests:number_expected");
  }
  if (
    typeof value.maxBytes !== "number" ||
    !Number.isFinite(value.maxBytes) ||
    value.maxBytes < 0
  ) {
    issues.push("network.maxBytes:number_expected");
  }
  return issues.length === 0;
}

function validateDeterminism(
  value: unknown,
  issues: string[],
): value is DeterminismConfig {
  if (!isRecord(value)) {
    issues.push("determinism:object_expected");
    return false;
  }
  if (typeof value.enabled !== "boolean") {
    issues.push("determinism.enabled:boolean_expected");
  }
  if (typeof value.epochMs !== "number" || !Number.isFinite(value.epochMs)) {
    issues.push("determinism.epochMs:number_expected");
  }
  if (typeof value.rngSeedHex !== "string") {
    issues.push("determinism.rngSeedHex:string_expected");
  } else if (!/^[0-9a-fA-F]+$/u.test(value.rngSeedHex)) {
    issues.push("determinism.rngSeedHex:hex_expected");
  }
  return issues.length === 0;
}

export function normalizeBrowserWorkerRequest(
  input: unknown,
): ValidationResult<BrowserWorkerRunRequest> {
  const issues: string[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: ["request:object_expected"],
    };
  }

  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    issues.push("requestId:string_expected");
  }
  if (typeof input.code !== "string") {
    issues.push("code:string_expected");
  }
  if (typeof input.stdinUtf8 !== "string") {
    issues.push("stdinUtf8:string_expected");
  }
  if (!validateDeterminism(input.determinism, issues)) {
    return {
      ok: false,
      issues,
    };
  }
  if (
    input.assetBaseUrl !== undefined &&
    typeof input.assetBaseUrl !== "string"
  ) {
    issues.push("assetBaseUrl:string_expected");
  }
  if (!isStringArray(input.packages)) {
    issues.push("packages:string_array_expected");
  }
  const networkValid =
    input.network === undefined ||
    validateNetworkCapability(input.network, issues);

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
    };
  }

  const determinism = input.determinism as DeterminismConfig;
  const assetBaseUrl =
    typeof input.assetBaseUrl === "string" ? input.assetBaseUrl : undefined;
  const packages = input.packages as string[];
  const networkInput =
    input.network !== undefined && networkValid
      ? (input.network as RequestedNetworkCapability)
      : undefined;
  const network =
    networkInput !== undefined
      ? {
          allowOrigins: [...networkInput.allowOrigins],
          denyOrigins: Array.isArray(networkInput.denyOrigins)
            ? [...networkInput.denyOrigins]
            : undefined,
          maxRequests: networkInput.maxRequests,
          maxBytes: networkInput.maxBytes,
        }
      : undefined;

  return {
    ok: true,
    value: {
      requestId: input.requestId as string,
      code: input.code as string,
      stdinUtf8: input.stdinUtf8 as string,
      determinism: {
        enabled: determinism.enabled,
        epochMs: determinism.epochMs,
        rngSeedHex: determinism.rngSeedHex,
      },
      assetBaseUrl,
      packages: [...packages],
      network,
    },
  };
}

export function normalizeBrowserWorkerResult(
  input: unknown,
): ValidationResult<BrowserWorkerRunResult> {
  const issues: string[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: ["result:object_expected"],
    };
  }

  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    issues.push("requestId:string_expected");
  }
  if (input.status !== "ok" && input.status !== "error") {
    issues.push("status:result_status_expected");
  }
  if (typeof input.stdoutUtf8 !== "string") {
    issues.push("stdoutUtf8:string_expected");
  }
  if (typeof input.stderrUtf8 !== "string") {
    issues.push("stderrUtf8:string_expected");
  }
  if (input.status === "error" && typeof input.errorMessage !== "string") {
    issues.push("errorMessage:string_expected");
  }
  if (
    input.status === "error" &&
    input.errorCode !== undefined &&
    input.errorCode !== "AEG-POLICY-DENIED" &&
    input.errorCode !== "AEG-ENGINE"
  ) {
    issues.push("errorCode:error_code_expected");
  }
  if (
    input.status === "error" &&
    input.termination !== undefined &&
    input.termination !== "policy_denied" &&
    input.termination !== "engine_error"
  ) {
    issues.push("termination:termination_reason_expected");
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
    };
  }

  if (input.status === "ok") {
    return {
      ok: true,
      value: {
        requestId: input.requestId as string,
        status: "ok",
        stdoutUtf8: input.stdoutUtf8 as string,
        stderrUtf8: input.stderrUtf8 as string,
      },
    };
  }

  return {
    ok: true,
    value: {
      requestId: input.requestId as string,
      status: "error",
      stdoutUtf8: input.stdoutUtf8 as string,
      stderrUtf8: input.stderrUtf8 as string,
      errorMessage: input.errorMessage as string,
      errorCode: input.errorCode as ErrorCode | undefined,
      termination: input.termination as TerminationReason | undefined,
    },
  };
}
