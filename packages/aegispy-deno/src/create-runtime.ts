import {
  createRuntime as createCoreRuntime,
  type AegisPyRuntime,
  type CreateRuntimeOptions,
} from "@aegispy/core";

export async function createRuntime(
  opts: CreateRuntimeOptions,
): Promise<AegisPyRuntime> {
  void opts;
  return createCoreRuntime({ host: "deno" });
}
