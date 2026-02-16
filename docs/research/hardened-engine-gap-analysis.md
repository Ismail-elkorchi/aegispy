# Hardened Engine Gap Analysis

Date: 2026-02-16

## Objective

Define the exact gaps between current AegisPy behavior and a hardened real-engine runtime for untrusted coding-agent execution.

## Verified Internal Gaps

- Node default runtime path uses in-process simulation when transport override is absent.
- Core runtime factory includes simulated runtime execution.
- Engine build scripts emit stub payload artifacts.
- Rust worker executes simulated logic, not real CPython engine code.

## External Security Baseline

- Python documents WebAssembly platform constraints: https://docs.python.org/3/library/intro.html#webassembly-platforms
- Python audit hook interface: https://docs.python.org/3/library/sys.html#sys.addaudithook
- PEP 578 audit model: https://peps.python.org/pep-0578/
- Wasmtime security model: https://docs.wasmtime.dev/security.html
- Firecracker production isolation guidance: https://raw.githubusercontent.com/firecracker-microvm/firecracker/main/docs/prod-host-setup.md
- Linux seccomp: https://man7.org/linux/man-pages/man2/seccomp.2.html
- Linux namespaces: https://man7.org/linux/man-pages/man7/namespaces.7.html
- Linux rlimit: https://man7.org/linux/man-pages/man2/getrlimit.2.html
- Linux Landlock: https://man7.org/linux/man-pages/man7/landlock.7.html
- Linux cgroup v2: https://docs.kernel.org/admin-guide/cgroup-v2.html

## Required Engineering Changes

1. Real interpreter path

- Replace simulation-default execution with real CPython engine execution in server and browser paths.

2. Enforced isolation profile

- Bind worker execution to seccomp, namespace, cgroup, and rlimit controls.
- Add microVM execution profile for hostile multi-tenant workloads.

3. Capability boundary enforcement

- Bind policy gates to real runtime resource handles for filesystem, network, and environment access.

4. Determinism and replay

- Implement runtime clock and RNG controls with replay hash receipts.

5. Supply-chain integrity

- Produce SBOM and signed provenance for released engine artifacts.

6. Adversarial testing

- Gate releases on protocol fuzzing and sandbox escape regression suites.

## Claim Publication Rule

A security or hardening claim is valid only when implementation, tests, and generated evidence artifacts all exist in release gates.
