import type { RunRequest } from "@aegispy/core";
import { createNodeRuntime } from "../runtime/node-runtime";

export interface SelfTestResult {
  ok: boolean;
  termination: string;
  stdoutUtf8: string;
  errorCode: string | null;
}

export async function runSelfTest(): Promise<SelfTestResult> {
  const runtime = await createNodeRuntime({ host: "node" });
  const request: RunRequest = {
    host: "node",
    code: 'print("selftest")',
    argv: ["python"],
    stdinUtf8: "",
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    limits: {
      time: {
        wallMs: 100,
        cpuMs: 100,
      },
      bytes: {
        memoryBytes: 1024 * 1024,
        stdoutBytes: 1024,
        stderrBytes: 1024,
      },
    },
    determinism: {
      enabled: true,
      epochMs: 100,
      rngSeedHex: "1234abcd",
    },
  };

  const result = await runtime.run(request);
  await runtime.close();

  if (result.status === "error") {
    return {
      ok: false,
      termination: result.meta.termination,
      stdoutUtf8: result.stdoutUtf8,
      errorCode: result.error.code,
    };
  }

  return {
    ok: result.status === "ok",
    termination: result.meta.termination,
    stdoutUtf8: result.stdoutUtf8,
    errorCode: null,
  };
}
