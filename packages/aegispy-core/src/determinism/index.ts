import type { DeterminismConfig, RunResult } from "../contracts/types";

function nextByte(seed: number): number {
  let x = seed >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

export function makeDeterministicRng(seedHex: string): () => number {
  const parsed = Number.parseInt(seedHex.slice(0, 8), 16);
  let state = Number.isFinite(parsed) ? parsed >>> 0 : 1;
  if (state === 0) state = 1;

  return () => {
    state = nextByte(state);
    return state / 0xffffffff;
  };
}

export function deterministicTimestamp(
  config: DeterminismConfig,
  step: number,
): number {
  return config.epochMs + step;
}

export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  const normalized = hash >>> 0;
  return normalized.toString(16).padStart(8, "0");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  );
  return `{${parts.join(",")}}`;
}

export function computeReplayHash(result: RunResult): string {
  return fnv1a32(
    stableStringify({
      status: result.status,
      exitCode: result.exitCode,
      stdoutUtf8: result.stdoutUtf8,
      stderrUtf8: result.stderrUtf8,
      termination: result.meta.termination,
      errorCode: result.status === "error" ? result.error.code : null,
    }),
  );
}
