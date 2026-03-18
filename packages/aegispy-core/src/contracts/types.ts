export type HostKind = "node" | "deno" | "bun" | "browser";

export type ConformanceProfile = "server-hardened" | "browser-real-engine";

export type TerminationReason =
  | "ok"
  | "engine_error"
  | "policy_denied"
  | "timeout"
  | "memory_limit"
  | "output_limit"
  | "internal_error";

export interface ByteLimits {
  memoryBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface TimeLimits {
  wallMs: number;
  cpuMs: number;
}

export interface FsPermission {
  readRoots: string[];
  writeRoots: string[];
  maxBytes: number;
  maxFiles: number;
}

export interface HttpPermission {
  allowOrigins: string[];
  denyOrigins: string[];
  maxRequests: number;
  maxBytes: number;
}

export interface EnvPermission {
  allowKeys: string[];
}

export interface DeterminismConfig {
  enabled: boolean;
  epochMs: number;
  rngSeedHex: string;
}

export interface Permissions {
  fs: FsPermission | null;
  http: HttpPermission | null;
  env: EnvPermission | null;
}

export interface Limits {
  time: TimeLimits;
  bytes: ByteLimits;
}

export interface RunRequest {
  host: HostKind;
  code: string;
  argv: string[];
  stdinUtf8: string;
  permissions: Permissions;
  limits: Limits;
  determinism: DeterminismConfig;
}

export interface AuditEvent {
  seq: number;
  tsMs: number;
  kind:
    | "fs_read"
    | "fs_write"
    | "http_request"
    | "env_read"
    | "determinism_time"
    | "determinism_rng"
    | "policy_denied"
    | "runtime_channel"
    | "runtime_binding"
    | "engine_error"
    | "kernel_isolation";
  detailJson: string;
}

export interface ExecutionMeta {
  startedTsMs: number;
  endedTsMs: number;
  durationMs: number;
  cpuMs: number;
  memoryPeakBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  termination: TerminationReason;
  audit: AuditEvent[];
}

export interface RunResultOk {
  status: "ok";
  exitCode: number;
  stdoutUtf8: string;
  stderrUtf8: string;
  meta: ExecutionMeta;
}

export type ErrorCode =
  | "AEG-POLICY-DENIED"
  | "AEG-TIMEOUT"
  | "AEG-MEMORY-LIMIT"
  | "AEG-OUTPUT-LIMIT"
  | "AEG-ENGINE"
  | "AEG-UNSUPPORTED-HOST"
  | "AEG-INVALID-REQUEST"
  | "AEG-INTERNAL";

export interface AegisPyError {
  code: ErrorCode;
  message: string;
  detailJson: string;
}

export interface RunResultError {
  status: "error";
  exitCode: number;
  stdoutUtf8: string;
  stderrUtf8: string;
  meta: ExecutionMeta;
  error: AegisPyError;
}

export type RunResult = RunResultOk | RunResultError;

export interface RuntimeCapabilities {
  host: HostKind;
  profile: ConformanceProfile;
  transport: "process" | "simulation" | "inprocess" | "worker";
  capabilityChannel: "component-wit" | "worker-timeout" | "none";
  runtimeFamily?: string;
  bundleId?: string;
  pythonAbi?: string;
  packageSetVersion?: string;
  fs: boolean;
  http: boolean;
  env: boolean;
  deterministic: boolean;
  hardened: boolean;
}

export interface AegisPyRuntime {
  host: HostKind;
  capabilities(): RuntimeCapabilities;
  run(req: RunRequest): Promise<RunResult>;
  close(): Promise<void>;
}

export interface CreateRuntimeOptions {
  host: HostKind;
}
