import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type AegisPyRuntime } from "../src/index";
import { createRuntime as createNodeRuntime } from "../../aegispy-node/src/index";
import { createRuntime as createDenoRuntime } from "../../aegispy-deno/src/index";
import { createBrowserRuntime } from "../../aegispy-browser/src/index";
import { resolveLockfile, verifyLockfile } from "../../aegispy-pack/src/index";
import type { HostKind, RunRequest, RunResult } from "@aegispy/core";
import { writeArtifact } from "./helpers/artifact";

const originalEnv = { ...process.env };
const corpusEnvValue = "agent-corpus-env-ok";
const allHosts = ["node", "deno", "bun", "browser"] as const;

type CorpusHost = (typeof allHosts)[number];

type CompatibilityExpectation = "supported" | "unsupported-by-profile";
type WorkloadFamily =
  | "core-stdlib"
  | "text-stdlib"
  | "data-stdlib"
  | "numeric-stdlib"
  | "capability-fs"
  | "capability-http"
  | "capability-env"
  | "policy"
  | "resource-limits";

interface CaseCheck {
  pass: boolean;
  expectation: CompatibilityExpectation;
  exceptionTag: string | null;
  reasonCode: string;
}

interface CorpusCase {
  caseId: string;
  family: WorkloadFamily;
  description: string;
  code: string;
  permissions: RunRequest["permissions"];
  tags?: string[];
  configureRequest?: (request: RunRequest) => void;
  validateServer: (result: RunResult) => CaseCheck;
  validateBrowser: (result: RunResult) => CaseCheck;
}

interface CaseOutcome {
  status: RunResult["status"];
  termination: RunResult["meta"]["termination"];
  errorCode: string | null;
  capabilityChannel: string | null;
  pass: boolean;
  expectation: CompatibilityExpectation;
  exceptionTag: string | null;
  reasonCode: string;
}

interface CompatibilityFailure {
  caseId: string;
  host: CorpusHost;
  reasonCode: string;
}

interface CompatibilityFailures {
  supported: CompatibilityFailure[];
  unsupportedByProfile: CompatibilityFailure[];
}

interface CorpusCaseResult {
  caseId: string;
  family: WorkloadFamily;
  description: string;
  tags: string[];
  results: Record<CorpusHost, CaseOutcome>;
}

type PackageFixtureCoverage = "metadata-only" | "browser-executed";

interface PackageFixtureExecutionPlan {
  host: "browser";
  packages: string[];
  code: string;
  expectedStdout: string;
}

interface PackageFixtureExecutionProof {
  host: "browser";
  packages: string[];
  ok: boolean;
  reasonCode: string;
  stdoutUtf8: string;
  stderrUtf8: string;
}

interface PackageFixture {
  fixtureId: string;
  coverageBasis: PackageFixtureCoverage;
  description: string;
  lockfile: ReturnType<typeof resolveLockfile>;
  verification: ReturnType<typeof verifyLockfile>;
  executionPlan?: PackageFixtureExecutionPlan;
}

interface PackageFixtureSummary {
  fixtureId: string;
  coverageBasis: PackageFixtureCoverage;
  description: string;
  dependencyCount: number;
  lockfile: ReturnType<typeof resolveLockfile>;
  verification: ReturnType<typeof verifyLockfile>;
  execution: PackageFixtureExecutionProof | null;
}

const workloadFamilies: Record<WorkloadFamily, { description: string }> = {
  "core-stdlib": {
    description:
      "Basic deterministic Python execution without host capabilities.",
  },
  "text-stdlib": {
    description: "Pure-stdlib text and Unicode processing workloads.",
  },
  "data-stdlib": {
    description: "Pure-stdlib JSON, hashing, and structured data workloads.",
  },
  "numeric-stdlib": {
    description: "Pure-stdlib numeric and exact-arithmetic workloads.",
  },
  "capability-fs": {
    description:
      "Filesystem workloads that require explicit capability grants.",
  },
  "capability-http": {
    description:
      "HTTP capability-grant workloads without live network dependence.",
  },
  "capability-env": {
    description:
      "Environment-read workloads that require explicit capability grants.",
  },
  policy: {
    description: "Denied-by-default capability and traversal policy workloads.",
  },
  "resource-limits": {
    description: "Workloads that must terminate through resource enforcement.",
  },
};

const compatibilityReasonCodes = {
  supported: {
    expectation: "supported",
    description: "The host satisfied the workload contract as expected.",
  },
  stdout_missing: {
    expectation: "supported",
    description:
      "The host completed the workload but the expected stdout was missing.",
  },
  deterministic_lines_missing: {
    expectation: "supported",
    description:
      "The host did not emit the deterministic time and RNG lines required by the workload.",
  },
  stdlib_digest_missing: {
    expectation: "supported",
    description: "The host did not emit the expected stdlib digest output.",
  },
  browser_engine_timeout: {
    expectation: "supported",
    description:
      "The browser real-engine path timed out before completing the workload.",
  },
  browser_engine_error: {
    expectation: "supported",
    description:
      "The browser real-engine path returned an engine error for the workload.",
  },
  env_value_missing: {
    expectation: "supported",
    description: "The host did not return the expected environment value.",
  },
  unsupported_browser_capability: {
    expectation: "unsupported-by-profile",
    description:
      "The browser profile correctly rejected a workload that requires an unsupported capability.",
  },
  unsupported_browser_capability_missing: {
    expectation: "unsupported-by-profile",
    description:
      "The browser profile failed to reject an unsupported-capability workload with the expected error.",
  },
  policy_denied_expected: {
    expectation: "supported",
    description:
      "The runtime correctly denied the workload through policy enforcement.",
  },
  policy_denied_missing: {
    expectation: "supported",
    description:
      "The runtime failed to deny the workload through policy enforcement.",
  },
  output_limit_expected: {
    expectation: "supported",
    description:
      "The runtime correctly enforced the configured output limit for the workload.",
  },
  output_limit_missing: {
    expectation: "supported",
    description:
      "The runtime failed to enforce the configured output limit for the workload.",
  },
  capability_channel_not_component_wit: {
    expectation: "supported",
    description:
      "A server host did not report the required component-wit capability channel.",
  },
  timeout_expected: {
    expectation: "supported",
    description:
      "The runtime correctly enforced the configured wall-clock timeout for the workload.",
  },
  timeout_missing: {
    expectation: "supported",
    description:
      "The runtime failed to enforce the configured wall-clock timeout for the workload.",
  },
} as const;

