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

  const parsed = parseJsonStringArray(raw);
  if (!parsed.ok) {
    return {
      args: [],
      reason: parsed.reason,
    };
  }

  return { args: parsed.value, reason: null };
}

function parseJsonStringArray(
  raw: string,
): { ok: true; value: string[] } | { ok: false; reason: string } {
  let index = 0;
  const value: string[] = [];

  const fail = (reason: string): { ok: false; reason: string } => ({
    ok: false,
    reason,
  });

  const skipWhitespace = (): void => {
    while (index < raw.length && /\s/.test(raw[index]!)) {
      index += 1;
    }
  };

  const readHexDigits = (): string | null => {
    const chunk = raw.slice(index, index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(chunk)) return null;
    index += 4;
    return chunk;
  };

  const readString = (): string | null => {
    if (raw[index] !== '"') return null;
    index += 1;
    let out = "";

    while (index < raw.length) {
      const ch = raw[index]!;
      index += 1;

      if (ch === '"') return out;
      if (ch !== "\\") {
        out += ch;
        continue;
      }

      if (index >= raw.length) return null;
      const escape = raw[index]!;
      index += 1;

      if (escape === '"' || escape === "\\" || escape === "/") {
        out += escape;
        continue;
      }
      if (escape === "b") {
        out += "\b";
        continue;
      }
      if (escape === "f") {
        out += "\f";
        continue;
      }
      if (escape === "n") {
        out += "\n";
        continue;
      }
      if (escape === "r") {
        out += "\r";
        continue;
      }
      if (escape === "t") {
        out += "\t";
        continue;
      }
      if (escape === "u") {
        const hex = readHexDigits();
        if (hex === null) return null;
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        continue;
      }
      return null;
    }

    return null;
  };

  skipWhitespace();
  if (raw[index] !== "[") {
    return fail(
      "invalid AEGISPY_MICROVM_LAUNCHER_ARGS_JSON, expected a JSON string array",
    );
  }
  index += 1;
  skipWhitespace();

  if (raw[index] === "]") {
    index += 1;
    skipWhitespace();
    return index === raw.length
      ? { ok: true, value }
      : fail(
          "invalid AEGISPY_MICROVM_LAUNCHER_ARGS_JSON, expected a JSON string array",
        );
  }

  while (index < raw.length) {
    const item = readString();
    if (item === null) {
      return fail(
        "invalid AEGISPY_MICROVM_LAUNCHER_ARGS_JSON, expected a JSON string array",
      );
    }
    value.push(item);
    skipWhitespace();

    if (raw[index] === ",") {
      index += 1;
      skipWhitespace();
      continue;
    }
    if (raw[index] === "]") {
      index += 1;
      skipWhitespace();
      return index === raw.length
        ? { ok: true, value }
        : fail(
            "invalid AEGISPY_MICROVM_LAUNCHER_ARGS_JSON, expected a JSON string array",
          );
    }
    return fail(
      "invalid AEGISPY_MICROVM_LAUNCHER_ARGS_JSON, expected a JSON string array",
    );
  }

  return fail(
    "invalid AEGISPY_MICROVM_LAUNCHER_ARGS_JSON, expected a JSON string array",
  );
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
