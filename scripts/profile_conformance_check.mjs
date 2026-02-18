import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const profileOutPath = path.join(
  repoRoot,
  "artifacts",
  "compat",
  "profile-conformance.json",
);
const gateOutPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "profile-conformance-check.json",
);

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonOrNull(relPath) {
  const full = path.join(repoRoot, relPath);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

function checkBoolean(field, value, failures, error) {
  if (value !== true) failures.push({ error, field });
}

function main() {
  const failures = [];
  const required = {
    node: "artifacts/tests/real-engine-default.json",
    deno: "artifacts/e2e/deno-parity.json",
    bun: "artifacts/e2e/bun-parity.json",
    browser: "artifacts/e2e/browser-run.json",
    hostParity: "artifacts/e2e/host-parity-contract.json",
    isolation: "artifacts/security/isolation-profile.json",
  };

  const node = readJsonOrNull(required.node);
  const deno = readJsonOrNull(required.deno);
  const bun = readJsonOrNull(required.bun);
  const browser = readJsonOrNull(required.browser);
  const hostParity = readJsonOrNull(required.hostParity);
  const isolation = readJsonOrNull(required.isolation);

  for (const [name, relPath] of Object.entries(required)) {
    if (readJsonOrNull(relPath) === null) {
      failures.push({ error: "missing_profile_artifact", name, path: relPath });
    }
  }

  if (node) {
    if (node.profile !== "server-hardened")
      failures.push({ error: "node_profile_not_server_hardened" });
    if (node.transport !== "process")
      failures.push({ error: "node_transport_not_process" });
    if (node.capabilityChannel !== "component-wit")
      failures.push({ error: "node_channel_not_component_wit" });
    checkBoolean("node.hardened", node.hardened, failures, "node_not_hardened");
  }

  if (deno) {
    if (deno.profile !== "server-hardened")
      failures.push({ error: "deno_profile_not_server_hardened" });
    if (deno.transport !== "process")
      failures.push({ error: "deno_transport_not_process" });
    if (deno.capabilityChannel !== "component-wit")
      failures.push({ error: "deno_channel_not_component_wit" });
    checkBoolean("deno.hardened", deno.hardened, failures, "deno_not_hardened");
  }

  if (bun) {
    if (bun.profile !== "server-hardened")
      failures.push({ error: "bun_profile_not_server_hardened" });
    if (bun.transport !== "process")
      failures.push({ error: "bun_transport_not_process" });
    if (bun.capabilityChannel !== "component-wit")
      failures.push({ error: "bun_channel_not_component_wit" });
    checkBoolean("bun.hardened", bun.hardened, failures, "bun_not_hardened");
  }

  if (isolation) {
    if (isolation.conformanceProfile !== "server-hardened")
      failures.push({ error: "isolation_profile_not_server_hardened" });
    const profileName =
      typeof isolation.profile === "object" && isolation.profile !== null
        ? isolation.profile.name
        : null;
    if (profileName !== "strict")
      failures.push({ error: "isolation_profile_not_strict" });
  }

  if (browser) {
    if (browser.profile !== "browser-subset")
      failures.push({ error: "browser_profile_not_subset" });
    if (browser.hardened !== false)
      failures.push({ error: "browser_hardened_flag_not_false" });
    if (
      !browser.capabilityModel ||
      browser.capabilityModel.fs !== false ||
      browser.capabilityModel.http !== false ||
      browser.capabilityModel.env !== false
    ) {
      failures.push({ error: "browser_capability_subset_shape_invalid" });
    }
  }

  if (hostParity) {
    const runs =
      typeof hostParity.runs === "object" && hostParity.runs !== null
        ? hostParity.runs
        : null;
    if (!runs) {
      failures.push({ error: "host_parity_runs_missing" });
    } else {
      if (runs.node?.profile !== "server-hardened")
        failures.push({ error: "host_parity_node_profile_invalid" });
      if (runs.deno?.profile !== "server-hardened")
        failures.push({ error: "host_parity_deno_profile_invalid" });
      if (runs.bun?.profile !== "server-hardened")
        failures.push({ error: "host_parity_bun_profile_invalid" });
      if (runs.browser?.profile !== "browser-subset")
        failures.push({ error: "host_parity_browser_profile_invalid" });
      if (runs.browser?.exceptionTag !== "browser-subset")
        failures.push({ error: "host_parity_browser_exception_tag_invalid" });
    }
  }

  const profilePayload = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    requiredArtifacts: required,
    profiles: {
      serverHardened: {
        hosts: ["node", "deno", "bun"],
        requiredTransport: "process",
        requiredCapabilityChannel: "component-wit",
        requiredIsolationProfile: "strict",
      },
      browserSubset: {
        hosts: ["browser"],
        requiredTransport: "worker",
        unsupportedCapabilities: ["fs", "http", "env"],
      },
    },
    failures,
  };

  const gatePayload = {
    ok: profilePayload.ok,
    checked: [
      required.node,
      required.deno,
      required.bun,
      required.browser,
      required.hostParity,
      required.isolation,
    ],
    failures,
    artifact: "artifacts/compat/profile-conformance.json",
  };

  ensureDir(profileOutPath);
  ensureDir(gateOutPath);
  fs.writeFileSync(
    profileOutPath,
    JSON.stringify(profilePayload, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    gateOutPath,
    JSON.stringify(gatePayload, null, 2) + "\n",
    "utf8",
  );
  if (!profilePayload.ok) process.exitCode = 1;
}

Promise.resolve()
  .then(() => main())
  .catch((e) => {
    const errorPayload = {
      ok: false,
      error: String(e),
    };
    ensureDir(profileOutPath);
    ensureDir(gateOutPath);
    fs.writeFileSync(
      profileOutPath,
      JSON.stringify(errorPayload, null, 2) + "\n",
      "utf8",
    );
    fs.writeFileSync(
      gateOutPath,
      JSON.stringify(errorPayload, null, 2) + "\n",
      "utf8",
    );
    process.exitCode = 1;
  });
