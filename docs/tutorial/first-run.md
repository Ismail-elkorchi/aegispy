# First Run

This tutorial shows the runtime shape a consumer integrates against. The
examples use the host-specific package matching the target environment.

## Minimal Example

```ts
import { createRuntime } from "@aegispy/node";

const runtime = await createRuntime({ host: "node" });

const result = await runtime.run({
  host: "node",
  code: 'print("hello from aegispy")',
  argv: ["python"],
  stdinUtf8: "",
  permissions: {
    fs: null,
    http: null,
    env: null,
  },
  limits: {
    time: {
      wallMs: 1000,
      cpuMs: 1000,
    },
    bytes: {
      memoryBytes: 1024 * 1024,
      stdoutBytes: 1024,
      stderrBytes: 1024,
    },
  },
  determinism: {
    enabled: true,
    epochMs: 42,
    rngSeedHex: "0badc0de",
  },
});

console.log(result.status, result.stdoutUtf8);
await runtime.close();
```

## What Changes By Host

- `node`, `deno`, and `bun` use the `server-hardened` profile and default to
  the real process/WASI/component runtime path.
- `browser` uses the `browser-subset` profile and keeps the same request/result
  contract while rejecting unsupported capabilities.

## What To Read Next

- Choose a host profile: `docs/how-to/choose-a-host.md`
- Understand the runtime surface: `docs/reference/runtime-api.md`
- See supported host behavior: `docs/support-matrix.md`
