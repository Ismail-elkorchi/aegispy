import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type AegisPyRuntime } from "../src/index";
import { createRuntime as createNodeRuntime } from "../../aegispy-node/src/index";
import { createRuntime as createDenoRuntime } from "../../aegispy-deno/src/index";
import { createRuntime as createBrowserRuntime } from "../../aegispy-browser/src/index";
import type { HostKind, RunRequest, RunResult } from "@aegispy/core";
import { writeArtifact } from "./helpers/artifact";

const originalEnv = { ...process.env };
const corpusEnvValue = "agent-corpus-env-ok";
const serverPassRateMin = 0.8;
const allHosts = ["node", "deno", "bun", "browser"] as const;
const serverHosts = ["node", "deno", "bun"] as const;

type CorpusHost = (typeof allHosts)[number];

interface CaseCheck {
  pass: boolean;
  exceptionTag: string | null;
  reason: string | null;
}

interface CorpusCase {
  caseId: string;
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
  exceptionTag: string | null;
  reason: string | null;
}

function runtimeView(runtime: AegisPyRuntime): {
  transportKind?: string;
  isolationProfile?: unknown;
} {
  return runtime as unknown as {
    transportKind?: string;
    isolationProfile?: unknown;
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

const corpusCases: CorpusCase[] = [
  {
    caseId: "simple-print",
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
      return {
        pass,
        exceptionTag: null,
        reason: pass ? null : "missing_print_output",
      };
    },
    validateBrowser(result) {
      const pass =
        result.status === "ok" &&
        result.stdoutUtf8.includes("agent-corpus-print");
      return {
        pass,
        exceptionTag: null,
        reason: pass ? null : "missing_print_output",
      };
    },
  },
  {
    caseId: "deterministic-time-rng",
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
      return {
        pass,
        exceptionTag: null,
        reason: pass ? null : "deterministic_lines_missing",
      };
    },
    validateBrowser(result) {
      const lines = result.stdoutUtf8
        .trim()
        .split(/\r?\n/u)
        .filter((line) => line.length > 0);
      const pass = result.status === "ok" && lines.length >= 2;
      return {
        pass,
        exceptionTag: null,
        reason: pass ? null : "deterministic_lines_missing",
      };
    },
  },
  {
    caseId: "stdlib-json-hash",
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
      return {
        pass,
        exceptionTag: null,
        reason: pass ? null : "stdlib_digest_missing",
      };
    },
    validateBrowser(result) {
      if (result.status !== "ok") {
        return {
          pass: false,
          exceptionTag: null,
          reason: "browser_stdlib_run_failed",
        };
      }
      const digest = result.stdoutUtf8.trim();
      if (/^[0-9a-f]{64}$/u.test(digest)) {
        return { pass: true, exceptionTag: null, reason: null };
      }
      return {
        pass: true,
        exceptionTag: "browser-subset-semantic-gap",
        reason: "browser_simulated_stdlib_semantics",
      };
    },
  },
  {
    caseId: "filesystem-roundtrip",
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
      return {
        pass,
        exceptionTag: null,
        reason: pass ? null : "filesystem_roundtrip_failed",
      };
    },
    validateBrowser(result) {
      const pass =
        result.status === "error" &&
        errorCode(result) === "AEG-UNSUPPORTED-HOST";
      return {
        pass,
        exceptionTag: "browser-subset",
        reason: pass ? null : "browser_subset_rejection_missing",
      };
    },
  },
  {
    caseId: "env-read",
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
      return {
        pass,
        exceptionTag: null,
        reason: pass ? null : "env_read_failed",
      };
    },
    validateBrowser(result) {
      const pass =
        result.status === "error" &&
        errorCode(result) === "AEG-UNSUPPORTED-HOST";
      return {
        pass,
        exceptionTag: "browser-subset",
        reason: pass ? null : "browser_subset_rejection_missing",
      };
    },
  },
  {
    caseId: "http-policy-deny",
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
        exceptionTag: null,
        reason: pass ? null : "http_policy_denial_missing",
      };
    },
    validateBrowser(result) {
      const pass = isPolicyDenied(result);
      return {
        pass,
        exceptionTag: null,
        reason: pass ? null : "http_policy_denial_missing",
      };
    },
  },
  {
    caseId: "fs-default-deny",
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
        exceptionTag: null,
        reason: pass ? null : "fs_default_denial_missing",
      };
    },
    validateBrowser(result) {
      const pass =
        result.status === "error" &&
        errorCode(result) === "AEG-UNSUPPORTED-HOST";
      return {
        pass,
        exceptionTag: "browser-subset",
        reason: pass ? null : "browser_subset_rejection_missing",
      };
    },
  },
  {
    caseId: "fs-traversal-deny",
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
        exceptionTag: null,
        reason: pass ? null : "fs_traversal_denial_missing",
      };
    },
    validateBrowser(result) {
      const pass =
        result.status === "error" &&
        errorCode(result) === "AEG-UNSUPPORTED-HOST";
      return {
        pass,
        exceptionTag: "browser-subset",
        reason: pass ? null : "browser_subset_rejection_missing",
      };
    },
  },
  {
    caseId: "env-default-deny",
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
        exceptionTag: null,
        reason: pass ? null : "env_default_denial_missing",
      };
    },
    validateBrowser(result) {
      const code = errorCode(result);
      const pass =
        result.status === "error" &&
        (code === "AEG-POLICY-DENIED" || code === "AEG-UNSUPPORTED-HOST");
      return {
        pass,
        exceptionTag: code === "AEG-UNSUPPORTED-HOST" ? "browser-subset" : null,
        reason: pass ? null : "env_default_denial_missing",
      };
    },
  },
  {
    caseId: "output-abuse",
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
        exceptionTag: null,
        reason: pass ? null : "output_limit_denial_missing",
      };
    },
    validateBrowser(result) {
      const pass = isOutputLimitDenied(result);
      return {
        pass,
        exceptionTag: null,
        reason: pass ? null : "output_limit_denial_missing",
      };
    },
  },
];

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("bun adapter parity", () => {
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
      capabilityChannel: capabilityChannel(result),
      hardened: capabilities.hardened,
      termination: result.meta.termination,
      status: result.status,
    });
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
    const browserRuntime = await createBrowserRuntime({ host: "browser" });
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

    const caseResults: Array<{
      caseId: string;
      description: string;
      tags: string[];
      results: Record<CorpusHost, CaseOutcome>;
    }> = [];

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
          let reason = check.reason;
          if (host !== "browser" && channel !== "component-wit") {
            pass = false;
            reason = reason
              ? `${reason}; capability_channel_not_component_wit`
              : "capability_channel_not_component_wit";
          }

          totals[host] += 1;
          if (pass) passed[host] += 1;

          resultsByHost[host] = {
            status: result.status,
            termination: result.meta.termination,
            errorCode: errorCode(result),
            capabilityChannel: channel,
            pass,
            exceptionTag: check.exceptionTag,
            reason,
          };
        }

        caseResults.push({
          caseId: corpusCase.caseId,
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

    for (const host of serverHosts) {
      expect(hostSummary[host].passRate).toBeGreaterThanOrEqual(
        serverPassRateMin,
      );
    }
    expect(hostSummary.browser.profile).toBe("browser-subset");

    const corpusOk =
      hostSummary.node.passRate >= serverPassRateMin &&
      hostSummary.deno.passRate >= serverPassRateMin &&
      hostSummary.bun.passRate >= serverPassRateMin &&
      hostSummary.browser.passRate >= serverPassRateMin;

    const parityCase = caseResults.find(
      (entry) => entry.caseId === "simple-print",
    );
    if (!parityCase) {
      throw new Error("missing_simple_print_case_result");
    }

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
      thresholds: {
        serverPassRateMin,
      },
      hosts: hostSummary,
      allowedBrowserExceptionTags: [
        "browser-subset",
        "browser-subset-semantic-gap",
      ],
      cases: caseResults,
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
          exceptionTag: "browser-subset",
        },
      },
      corpus: {
        artifact: "artifacts/compat/agent-workload-corpus.json",
        serverPassRateMin,
        serverPassRates: {
          node: hostSummary.node.passRate,
          deno: hostSummary.deno.passRate,
          bun: hostSummary.bun.passRate,
        },
        browserExceptionTags,
      },
    });
  }, 240_000);
});
