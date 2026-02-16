import {
  createRuntime as createCoreRuntime,
  type AegisPyRuntime,
  type CreateRuntimeOptions,
} from "@aegispy/core";

export async function createRuntime(
  opts: CreateRuntimeOptions,
): Promise<AegisPyRuntime> {
  return createCoreRuntime(opts);
}
