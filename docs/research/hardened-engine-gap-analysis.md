# Hardened Engine Gap Analysis

Date: 2026-03-16

## Objective

Define the remaining public gaps between current AegisPy behavior and the
target hardening posture for untrusted coding-agent execution.

## Verified Current State

- `node`, `deno`, and `bun` default to process transport backed by the Rust worker.
- The worker defaults to the WASI executor and the `component-wit` capability channel.
- Real-execution, capability-binding, and profile-conformance evidence artifacts are present.
- The browser profile now uses an experimental real-engine worker path with explicit capability limits.

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

## Remaining Public Gaps

1. Compatibility corpus breadth

- Broaden the generated workload matrix and reason-code coverage across all hosts.
- Keep pure-Python package fixture metadata explicit and pinned until runtime package loading becomes part of the public contract.

2. Enforced isolation profile

- Deepen worker execution enforcement for seccomp, namespace, cgroup, and rlimit controls.
- Add microVM execution profile for hostile multi-tenant workloads.

3. Capability boundary enforcement

- Extend runtime-bound policy coverage across the supported capability surface and keep audits stable.

4. Determinism and replay

- Expand deterministic replay coverage from targeted proofs into a larger compatibility corpus.

5. Supply-chain integrity

- Keep SBOM and signed provenance verification in the mandatory release path.

6. Adversarial testing

- Gate releases on protocol fuzzing and sandbox escape regression suites.

## Claim Publication Rule

A security or hardening claim is valid only when implementation, tests, and generated evidence artifacts all exist in release gates.