function makePackageFixture(
  fixtureId: string,
  description: string,
  dependencies: Array<{
    name: string;
    version: string;
    kind: "pure_python";
  }>,
): PackageFixture {
  const lockfile = resolveLockfile({
    dependencies,
    generatedAt: "2026-03-16T00:00:00.000Z",
  });
  return {
    fixtureId,
    coverageBasis: "metadata-only",
    description,
    lockfile,
    verification: verifyLockfile(lockfile),
  };
}

function makeBrowserExecutedPackageFixture(
  fixtureId: string,
  description: string,
  dependencies: Array<{
    name: string;
    version: string;
    kind: "pure_python";
  }>,
  executionPlan: PackageFixtureExecutionPlan,
): PackageFixture {
  const lockfile = resolveLockfile({
    dependencies,
    generatedAt: "2026-03-16T00:00:00.000Z",
  });
  return {
    fixtureId,
    coverageBasis: "browser-executed",
    description,
    lockfile,
    verification: verifyLockfile(lockfile),
    executionPlan,
  };
}

const packageFixtures: PackageFixture[] = [
  makePackageFixture(
    "pure-python-text-tooling",
    "Pinned metadata fixture for template and text-processing libraries.",
    [
      { name: "jinja2", version: "3.1.4", kind: "pure_python" },
      { name: "markupsafe", version: "2.1.5", kind: "pure_python" },
    ],
  ),
  makePackageFixture(
    "pure-python-data-tooling",
    "Pinned metadata fixture for configuration and data-shaping libraries.",
    [
      { name: "pyyaml", version: "6.0.2", kind: "pure_python" },
      { name: "attrs", version: "24.2.0", kind: "pure_python" },
    ],
  ),
  makeBrowserExecutedPackageFixture(
    "browser-micropip-import",
    "Verified browser package import proof for the bundled Pyodide micropip package.",
    [{ name: "micropip", version: "0.10.1", kind: "pure_python" }],
    {
      host: "browser",
      packages: ["micropip"],
      code: ["import micropip", "print(micropip.__name__)"].join("\n"),
      expectedStdout: "micropip",
    },
  ),
];

function supportedCheck(pass: boolean, failureReasonCode: string): CaseCheck {
  return {
    pass,
    expectation: "supported",
    exceptionTag: null,
    reasonCode: pass ? "supported" : failureReasonCode,
  };
}

function unsupportedBrowserCapabilityCheck(result: RunResult): CaseCheck {
  const pass =
    result.status === "error" && errorCode(result) === "AEG-UNSUPPORTED-HOST";
  return {
    pass,
    expectation: "unsupported-by-profile",
    exceptionTag: pass ? "browser-capability-limited" : null,
    reasonCode: pass
      ? "unsupported_browser_capability"
      : "unsupported_browser_capability_missing",
  };
}

function runtimeView(runtime: AegisPyRuntime): {
  transportKind?: string;
  isolationProfile?: unknown;
  executionMode?: string | null;
  executionBackend?: {
    available?: boolean;
    backendName?: string;
    reason?: string | null;
  } | null;
} {
  return runtime as unknown as {
    transportKind?: string;
    isolationProfile?: unknown;
    executionMode?: string | null;
    executionBackend?: {
      available?: boolean;
      backendName?: string;
      reason?: string | null;
    } | null;
  };
}

function capabilityChannel(result: RunResult): string | null {
  const audit = result.meta.audit as Array<{
    kind: string;
    detailJson: string;
  }>;
  const event = audit.find((entry) => entry.kind === "runtime_channel");
  if (!event) return null;
  const prefix = "capability_channel:";
  if (!event.detailJson.startsWith(prefix)) return null;
  return event.detailJson.slice(prefix.length) || null;
}

function auditKinds(result: RunResult): string[] {
  return (result.meta.audit as Array<{ kind: string }>).map(
    (entry) => entry.kind,
  );
}

function errorCode(result: RunResult): string | null {
  return result.status === "error" ? result.error.code : null;
}

function isPolicyDenied(result: RunResult): boolean {
  return (
    result.status === "error" &&
    result.meta.termination === "policy_denied" &&
    errorCode(result) === "AEG-POLICY-DENIED"
  );
}

function isOutputLimitDenied(result: RunResult): boolean {
  return (
    result.status === "error" &&
    result.meta.termination === "output_limit" &&
    errorCode(result) === "AEG-OUTPUT-LIMIT"
  );
}

function isTimeoutDenied(result: RunResult): boolean {
  return (
    result.status === "error" &&
    result.meta.termination === "timeout" &&
    errorCode(result) === "AEG-TIMEOUT"
  );
}

function makeRequest(host: HostKind, code: string): RunRequest {
  return {
    host,
    code,
    argv: ["python"],
    stdinUtf8: "",
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    limits: {
      time: {
        wallMs: 3000,
        cpuMs: 3000,
      },
      bytes: {
        memoryBytes: 64 * 1024 * 1024,
        stdoutBytes: 512 * 1024,
        stderrBytes: 512 * 1024,
      },
    },
    determinism: {
      enabled: true,
      epochMs: 19,
      rngSeedHex: "0a0b0c0d",
    },
  };
}

function collectCompatibilityFailures(
  caseResults: CorpusCaseResult[],
): CompatibilityFailures {
  const supported: CompatibilityFailure[] = [];
  const unsupportedByProfile: CompatibilityFailure[] = [];

  for (const entry of caseResults) {
    for (const host of allHosts) {
      const result = entry.results[host];
      if (result.pass) continue;

      const failure = {
        caseId: entry.caseId,
        host,
        reasonCode: result.reasonCode,
      };

      if (result.expectation === "supported") {
        supported.push(failure);
      } else {
        unsupportedByProfile.push(failure);
      }
    }
  }

  return { supported, unsupportedByProfile };
}

function isCompatibilityCorpusOk(
  failures: CompatibilityFailures,
  packageFixturesOk: boolean,
): boolean {
  return (
    packageFixturesOk &&
    failures.supported.length === 0 &&
    failures.unsupportedByProfile.length === 0
  );
}

