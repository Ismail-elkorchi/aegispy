import { makeAegisPyError } from "../errors";
import type {
  AegisPyRuntime,
  CreateRuntimeOptions,
  HostKind,
} from "../contracts/types";

export type RuntimeFactory = (
  opts: CreateRuntimeOptions,
) => Promise<AegisPyRuntime>;

const runtimeFactories = new Map<HostKind, RuntimeFactory>();

export function registerRuntimeFactory(
  host: HostKind,
  factory: RuntimeFactory,
): void {
  runtimeFactories.set(host, factory);
}

export async function createRuntime(
  opts: CreateRuntimeOptions,
): Promise<AegisPyRuntime> {
  const factory = runtimeFactories.get(opts.host);
  if (!factory) {
    throw makeAegisPyError("AEG-UNSUPPORTED-HOST", "unsupported host", {
      host: opts.host,
    });
  }
  return factory(opts);
}
