import type { AuditEvent, Permissions, RunRequest } from "../contracts/types";

export type CapabilityKind =
  | "fs_read"
  | "fs_write"
  | "http_request"
  | "env_read";

export interface CapabilityAttempt {
  kind: CapabilityKind;
  target: string;
  bytes: number;
}

export interface PolicyBudgetState {
  fsBytes: number;
  fsFiles: number;
  httpRequests: number;
  httpBytes: number;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  errorCode: "AEG-POLICY-DENIED" | null;
  auditKind: AuditEvent["kind"];
  detailJson: string;
}

function normalizePath(value: string): string {
  const slash = value.replaceAll("\\", "/");
  const parts = slash.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return "../";
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

function includesTraversal(value: string): boolean {
  return value.split(/[\\/]+/).includes("..");
}

function hasRootMatch(target: string, roots: string[]): boolean {
  const normalizedTarget = normalizePath(target);
  return roots.some((root) => {
    const normalizedRoot = normalizePath(root);
    return (
      normalizedTarget === normalizedRoot ||
      normalizedTarget.startsWith(`${normalizedRoot}/`)
    );
  });
}

function originFromTarget(target: string): string {
  const match = target.match(/^https?:\/\/[^/]+/i);
  return match ? match[0].toLowerCase() : "";
}

function decisionFrom(
  allowed: boolean,
  auditKind: AuditEvent["kind"],
  reason: string,
  payload: Record<string, unknown>,
): PolicyDecision {
  return {
    allowed,
    auditKind,
    reason,
    errorCode: allowed ? null : "AEG-POLICY-DENIED",
    detailJson: JSON.stringify({ reason, ...payload }),
  };
}

export function makePolicyBudgetState(): PolicyBudgetState {
  return {
    fsBytes: 0,
    fsFiles: 0,
    httpRequests: 0,
    httpBytes: 0,
  };
}

function checkFs(
  permissions: Permissions,
  attempt: CapabilityAttempt,
  budget: PolicyBudgetState,
): PolicyDecision {
  const policy = permissions.fs;
  if (policy === null) {
    return decisionFrom(false, "policy_denied", "fs_permission_missing", {
      capability: attempt.kind,
    });
  }

  if (includesTraversal(attempt.target)) {
    return decisionFrom(false, "policy_denied", "fs_path_traversal", {
      target: attempt.target,
    });
  }

  const roots =
    attempt.kind === "fs_read" ? policy.readRoots : policy.writeRoots;
  if (!hasRootMatch(attempt.target, roots)) {
    return decisionFrom(false, "policy_denied", "fs_root_violation", {
      target: attempt.target,
    });
  }

  if (budget.fsFiles + 1 > policy.maxFiles) {
    return decisionFrom(false, "policy_denied", "fs_file_budget_reached", {
      nextFiles: budget.fsFiles + 1,
    });
  }

  if (budget.fsBytes + attempt.bytes > policy.maxBytes) {
    return decisionFrom(false, "policy_denied", "fs_byte_budget_reached", {
      nextBytes: budget.fsBytes + attempt.bytes,
    });
  }

  budget.fsFiles += 1;
  budget.fsBytes += attempt.bytes;

  return decisionFrom(
    true,
    attempt.kind === "fs_read" ? "fs_read" : "fs_write",
    "allow",
    {
      target: attempt.target,
      budget,
    },
  );
}

function checkHttp(
  permissions: Permissions,
  attempt: CapabilityAttempt,
  budget: PolicyBudgetState,
): PolicyDecision {
  const policy = permissions.http;
  if (policy === null) {
    return decisionFrom(false, "policy_denied", "http_permission_missing", {
      target: attempt.target,
    });
  }

  const origin = originFromTarget(attempt.target);
  if (origin.length === 0) {
    return decisionFrom(false, "policy_denied", "http_invalid_url", {
      target: attempt.target,
    });
  }

  if (policy.denyOrigins.includes(origin)) {
    return decisionFrom(false, "policy_denied", "http_origin_denied", {
      origin,
    });
  }

  if (policy.allowOrigins.length > 0 && !policy.allowOrigins.includes(origin)) {
    return decisionFrom(false, "policy_denied", "http_origin_not_granted", {
      origin,
    });
  }

  if (budget.httpRequests + 1 > policy.maxRequests) {
    return decisionFrom(false, "policy_denied", "http_request_budget_reached", {
      nextRequests: budget.httpRequests + 1,
    });
  }

  if (budget.httpBytes + attempt.bytes > policy.maxBytes) {
    return decisionFrom(false, "policy_denied", "http_byte_budget_reached", {
      nextBytes: budget.httpBytes + attempt.bytes,
    });
  }

  budget.httpRequests += 1;
  budget.httpBytes += attempt.bytes;

  return decisionFrom(true, "http_request", "allow", {
    origin,
    budget,
  });
}

function checkEnv(
  permissions: Permissions,
  attempt: CapabilityAttempt,
): PolicyDecision {
  const policy = permissions.env;
  if (policy === null) {
    return decisionFrom(false, "policy_denied", "env_permission_missing", {
      key: attempt.target,
    });
  }
  if (!policy.allowKeys.includes(attempt.target)) {
    return decisionFrom(false, "policy_denied", "env_key_not_granted", {
      key: attempt.target,
    });
  }
  return decisionFrom(true, "env_read", "allow", { key: attempt.target });
}

export function evaluatePolicyAttempt(
  req: RunRequest,
  attempt: CapabilityAttempt,
  budget: PolicyBudgetState,
): PolicyDecision {
  if (attempt.kind === "fs_read" || attempt.kind === "fs_write") {
    return checkFs(req.permissions, attempt, budget);
  }
  if (attempt.kind === "http_request") {
    return checkHttp(req.permissions, attempt, budget);
  }
  return checkEnv(req.permissions, attempt);
}
