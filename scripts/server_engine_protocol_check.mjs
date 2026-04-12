import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const schemaPath = path.join(
  repoRoot,
  "artifacts",
  "protocol",
  "server-engine-protocol.v1.schema.json",
);
const fixturesDir = path.join(
  repoRoot,
  "artifacts",
  "protocol",
  "fixtures",
  "server-engine-v1",
);
const outPath = path.join(
  repoRoot,
  "artifacts",
  "gates",
  "server-engine-protocol-check.json",
);

const protocolVersion = "1";
const messageTypes = new Set([
  "hello",
  "hello_result",
  "run",
  "run_result",
  "cancel",
  "cancel_result",
  "shutdown",
  "shutdown_result",
  "error",
]);
const requiredFixtures = [
  "hello.json",
  "hello-result.json",
  "run.json",
  "run-result-ok.json",
  "run-result-policy-denied.json",
  "run-result-timeout.json",
  "run-result-output-limit.json",
  "run-result-engine-error.json",
  "invalid-request-error.json",
  "cancel.json",
  "cancel-result.json",
  "shutdown.json",
  "shutdown-result.json",
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function repoRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function requireFields(value, fields, errors, context) {
  for (const field of fields) {
    if (!(field in value)) {
      errors.push(`${context}: missing ${field}`);
    }
  }
}

function validateFixture(name, value, errors) {
  requireFields(value, ["protocolVersion", "type", "requestId"], errors, name);
  if (value.protocolVersion !== protocolVersion) {
    errors.push(`${name}: invalid protocolVersion`);
  }
  if (!messageTypes.has(value.type)) {
    errors.push(`${name}: invalid message type`);
    return;
  }
  if (typeof value.requestId !== "string" || value.requestId.length === 0) {
    errors.push(`${name}: invalid requestId`);
  }

  const requiredByType = {
    hello: ["client", "maxFrameBytes"],
    hello_result: [
      "engine",
      "supportedProtocolVersions",
      "maxFrameBytes",
      "bundle",
      "capabilityFamilies",
      "limits",
    ],
    run: ["run"],
    run_result: ["result"],
    cancel: ["targetRequestId"],
    cancel_result: ["targetRequestId", "accepted", "reason"],
    shutdown: [],
    shutdown_result: ["accepted"],
    error: ["error"],
  };
  requireFields(value, requiredByType[value.type] ?? [], errors, name);
}

function ensureDocs(errors) {
  const architecture = fs.readFileSync(
    path.join(repoRoot, "docs", "architecture.md"),
    "utf8",
  );
  const runtimeApi = fs.readFileSync(
    path.join(repoRoot, "docs", "reference", "runtime-api.md"),
    "utf8",
  );
  const profileDoc = fs.readFileSync(
    path.join(repoRoot, "docs", "reference", "profiles.md"),
    "utf8",
  );
  const text = `${architecture}\n${runtimeApi}\n${profileDoc}`;
  for (const token of [
    "server-engine-protocol-v1",
    "hello_result",
    "shutdown_result",
    "browser worker protocol is not part of this freeze-readiness boundary",
  ]) {
    if (!text.includes(token)) {
      errors.push(`docs: missing ${token}`);
    }
  }
}

function main() {
  const errors = [];
  const schema = readJson(schemaPath);
  if (schema.title !== "AegisPy Server Engine Protocol v1 Candidate") {
    errors.push("schema: unexpected title");
  }
  if (!schema.required?.includes("protocolVersion")) {
    errors.push("schema: protocolVersion is not required");
  }

  for (const fixture of requiredFixtures) {
    const fixturePath = path.join(fixturesDir, fixture);
    if (!fs.existsSync(fixturePath)) {
      errors.push(`fixture missing: ${fixture}`);
      continue;
    }
    validateFixture(fixture, readJson(fixturePath), errors);
  }
  ensureDocs(errors);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        ok: errors.length === 0,
        schema: repoRelative(schemaPath),
        fixtures: requiredFixtures.length,
        errors,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  if (errors.length > 0) process.exitCode = 1;
}

main();