async function summarizePackageFixture(
  fixture: PackageFixture,
): Promise<PackageFixtureSummary> {
  const summary: PackageFixtureSummary = {
    fixtureId: fixture.fixtureId,
    coverageBasis: fixture.coverageBasis,
    description: fixture.description,
    dependencyCount: fixture.lockfile.entries.length,
    lockfile: fixture.lockfile,
    verification: fixture.verification,
    execution: null,
  };

  if (
    fixture.coverageBasis !== "browser-executed" ||
    fixture.executionPlan === undefined
  ) {
    return summary;
  }
  const executionPlan = fixture.executionPlan;

  const runtime = await createBrowserRuntime({
    packages: executionPlan.packages,
    packageLockfile: fixture.lockfile,
  });

  return runtime
    .run(makeRequest(executionPlan.host, executionPlan.code))
    .then((result) => {
      const ok =
        result.status === "ok" &&
        result.stdoutUtf8.includes(executionPlan.expectedStdout);
      summary.execution = {
        host: executionPlan.host,
        packages: [...executionPlan.packages],
        ok,
        reasonCode: ok
          ? "supported"
          : result.meta.termination === "engine_error"
            ? "browser_engine_error"
            : result.meta.termination === "timeout"
              ? "browser_engine_timeout"
              : "stdout_missing",
        stdoutUtf8: result.stdoutUtf8,
        stderrUtf8: result.stderrUtf8,
      };
      return summary;
    })
    .finally(async () => {
      await runtime.close();
    });
}

function arePackageFixturesOk(fixtures: PackageFixtureSummary[]): boolean {
  const hasExecutionBackedFixture = fixtures.some(
    (fixture) => fixture.coverageBasis === "browser-executed",
  );
  return (
    hasExecutionBackedFixture &&
    fixtures.every((fixture) => {
      if (!fixture.verification.ok) {
        return false;
      }
      if (fixture.coverageBasis === "browser-executed") {
        return fixture.execution?.ok === true;
      }
      return fixture.execution === null;
    })
  );
}

