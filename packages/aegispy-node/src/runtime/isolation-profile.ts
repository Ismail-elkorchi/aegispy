export type IsolationProfileName = "strict" | "compat";

export interface IsolationProfile {
  name: IsolationProfileName;
  maxWallMs: number;
  maxCpuMs: number;
  maxMemoryBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  denyEnvCapability: boolean;
}

const PROFILE_DEFAULTS: Record<IsolationProfileName, IsolationProfile> = {
  strict: {
    name: "strict",
    maxWallMs: 5000,
    maxCpuMs: 5000,
    maxMemoryBytes: 64 * 1024 * 1024,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 2 * 1024 * 1024,
    denyEnvCapability: true,
  },
  compat: {
    name: "compat",
    maxWallMs: 10000,
    maxCpuMs: 10000,
    maxMemoryBytes: 256 * 1024 * 1024,
    maxStdoutBytes: 8 * 1024 * 1024,
    maxStderrBytes: 8 * 1024 * 1024,
    denyEnvCapability: false,
  },
};

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  key: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid isolation profile value for ${key}`);
  }
  return parsed;
}

export function resolveIsolationProfile(
  env: NodeJS.ProcessEnv = process.env,
): IsolationProfile {
  const raw = (env.AEGISPY_ISOLATION_PROFILE ?? "strict").trim().toLowerCase();
  if (raw !== "strict" && raw !== "compat") {
    throw new Error("invalid AEGISPY_ISOLATION_PROFILE");
  }

  const base = PROFILE_DEFAULTS[raw];

  return {
    name: base.name,
    maxWallMs: parsePositiveInt(
      env.AEGISPY_ISOLATION_MAX_WALL_MS,
      base.maxWallMs,
      "AEGISPY_ISOLATION_MAX_WALL_MS",
    ),
    maxCpuMs: parsePositiveInt(
      env.AEGISPY_ISOLATION_MAX_CPU_MS,
      base.maxCpuMs,
      "AEGISPY_ISOLATION_MAX_CPU_MS",
    ),
    maxMemoryBytes: parsePositiveInt(
      env.AEGISPY_ISOLATION_MAX_MEMORY_BYTES,
      base.maxMemoryBytes,
      "AEGISPY_ISOLATION_MAX_MEMORY_BYTES",
    ),
    maxStdoutBytes: parsePositiveInt(
      env.AEGISPY_ISOLATION_MAX_STDOUT_BYTES,
      base.maxStdoutBytes,
      "AEGISPY_ISOLATION_MAX_STDOUT_BYTES",
    ),
    maxStderrBytes: parsePositiveInt(
      env.AEGISPY_ISOLATION_MAX_STDERR_BYTES,
      base.maxStderrBytes,
      "AEGISPY_ISOLATION_MAX_STDERR_BYTES",
    ),
    denyEnvCapability: base.denyEnvCapability,
  };
}

export function toWorkerIsolationEnv(
  profile: IsolationProfile,
): NodeJS.ProcessEnv {
  return {
    AEGISPY_WORKER_ISOLATION_PROFILE: profile.name,
    AEGISPY_WORKER_MAX_WALL_MS: String(profile.maxWallMs),
    AEGISPY_WORKER_MAX_CPU_MS: String(profile.maxCpuMs),
    AEGISPY_WORKER_MAX_MEMORY_BYTES: String(profile.maxMemoryBytes),
    AEGISPY_WORKER_MAX_STDOUT_BYTES: String(profile.maxStdoutBytes),
    AEGISPY_WORKER_MAX_STDERR_BYTES: String(profile.maxStderrBytes),
    AEGISPY_WORKER_DENY_ENV_CAPABILITY: profile.denyEnvCapability ? "1" : "0",
  };
}
