import { createHash } from "node:crypto";

export type DependencyKind = "pure_python" | "native_platform" | "native_wasm";

export interface DependencyInput {
  name: string;
  version: string;
  kind: DependencyKind;
}

export interface RegistryConfig {
  pythonIndex: string;
  nativeIndex: string;
}

export interface LockfileEntry {
  name: string;
  version: string;
  kind: DependencyKind;
  artifactUrl: string;
  sha256: string;
}

export interface Lockfile {
  version: 1;
  generatedAt: string;
  entries: LockfileEntry[];
}

export interface ResolveLockfileInput {
  dependencies: DependencyInput[];
  registries?: Partial<RegistryConfig>;
  generatedAt?: string;
}

const defaultRegistries: RegistryConfig = {
  pythonIndex: "https://pypi.org/simple",
  nativeIndex: "https://registry.aegispy.dev/wasm",
};

function cleanUrl(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function isNativeDependencyKind(kind: DependencyKind): boolean {
  return kind === "native_platform" || kind === "native_wasm";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function entryUrl(registry: string, dependency: DependencyInput): string {
  const index = cleanUrl(registry);
  return `${index}/${dependency.name}/${dependency.version}/${dependency.name}-${dependency.version}.whl`;
}

export function resolveLockfile(input: ResolveLockfileInput): Lockfile {
  const registries: RegistryConfig = {
    pythonIndex: input.registries?.pythonIndex ?? defaultRegistries.pythonIndex,
    nativeIndex: input.registries?.nativeIndex ?? defaultRegistries.nativeIndex,
  };

  const entries = input.dependencies.map((dependency) => {
    const registry = isNativeDependencyKind(dependency.kind)
      ? registries.nativeIndex
      : registries.pythonIndex;
    const artifactUrl = entryUrl(registry, dependency);
    return {
      name: dependency.name,
      version: dependency.version,
      kind: dependency.kind,
      artifactUrl,
      sha256: digest(`${dependency.name}@${dependency.version}:${artifactUrl}`),
    };
  });

  return {
    version: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    entries,
  };
}

export function verifyLockfile(lockfile: Lockfile): {
  ok: boolean;
  failures: string[];
} {
  const failures: string[] = [];

  for (const entry of lockfile.entries) {
    const expected = digest(
      `${entry.name}@${entry.version}:${entry.artifactUrl}`,
    );
    if (entry.sha256 !== expected) {
      failures.push(`hash_mismatch:${entry.name}@${entry.version}`);
    }
    if (!entry.artifactUrl.startsWith("https://")) {
      failures.push(`url_scheme_invalid:${entry.name}@${entry.version}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}

export function enforcesNativeRegistry(
  lockfile: Lockfile,
  nativeIndex: string,
): { ok: boolean; failures: string[] } {
  const cleaned = cleanUrl(nativeIndex);
  const failures: string[] = [];

  for (const entry of lockfile.entries) {
    if (!isNativeDependencyKind(entry.kind)) continue;
    if (!entry.artifactUrl.startsWith(cleaned)) {
      failures.push(`native_registry_violation:${entry.name}@${entry.version}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}
