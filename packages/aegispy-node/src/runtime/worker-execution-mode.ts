import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type WorkerExecutionMode = "process" | "microvm";

export type WorkerExecutionBackendName = "native-process" | "microvm-launcher";

export interface WorkerExecutionBackendInfo {
  mode: WorkerExecutionMode;
  backendName: WorkerExecutionBackendName;
  available: boolean;
  reason: string | null;
}

export interface WorkerLaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  backend: WorkerExecutionBackendInfo;
}

export interface WorkerLaunchDefaults {
  command: string;
  args: string[];
  componentBinaryPath: string;
  repoRoot: string;
  workerBinaryPath: string;
  env?: NodeJS.ProcessEnv;
}

function missingBackend(
  reason: string,
  env: NodeJS.ProcessEnv,
): WorkerLaunchSpec {
  return {
    command: "",
    args: [],
    env,
    backend: {
      mode: "microvm",
      backendName: "microvm-launcher",
      available: false,
      reason,
    },
  };
}

function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  if (command.includes("/") || path.isAbsolute(command)) {
    return existsSync(path.resolve(command));
  }

  const probe = spawnSync(
    "bash",
    ["-lc", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`],
    { env },
  );
  return (probe.status ?? 1) === 0;
}

function resolveLauncherArgs(env: NodeJS.ProcessEnv): {
  args: string[];
  reason: string | null;
} {
  const raw = (env.AEGISPY_MICROVM_LAUNCHER_ARGS_JSON ?? "").trim();
  if (raw === "") {
    return { args: [], reason: null };
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((value) => typeof value === "string")
    ) {
      return {
        args: [],
        reason:
          "invalid AEGISPY_MICROVM_LAUNCHER_ARGS_JSON, expected a JSON string array",
      };
    }
    return { args: parsed, reason: null };
  } catch {
    return {
      args: [],
      reason: "invalid AEGISPY_MICROVM_LAUNCHER_ARGS_JSON, expected valid JSON",
    };
  }
}

export function resolveWorkerExecutionMode(
  env: NodeJS.ProcessEnv = process.env,
): WorkerExecutionMode {
  const raw = (env.AEGISPY_WORKER_EXECUTION_MODE ?? "process")
    .trim()
    .toLowerCase();
  if (raw === "process") return "process";
  if (raw === "microvm") return "microvm";
  throw new Error(
    "invalid AEGISPY_WORKER_EXECUTION_MODE value, expected process or microvm",
  );
}

export function resolveWorkerLaunchSpec(
  defaults: WorkerLaunchDefaults,
): WorkerLaunchSpec {
  const env = defaults.env ?? process.env;
  const mode = resolveWorkerExecutionMode(env);

  if (mode === "process") {
    return {
      command: defaults.command,
      args: defaults.args,
      env,
      backend: {
        mode,
        backendName: "native-process",
        available: true,
        reason: null,
      },
    };
  }

  const launcher = (env.AEGISPY_MICROVM_LAUNCHER ?? "").trim();
  if (launcher === "") {
    return missingBackend("missing AEGISPY_MICROVM_LAUNCHER", env);
  }
  if (!commandExists(launcher, env)) {
    return missingBackend(`launcher not found: ${launcher}`, env);
  }

  const launcherArgs = resolveLauncherArgs(env);
  if (launcherArgs.reason !== null) {
    return missingBackend(launcherArgs.reason, env);
  }

  return {
    command: launcher,
    args: launcherArgs.args,
    env: {
      ...env,
      AEGISPY_MICROVM_COMPONENT_BINARY: defaults.componentBinaryPath,
      AEGISPY_MICROVM_REPO_ROOT: defaults.repoRoot,
      AEGISPY_MICROVM_WORKER_ARGS_JSON: JSON.stringify(defaults.args),
      AEGISPY_MICROVM_WORKER_BINARY: defaults.workerBinaryPath,
      AEGISPY_MICROVM_WORKER_COMMAND: defaults.command,
    },
    backend: {
      mode,
      backendName: "microvm-launcher",
      available: true,
      reason: null,
    },
  };
}
