import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVER_ENGINE_PROTOCOL_VERSION,
  SERVER_ENGINE_PROTOCOL_MAX_FRAME_BYTES,
  type ServerEngineProtocolMessageType,
} from "../src/protocol/messages";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");

const messageTypes: ServerEngineProtocolMessageType[] = [
  "hello",
  "hello_result",
  "run",
  "run_result",
  "cancel",
  "cancel_result",
  "shutdown",
  "shutdown_result",
  "error",
];

describe("server engine protocol v1 candidate", () => {
  it("freezes the public-safe server-only message vocabulary", () => {
    expect(SERVER_ENGINE_PROTOCOL_VERSION).toBe("1");
    expect(SERVER_ENGINE_PROTOCOL_MAX_FRAME_BYTES).toBeGreaterThan(0);
    expect(messageTypes).toEqual([
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
  });

  it("keeps schemas and golden fixtures as the language-neutral source of truth", () => {
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

    expect(fs.existsSync(schemaPath)).toBe(true);
    for (const fixtureName of [
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
    ]) {
      expect(fs.existsSync(path.join(fixturesDir, fixtureName))).toBe(true);
    }
  });
});