const corpusCases: CorpusCase[] = [
  {
    caseId: "simple-print",
    family: "core-stdlib",
    description: "basic print execution",
    code: 'print("agent-corpus-print")',
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass =
        result.status === "ok" &&
        result.stdoutUtf8.includes("agent-corpus-print");
      return supportedCheck(pass, "stdout_missing");
    },
    validateBrowser(result) {
      const pass =
        result.status === "ok" &&
        result.stdoutUtf8.includes("agent-corpus-print");
      return supportedCheck(pass, "stdout_missing");
    },
  },
  {
    caseId: "deterministic-time-rng",
    family: "core-stdlib",
    description: "deterministic time and rng signals",
    code: "print(time.time())\nprint(random.random())",
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const lines = result.stdoutUtf8
        .trim()
        .split(/\r?\n/u)
        .filter((line) => line.length > 0);
      const pass = result.status === "ok" && lines.length >= 2;
      return supportedCheck(pass, "deterministic_lines_missing");
    },
    validateBrowser(result) {
      const lines = result.stdoutUtf8
        .trim()
        .split(/\r?\n/u)
        .filter((line) => line.length > 0);
      const pass = result.status === "ok" && lines.length >= 2;
      return supportedCheck(pass, "deterministic_lines_missing");
    },
  },
  {
    caseId: "pathlib-pure-path",
    family: "core-stdlib",
    description: "pure pathlib path-join workload",
    code: [
      "from pathlib import PurePosixPath",
      'path = PurePosixPath("/sandbox/write").joinpath("nested", "file.txt")',
      "print(path)",
    ].join("\n"),
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass =
        result.status === "ok" &&
        result.stdoutUtf8.includes("/sandbox/write/nested/file.txt");
      return supportedCheck(pass, "stdout_missing");
    },
    validateBrowser(result) {
      const pass =
        result.status === "ok" &&
        result.stdoutUtf8.includes("/sandbox/write/nested/file.txt");
      return supportedCheck(pass, "stdout_missing");
    },
  },
  {
    caseId: "stdlib-json-hash",
    family: "data-stdlib",
    description: "stdlib json/hashlib workload",
    code: [
      "import json",
      "import hashlib",
      'payload = json.dumps({"answer": 42, "tags": ["a", "b"]}, sort_keys=True)',
      "print(hashlib.sha256(payload.encode()).hexdigest())",
    ].join("\n"),
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const digest = result.stdoutUtf8.trim();
      const pass = result.status === "ok" && /^[0-9a-f]{64}$/u.test(digest);
      return supportedCheck(pass, "stdlib_digest_missing");
    },
    validateBrowser(result) {
      if (result.status !== "ok") {
        return {
          pass: false,
          expectation: "supported",
          exceptionTag: null,
          reasonCode:
            result.meta.termination === "timeout"
              ? "browser_engine_timeout"
              : "browser_engine_error",
        };
      }
      const digest = result.stdoutUtf8.trim();
      if (/^[0-9a-f]{64}$/u.test(digest)) {
        return supportedCheck(true, "stdlib_digest_missing");
      }
      return supportedCheck(false, "stdlib_digest_missing");
    },
  },
  {
    caseId: "csv-dictreader-roundtrip",
    family: "data-stdlib",
    description: "stdlib csv parsing workload",
    code: [
      "import csv",
      "import io",
      'data = io.StringIO("name,value\\nalpha,1\\nbeta,2\\n")',
      "rows = list(csv.DictReader(data))",
      'print(rows[0]["name"] + "-" + rows[1]["value"])',
    ].join("\n"),
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass =
        result.status === "ok" && result.stdoutUtf8.includes("alpha-2");
      return supportedCheck(pass, "stdout_missing");
    },
    validateBrowser(result) {
      const pass =
        result.status === "ok" && result.stdoutUtf8.includes("alpha-2");
      return supportedCheck(pass, "stdout_missing");
    },
  },
  {
    caseId: "collections-counter",
    family: "data-stdlib",
    description: "stdlib collections counting workload",
    code: [
      "from collections import Counter",
      'print(Counter("mississippi")["s"])',
    ].join("\n"),
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass = result.status === "ok" && result.stdoutUtf8.includes("4");
      return supportedCheck(pass, "stdout_missing");
    },
    validateBrowser(result) {
      const pass = result.status === "ok" && result.stdoutUtf8.includes("4");
      return supportedCheck(pass, "stdout_missing");
    },
  },
  {
    caseId: "text-regex-unicode",
    family: "text-stdlib",
    description: "stdlib text normalization and regex workload",
    code: [
      "import re",
      "import unicodedata",
      'value = unicodedata.normalize("NFKD", "cafe\\u0301")',
      'print(re.sub(r"[^a-z]", "", value.lower()))',
    ].join("\n"),
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass = result.status === "ok" && result.stdoutUtf8.includes("cafe");
      return supportedCheck(pass, "stdout_missing");
    },
    validateBrowser(result) {
      const pass = result.status === "ok" && result.stdoutUtf8.includes("cafe");
      return supportedCheck(pass, "stdout_missing");
    },
  },
  {
    caseId: "textwrap-shlex",
    family: "text-stdlib",
    description: "stdlib text wrapping and shell tokenization workload",
    code: [
      "import shlex",
      "import textwrap",
      'print("|".join(shlex.split(\'cmd --name "agent corpus"\')))',
      'print(textwrap.fill("alpha beta gamma delta", width=10).replace("\\n", "|"))',
    ].join("\n"),
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass =
        result.status === "ok" &&
        result.stdoutUtf8.includes("cmd|--name|agent corpus") &&
        result.stdoutUtf8.includes("alpha beta|gamma|delta");
      return supportedCheck(pass, "stdout_missing");
    },
    validateBrowser(result) {
      const pass =
        result.status === "ok" &&
        result.stdoutUtf8.includes("cmd|--name|agent corpus") &&
        result.stdoutUtf8.includes("alpha beta|gamma|delta");
      return supportedCheck(pass, "stdout_missing");
    },
  },
  {
    caseId: "numeric-decimal-fractions",
    family: "numeric-stdlib",
    description: "stdlib exact-arithmetic workload",
    code: [
      "from decimal import Decimal",
      "from fractions import Fraction",
      'value = Decimal("0.125") + Decimal(Fraction(1, 8).numerator) / Decimal(Fraction(1, 8).denominator)',
      "print(value)",
    ].join("\n"),
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass =
        result.status === "ok" && result.stdoutUtf8.includes("0.250");
      return supportedCheck(pass, "stdout_missing");
    },
    validateBrowser(result) {
      const pass =
        result.status === "ok" && result.stdoutUtf8.includes("0.250");
      return supportedCheck(pass, "stdout_missing");
    },
  },
  {
    caseId: "statistics-fmean",
    family: "numeric-stdlib",
    description: "stdlib statistics workload",
    code: [
      "import statistics",
      'print(f"{statistics.fmean([0.25, 0.5, 0.75]):.2f}")',
    ].join("\n"),
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass = result.status === "ok" && result.stdoutUtf8.includes("0.50");
      return supportedCheck(pass, "stdout_missing");
    },
    validateBrowser(result) {
      const pass = result.status === "ok" && result.stdoutUtf8.includes("0.50");
      return supportedCheck(pass, "stdout_missing");
    },
  },
  {
    caseId: "filesystem-roundtrip",
    family: "capability-fs",
    description: "filesystem capability roundtrip",
    code: [
      'path = "/sandbox/write/agent-corpus.txt"',
      'aegispy.fs_write(path, "agent-corpus-fs")',
      "print(aegispy.fs_read(path))",
    ].join("\n"),
    permissions: {
      fs: {
        readRoots: ["/sandbox/write"],
        writeRoots: ["/sandbox/write"],
        maxBytes: 4096,
        maxFiles: 8,
      },
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass =
        result.status === "ok" && result.stdoutUtf8.includes("agent-corpus-fs");
      return supportedCheck(pass, "stdout_missing");
    },
    validateBrowser(result) {
      return unsupportedBrowserCapabilityCheck(result);
    },
  },
  {
    caseId: "http-capability-granted",
    family: "capability-http",
    description: "http capability grant without live network access",
    code: 'print("http-capability-ready")',
    permissions: {
      fs: null,
      http: {
        allowOrigins: ["https://example.test"],
        denyOrigins: [],
        maxRequests: 4,
        maxBytes: 4096,
      },
      env: null,
    },
    validateServer(result) {
      const pass =
        result.status === "ok" &&
        result.stdoutUtf8.includes("http-capability-ready");
      return supportedCheck(pass, "stdout_missing");
    },
    validateBrowser(result) {
      return unsupportedBrowserCapabilityCheck(result);
    },
  },
  {
    caseId: "env-read",
    family: "capability-env",
    description: "environment capability read",
    code: 'print(aegispy.env_get("AEGISPY_CORPUS_ENV"))',
    permissions: {
      fs: null,
      http: null,
      env: {
        allowKeys: ["AEGISPY_CORPUS_ENV"],
      },
    },
    validateServer(result) {
      const pass =
        result.status === "ok" && result.stdoutUtf8.includes(corpusEnvValue);
      return supportedCheck(pass, "env_value_missing");
    },
    validateBrowser(result) {
      return unsupportedBrowserCapabilityCheck(result);
    },
  },
  {
    caseId: "http-policy-deny",
    family: "policy",
    description: "deny-by-default http capability",
    code: 'aegispy.http_get("http://blocked.invalid/corpus")',
    tags: ["adversarial"],
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass = isPolicyDenied(result);
      return {
        pass,
        expectation: "supported",
        exceptionTag: null,
        reasonCode: pass ? "policy_denied_expected" : "policy_denied_missing",
      };
    },
    validateBrowser(result) {
      const pass = isPolicyDenied(result);
      return {
        pass,
        expectation: "supported",
        exceptionTag: null,
        reasonCode: pass ? "policy_denied_expected" : "policy_denied_missing",
      };
    },
  },
  {
    caseId: "fs-default-deny",
    family: "policy",
    description: "deny-by-default filesystem capability",
    code: 'aegispy.fs_read("/sandbox/read/corpus.txt")',
    tags: ["adversarial"],
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass = isPolicyDenied(result);
      return {
        pass,
        expectation: "supported",
        exceptionTag: null,
        reasonCode: pass ? "policy_denied_expected" : "policy_denied_missing",
      };
    },
    validateBrowser(result) {
      const pass = isPolicyDenied(result);
      return {
        pass,
        expectation: "supported",
        exceptionTag: null,
        reasonCode: pass ? "policy_denied_expected" : "policy_denied_missing",
      };
    },
  },
  {
    caseId: "fs-traversal-deny",
    family: "policy",
    description: "deny filesystem traversal payload",
    code: 'aegispy.fs_write("/sandbox/write/../escape.txt", "x")',
    tags: ["adversarial"],
    permissions: {
      fs: {
        readRoots: ["/sandbox/write"],
        writeRoots: ["/sandbox/write"],
        maxBytes: 4096,
        maxFiles: 8,
      },
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass = isPolicyDenied(result);
      return {
        pass,
        expectation: "supported",
        exceptionTag: null,
        reasonCode: pass ? "policy_denied_expected" : "policy_denied_missing",
      };
    },
    validateBrowser(result) {
      return unsupportedBrowserCapabilityCheck(result);
    },
  },
  {
    caseId: "env-default-deny",
    family: "policy",
    description: "deny-by-default environment capability",
    code: 'aegispy.env_get("AEGISPY_CORPUS_ENV")',
    tags: ["adversarial"],
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass = isPolicyDenied(result);
      return {
        pass,
        expectation: "supported",
        exceptionTag: null,
        reasonCode: pass ? "policy_denied_expected" : "policy_denied_missing",
      };
    },
    validateBrowser(result) {
      const pass = isPolicyDenied(result);
      return {
        pass,
        expectation: "supported",
        exceptionTag: null,
        reasonCode: pass ? "policy_denied_expected" : "policy_denied_missing",
      };
    },
  },
  {
    caseId: "timeout-abuse",
    family: "resource-limits",
    description: "deny a runaway cpu-bound workload through wall-clock timeout",
    code: ["while True:", "    pass"].join("\n"),
    tags: ["adversarial"],
    configureRequest(request) {
      request.limits.time.wallMs = 200;
      request.limits.time.cpuMs = 200;
    },
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass = isTimeoutDenied(result);
      return {
        pass,
        expectation: "supported",
        exceptionTag: null,
        reasonCode: pass ? "timeout_expected" : "timeout_missing",
      };
    },
    validateBrowser(result) {
      const pass = isTimeoutDenied(result);
      return {
        pass,
        expectation: "supported",
        exceptionTag: null,
        reasonCode: pass ? "timeout_expected" : "timeout_missing",
      };
    },
  },
  {
    caseId: "output-abuse",
    family: "resource-limits",
    description: "deny abusive stdout payload",
    code: "#aegispy:stdout=7000",
    tags: ["adversarial"],
    configureRequest(request) {
      request.limits.bytes.stdoutBytes = 64;
    },
    permissions: {
      fs: null,
      http: null,
      env: null,
    },
    validateServer(result) {
      const pass = isOutputLimitDenied(result);
      return {
        pass,
        expectation: "supported",
        exceptionTag: null,
        reasonCode: pass ? "output_limit_expected" : "output_limit_missing",
      };
    },
    validateBrowser(result) {
      const pass = isOutputLimitDenied(result);
      return {
        pass,
        expectation: "supported",
        exceptionTag: null,
        reasonCode: pass ? "output_limit_expected" : "output_limit_missing",
      };
    },
  },
];

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("bun adapter parity", () => {
  it("keeps the compatibility corpus breadth above the current floor", () => {
    expect(corpusCases.length).toBeGreaterThanOrEqual(18);
  });

  it("fails the corpus when a supported host workload fails", () => {
    const failures = collectCompatibilityFailures([
      {
        caseId: "synthetic-supported-failure",
        family: "data-stdlib",
        description: "synthetic supported host failure",
        tags: [],
        results: {
          node: {
            status: "error",
            termination: "policy_denied",
            errorCode: "AEG-POLICY-DENIED",
            capabilityChannel: "component-wit",
            pass: false,
            expectation: "supported",
            exceptionTag: null,
            reasonCode: "stdlib_digest_missing",
          },
          deno: {
            status: "ok",
            termination: "ok",
            errorCode: null,
            capabilityChannel: "component-wit",
            pass: true,
            expectation: "supported",
            exceptionTag: null,
            reasonCode: "supported",
          },
          bun: {
            status: "ok",
            termination: "ok",
            errorCode: null,
            capabilityChannel: "component-wit",
            pass: true,
            expectation: "supported",
            exceptionTag: null,
            reasonCode: "supported",
          },
          browser: {
            status: "error",
            termination: "policy_denied",
            errorCode: "AEG-UNSUPPORTED-HOST",
            capabilityChannel: "worker-timeout",
            pass: true,
            expectation: "unsupported-by-profile",
            exceptionTag: "browser-capability-limited",
            reasonCode: "unsupported_browser_capability",
          },
        },
      },
    ]);

    expect(failures.supported).toEqual([
      {
        caseId: "synthetic-supported-failure",
        host: "node",
        reasonCode: "stdlib_digest_missing",
      },
    ]);
    expect(failures.unsupportedByProfile).toEqual([]);
    expect(isCompatibilityCorpusOk(failures, true)).toBe(false);
  });

  it("requires browser-executed package fixtures to keep a passing run proof", () => {
    expect(
      arePackageFixturesOk([
        {
          fixtureId: "metadata-fixture",
          coverageBasis: "metadata-only",
          description: "metadata only",
          dependencyCount: 1,
          lockfile: resolveLockfile({
            dependencies: [
              {
                name: "attrs",
                version: "24.2.0",
                kind: "pure_python",
              },
            ],
            generatedAt: "2026-03-16T00:00:00.000Z",
          }),
          verification: { ok: true, failures: [] },
          execution: null,
        },
        {
          fixtureId: "browser-fixture",
          coverageBasis: "browser-executed",
          description: "browser executed",
          dependencyCount: 1,
          lockfile: resolveLockfile({
            dependencies: [
              {
                name: "micropip",
                version: "0.10.1",
                kind: "pure_python",
              },
            ],
            generatedAt: "2026-03-16T00:00:00.000Z",
          }),
          verification: { ok: true, failures: [] },
          execution: {
            host: "browser",
            packages: ["micropip"],
            ok: false,
            reasonCode: "browser_engine_error",
            stdoutUtf8: "",
            stderrUtf8: "engine error",
          },
        },
      ]),
    ).toBe(false);
  });

  it("defaults to process transport and matches node contract shape", async () => {
    process.env = { ...originalEnv };
    delete process.env.AEGISPY_BUN_TRANSPORT;

    const runtime: AegisPyRuntime = await createRuntime({ host: "bun" });
    const view = runtimeView(runtime);
    const capabilities = runtime.capabilities();

    const result = await runtime.run({
      host: "bun",
      code: 'print("bun")',
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
        epochMs: 5,
        rngSeedHex: "feedface",
      },
    });

    await runtime.close();

    expect(view.transportKind).toBe("process");
    expect(view.executionMode).toBe("process");
    expect(view.executionBackend?.available).toBe(true);
    expect(capabilities.profile).toBe("server-hardened");
    expect(capabilities.hardened).toBe(true);
    expect(result.meta.termination).toBe("ok");
    expect(capabilityChannel(result)).toBe("component-wit");

    writeArtifact("artifacts/e2e/bun-parity.json", {
      ok: true,
      invariants: ["INV-FEAT-0018"],
      host: "bun",
      profile: capabilities.profile,
      transport: view.transportKind ?? "unknown",
      executionMode: view.executionMode ?? null,
      executionBackend: view.executionBackend ?? null,
      capabilityChannel: capabilityChannel(result),
      hardened: capabilities.hardened,
      termination: result.meta.termination,
      status: result.status,
    });
  }, 600_000);

  it("fails closed when microvm mode is selected without a launcher", async () => {
    process.env = {
      ...originalEnv,
      AEGISPY_BUN_TRANSPORT: "process",
      AEGISPY_WORKER_EXECUTION_MODE: "microvm",
    };
    delete process.env.AEGISPY_MICROVM_LAUNCHER;

    const runtime: AegisPyRuntime = await createRuntime({ host: "bun" });
    const view = runtimeView(runtime);

    const result = await runtime.run({
      host: "bun",
      code: 'print("bun-microvm")',
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
        epochMs: 5,
        rngSeedHex: "feedface",
      },
    });

    await runtime.close();

    expect(view.transportKind).toBe("process");
    expect(view.executionMode).toBe("microvm");
    expect(view.executionBackend?.available).toBe(false);
    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected microvm startup denial");
    }
    expect(result.error.code).toBe("AEG-ENGINE");
    expect(result.stderrUtf8).toContain("microvm execution mode unavailable");
  }, 600_000);

  it("keeps policy denial audit ordering stable on the process path", async () => {
    process.env = {
      ...originalEnv,
      AEGISPY_BUN_TRANSPORT: "process",
    };

    const runtime: AegisPyRuntime = await createRuntime({ host: "bun" });

    const result = await runtime.run({
      host: "bun",
      code: 'aegispy.http_get("https://example.com/blocked")',
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
        epochMs: 5,
        rngSeedHex: "deadbeef",
      },
    });

    await runtime.close();

    expect(result.status).toBe("error");
    if (result.status !== "error") {
      throw new Error("expected policy denial");
    }
    expect(result.error.code).toBe("AEG-POLICY-DENIED");
    expect(auditKinds(result).slice(0, 2)).toEqual([
      "runtime_channel",
      "runtime_binding",
    ]);
    expect(auditKinds(result)).toContain("policy_denied");
  }, 600_000);

  it("uses simulation only when explicitly selected", async () => {
    process.env = { ...originalEnv, AEGISPY_BUN_TRANSPORT: "simulation" };

    const runtime: AegisPyRuntime = await createRuntime({ host: "bun" });
    const view = runtimeView(runtime);
    const capabilities = runtime.capabilities();

    const result = await runtime.run({
      host: "bun",
      code: 'print("bun-sim")',
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
        epochMs: 5,
        rngSeedHex: "feedface",
      },
    });

    await runtime.close();

    expect(view.transportKind).toBe("simulation");
    expect(capabilities.profile).toBe("server-hardened");
    expect(capabilities.hardened).toBe(false);
    expect(result.status).toBe("ok");
    expect(capabilityChannel(result)).toBe(null);
  }, 600_000);

  it("keeps stdlib json and hashlib supported on server hosts", async () => {
    process.env = {
      ...originalEnv,
      AEGISPY_NODE_TRANSPORT: "process",
      AEGISPY_DENO_TRANSPORT: "process",
      AEGISPY_BUN_TRANSPORT: "process",
      AEGISPY_ISOLATION_PROFILE: "compat",
    };

    const nodeRuntime = await createNodeRuntime({ host: "node" });
    const denoRuntime = await createDenoRuntime({ host: "deno" });
    const bunRuntime = await createRuntime({ host: "bun" });

    const requestCode = [
      "import json",
      "import hashlib",
      'payload = json.dumps({"answer": 42, "tags": ["a", "b"]}, sort_keys=True)',
      "print(hashlib.sha256(payload.encode()).hexdigest())",
    ].join("\n");

    const request = (host: "node" | "deno" | "bun"): RunRequest => {
      return makeRequest(host, requestCode);
    };

    const nodeResult = await nodeRuntime.run(request("node"));
    const denoResult = await denoRuntime.run(request("deno"));
    const bunResult = await bunRuntime.run(request("bun"));

    await nodeRuntime.close();
    await denoRuntime.close();
    await bunRuntime.close();

    for (const result of [nodeResult, denoResult, bunResult]) {
      expect(result.status).toBe("ok");
      expect(result.stdoutUtf8.trim()).toMatch(/^[0-9a-f]{64}$/u);
      expect(capabilityChannel(result)).toBe("component-wit");
    }
  }, 600_000);

  it("writes cross-host parity contract and workload compatibility corpus", async () => {
    process.env = {
      ...originalEnv,
      AEGISPY_NODE_TRANSPORT: "process",
      AEGISPY_DENO_TRANSPORT: "process",
      AEGISPY_BUN_TRANSPORT: "process",
      AEGISPY_ISOLATION_PROFILE: "compat",
      AEGISPY_CORPUS_ENV: corpusEnvValue,
    };

    const nodeRuntime = await createNodeRuntime({ host: "node" });
    const denoRuntime = await createDenoRuntime({ host: "deno" });
    const bunRuntime = await createRuntime({ host: "bun" });
    const browserRuntime = await createBrowserRuntime();
    const runtimes: Record<CorpusHost, AegisPyRuntime> = {
      node: nodeRuntime,
      deno: denoRuntime,
      bun: bunRuntime,
      browser: browserRuntime,
    };
    const capabilities = {
      node: nodeRuntime.capabilities(),
      deno: denoRuntime.capabilities(),
      bun: bunRuntime.capabilities(),
      browser: browserRuntime.capabilities(),
    };

    const totals: Record<CorpusHost, number> = {
      node: 0,
      deno: 0,
      bun: 0,
      browser: 0,
    };
    const passed: Record<CorpusHost, number> = {
      node: 0,
      deno: 0,
      bun: 0,
      browser: 0,
    };

    const caseResults: CorpusCaseResult[] = [];

    const closeRuntimes = async () => {
      await nodeRuntime.close();
      await denoRuntime.close();
      await bunRuntime.close();
      await browserRuntime.close();
    };

    const runCorpusResult = await (async () => {
      for (const corpusCase of corpusCases) {
        const resultsByHost = {
          node: null,
          deno: null,
          bun: null,
          browser: null,
        } as unknown as Record<CorpusHost, CaseOutcome>;

        for (const host of allHosts) {
          const request = makeRequest(host, corpusCase.code);
          request.permissions = structuredClone(corpusCase.permissions);
          corpusCase.configureRequest?.(request);

          const result = await runtimes[host].run(request);
          const channel = capabilityChannel(result);
          const check =
            host === "browser"
              ? corpusCase.validateBrowser(result)
              : corpusCase.validateServer(result);

          let pass = check.pass;
          let reasonCode = check.reasonCode;
          if (host !== "browser" && channel !== "component-wit") {
            pass = false;
            reasonCode = "capability_channel_not_component_wit";
          }

          totals[host] += 1;
          if (pass) passed[host] += 1;

          resultsByHost[host] = {
            status: result.status,
            termination: result.meta.termination,
            errorCode: errorCode(result),
            capabilityChannel: channel,
            pass,
            expectation: check.expectation,
            exceptionTag: check.exceptionTag,
            reasonCode,
          };
        }

        caseResults.push({
          caseId: corpusCase.caseId,
          family: corpusCase.family,
          description: corpusCase.description,
          tags: corpusCase.tags ?? [],
          results: resultsByHost,
        });
      }
      return { error: null as unknown, completed: true };
    })().then(
      (value) => value,
      (error) => ({ error, completed: false }),
    );

    await closeRuntimes();
    if (runCorpusResult.error) throw runCorpusResult.error;

    const hostSummary: Record<
      CorpusHost,
      {
        profile: string;
        hardened: boolean;
        total: number;
        passed: number;
        passRate: number;
      }
    > = {
      node: {
        profile: capabilities.node.profile,
        hardened: capabilities.node.hardened,
        total: totals.node,
        passed: passed.node,
        passRate: totals.node === 0 ? 0 : passed.node / totals.node,
      },
      deno: {
        profile: capabilities.deno.profile,
        hardened: capabilities.deno.hardened,
        total: totals.deno,
        passed: passed.deno,
        passRate: totals.deno === 0 ? 0 : passed.deno / totals.deno,
      },
      bun: {
        profile: capabilities.bun.profile,
        hardened: capabilities.bun.hardened,
        total: totals.bun,
        passed: passed.bun,
        passRate: totals.bun === 0 ? 0 : passed.bun / totals.bun,
      },
      browser: {
        profile: capabilities.browser.profile,
        hardened: capabilities.browser.hardened,
        total: totals.browser,
        passed: passed.browser,
        passRate: totals.browser === 0 ? 0 : passed.browser / totals.browser,
      },
    };

    expect(hostSummary.browser.profile).toBe("browser-real-engine");

    const fixtureSummary = await Promise.all(
      packageFixtures.map((fixture) => summarizePackageFixture(fixture)),
    );
    const packageFixturesOk = arePackageFixturesOk(fixtureSummary);
    expect(
      fixtureSummary.some(
        (fixture) => fixture.coverageBasis === "browser-executed",
      ),
    ).toBe(true);
    expect(packageFixturesOk).toBe(true);

    const compatibilityFailures = collectCompatibilityFailures(caseResults);
    expect(compatibilityFailures.supported).toEqual([]);
    expect(compatibilityFailures.unsupportedByProfile).toEqual([]);

    const corpusOk = isCompatibilityCorpusOk(
      compatibilityFailures,
      packageFixturesOk,
    );

    const parityCase = caseResults.find(
      (entry) => entry.caseId === "simple-print",
    );
    if (!parityCase) {
      throw new Error("missing_simple_print_case_result");
    }

    writeArtifact("artifacts/compat/package-fixture-lockfiles.json", {
      ok: packageFixturesOk,
      invariants: ["INV-FEAT-0016", "INV-FEAT-0023", "INV-FEAT-0025"],
      generatedAt: new Date().toISOString(),
      fixtures: fixtureSummary,
    });

    const browserExceptionTags = Array.from(
      new Set(
        caseResults
          .map((entry) => entry.results.browser.exceptionTag)
          .filter((tag): tag is string => tag !== null),
      ),
    );

    writeArtifact("artifacts/compat/agent-workload-corpus.json", {
      ok: corpusOk,
      invariants: ["INV-FEAT-0017", "INV-FEAT-0018", "INV-FEAT-0025"],
      generatedAt: new Date().toISOString(),
      hosts: hostSummary,
      families: Object.keys(workloadFamilies),
      reasonCodes: Object.keys(compatibilityReasonCodes),
      packageFixturesArtifact:
        "artifacts/compat/package-fixture-lockfiles.json",
      allowedBrowserExceptionTags: ["browser-capability-limited"],
      supportedFailures: compatibilityFailures.supported,
      unsupportedByProfileFailures: compatibilityFailures.unsupportedByProfile,
      cases: caseResults,
    });

    writeArtifact("artifacts/compat/workload-compatibility-matrix.json", {
      ok: corpusOk,
      invariants: ["INV-FEAT-0017", "INV-FEAT-0018", "INV-FEAT-0025"],
      generatedAt: new Date().toISOString(),
      profiles: {
        node: capabilities.node.profile,
        deno: capabilities.deno.profile,
        bun: capabilities.bun.profile,
        browser: capabilities.browser.profile,
      },
      families: workloadFamilies,
      reasonCodes: compatibilityReasonCodes,
      packageFixtures: fixtureSummary,
      hosts: hostSummary,
      supportedFailures: compatibilityFailures.supported,
      unsupportedByProfileFailures: compatibilityFailures.unsupportedByProfile,
      workloads: caseResults.map((entry) => ({
        workloadId: entry.caseId,
        family: entry.family,
        description: entry.description,
        tags: entry.tags,
        hosts: entry.results,
      })),
    });

    const adversarialCases = caseResults.filter((entry) =>
      entry.tags.includes("adversarial"),
    );
    const adversarialPassRateFloor = 1;
    expect(adversarialCases.length).toBeGreaterThanOrEqual(5);
    const adversarialHostSummary = {
      node: {
        profile: capabilities.node.profile,
        hardened: capabilities.node.hardened,
        total: adversarialCases.length,
        passed: adversarialCases.filter((entry) => entry.results.node.pass)
          .length,
      },
      deno: {
        profile: capabilities.deno.profile,
        hardened: capabilities.deno.hardened,
        total: adversarialCases.length,
        passed: adversarialCases.filter((entry) => entry.results.deno.pass)
          .length,
      },
      bun: {
        profile: capabilities.bun.profile,
        hardened: capabilities.bun.hardened,
        total: adversarialCases.length,
        passed: adversarialCases.filter((entry) => entry.results.bun.pass)
          .length,
      },
      browser: {
        profile: capabilities.browser.profile,
        hardened: capabilities.browser.hardened,
        total: adversarialCases.length,
        passed: adversarialCases.filter((entry) => entry.results.browser.pass)
          .length,
      },
    };
    const adversarialHostMetrics = {
      node: {
        ...adversarialHostSummary.node,
        passRate:
          adversarialHostSummary.node.total === 0
            ? 0
            : adversarialHostSummary.node.passed /
              adversarialHostSummary.node.total,
        componentWitOnly: adversarialCases.every(
          (entry) => entry.results.node.capabilityChannel === "component-wit",
        ),
      },
      deno: {
        ...adversarialHostSummary.deno,
        passRate:
          adversarialHostSummary.deno.total === 0
            ? 0
            : adversarialHostSummary.deno.passed /
              adversarialHostSummary.deno.total,
        componentWitOnly: adversarialCases.every(
          (entry) => entry.results.deno.capabilityChannel === "component-wit",
        ),
      },
      bun: {
        ...adversarialHostSummary.bun,
        passRate:
          adversarialHostSummary.bun.total === 0
            ? 0
            : adversarialHostSummary.bun.passed /
              adversarialHostSummary.bun.total,
        componentWitOnly: adversarialCases.every(
          (entry) => entry.results.bun.capabilityChannel === "component-wit",
        ),
      },
      browser: {
        ...adversarialHostSummary.browser,
        passRate:
          adversarialHostSummary.browser.total === 0
            ? 0
            : adversarialHostSummary.browser.passed /
              adversarialHostSummary.browser.total,
      },
    };
    const adversarialOk =
      adversarialCases.length > 0 &&
      adversarialHostMetrics.node.passRate >= adversarialPassRateFloor &&
      adversarialHostMetrics.deno.passRate >= adversarialPassRateFloor &&
      adversarialHostMetrics.bun.passRate >= adversarialPassRateFloor &&
      adversarialHostMetrics.node.componentWitOnly &&
      adversarialHostMetrics.deno.componentWitOnly &&
      adversarialHostMetrics.bun.componentWitOnly;
    const adversarialCaseOutcomes = adversarialCases.map((entry) => ({
      caseId: entry.caseId,
      description: entry.description,
      results: entry.results,
    }));
    const browserAdversarialExceptionTags = Array.from(
      new Set(
        adversarialCases
          .map((entry) => entry.results.browser.exceptionTag)
          .filter((tag): tag is string => tag !== null),
      ),
    );

    writeArtifact("artifacts/security/native-abi-adversarial.json", {
      ok: adversarialOk,
      invariants: ["INV-SECU-0006", "INV-FEAT-0025"],
      generatedAt: new Date().toISOString(),
      thresholds: {
        adversarialCaseCountFloor: 5,
        serverPassRateFloor: adversarialPassRateFloor,
      },
      cases: adversarialCaseOutcomes,
      caseIds: adversarialCaseOutcomes.map((entry) => entry.caseId),
      hosts: adversarialHostMetrics,
      browserExceptionTags: browserAdversarialExceptionTags,
      requiredServerCases: {
        "http-policy-deny": {
          termination: "policy_denied",
          status: "error",
        },
        "fs-default-deny": {
          termination: "policy_denied",
          status: "error",
        },
        "fs-traversal-deny": {
          termination: "policy_denied",
          status: "error",
        },
        "env-default-deny": {
          termination: "policy_denied",
          status: "error",
        },
        "output-abuse": {
          termination: "output_limit",
          status: "error",
        },
      },
    });

    writeArtifact("artifacts/e2e/host-parity-contract.json", {
      ok: corpusOk,
      invariants: ["INV-FEAT-0025"],
      runs: {
        node: {
          profile: capabilities.node.profile,
          hardened: capabilities.node.hardened,
          termination: parityCase.results.node.termination,
          status: parityCase.results.node.status,
          capabilityChannel: parityCase.results.node.capabilityChannel,
          exceptionTag: null,
        },
        deno: {
          profile: capabilities.deno.profile,
          hardened: capabilities.deno.hardened,
          termination: parityCase.results.deno.termination,
          status: parityCase.results.deno.status,
          capabilityChannel: parityCase.results.deno.capabilityChannel,
          exceptionTag: null,
        },
        bun: {
          profile: capabilities.bun.profile,
          hardened: capabilities.bun.hardened,
          termination: parityCase.results.bun.termination,
          status: parityCase.results.bun.status,
          capabilityChannel: parityCase.results.bun.capabilityChannel,
          exceptionTag: null,
        },
        browser: {
          profile: capabilities.browser.profile,
          hardened: capabilities.browser.hardened,
          termination: parityCase.results.browser.termination,
          status: parityCase.results.browser.status,
          capabilityChannel: parityCase.results.browser.capabilityChannel,
          exceptionTag: null,
        },
      },
      corpus: {
        artifact: "artifacts/compat/agent-workload-corpus.json",
        matrixArtifact: "artifacts/compat/workload-compatibility-matrix.json",
        serverPassRates: {
          node: hostSummary.node.passRate,
          deno: hostSummary.deno.passRate,
          bun: hostSummary.bun.passRate,
        },
        supportedFailures: compatibilityFailures.supported,
        unsupportedByProfileFailures:
          compatibilityFailures.unsupportedByProfile,
        browserExceptionTags,
      },
    });
  }, 240_000);
});
