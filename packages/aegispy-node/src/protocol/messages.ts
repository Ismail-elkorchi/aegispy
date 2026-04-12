import type { RunRequest, RunResult } from "@aegispy/core";

export const SERVER_ENGINE_PROTOCOL_VERSION = "1";
export const SERVER_ENGINE_PROTOCOL_MAX_FRAME_BYTES = 1024 * 1024;

export type ServerEngineProtocolVersion = typeof SERVER_ENGINE_PROTOCOL_VERSION;

export type ServerEngineProtocolMessageType =
  | "hello"
  | "hello_result"
  | "run"
  | "run_result"
  | "cancel"
  | "cancel_result"
  | "shutdown"
  | "shutdown_result"
  | "error";

export interface ServerEngineProtocolBase {
  protocolVersion: ServerEngineProtocolVersion;
  type: ServerEngineProtocolMessageType;
}

export interface WorkerHelloRequest extends ServerEngineProtocolBase {
  type: "hello";
  requestId: string;
  client: {
    name: string;
    host: "node" | "deno" | "bun";
  };
  maxFrameBytes: number;
}

export interface WorkerHelloResponse extends ServerEngineProtocolBase {
  type: "hello_result";
  requestId: string;
  engine: {
    name: string;
    executorMode: string;
  };
  supportedProtocolVersions: ServerEngineProtocolVersion[];
  maxFrameBytes: number;
  bundle: {
    runtimeFamily?: string;
    bundleId?: string;
    os?: string;
    arch?: string;
    pythonAbi?: string;
    packageSetVersion?: string;
  };
  capabilityFamilies: {
    server: string[];
  };
  limits: {
    wallMs: number;
    cpuMs: number;
    memoryBytes: number;
    stdoutBytes: number;
    stderrBytes: number;
  };
}

export interface WorkerRunRequest extends ServerEngineProtocolBase {
  type: "run";
  requestId: string;
  run: Omit<RunRequest, "host">;
}

export interface WorkerRunResponse extends ServerEngineProtocolBase {
  type: "run_result";
  requestId: string;
  result: RunResult;
}

export interface WorkerCancelRequest extends ServerEngineProtocolBase {
  type: "cancel";
  requestId: string;
  targetRequestId: string;
}

export interface WorkerCancelResponse extends ServerEngineProtocolBase {
  type: "cancel_result";
  requestId: string;
  targetRequestId: string;
  accepted: boolean;
  reason: "not_found" | "not_cancelable" | "already_completed";
}

export interface WorkerShutdownRequest extends ServerEngineProtocolBase {
  type: "shutdown";
  requestId: string;
}

export interface WorkerShutdownResponse extends ServerEngineProtocolBase {
  type: "shutdown_result";
  requestId: string;
  accepted: boolean;
}

export interface WorkerProtocolError extends ServerEngineProtocolBase {
  type: "error";
  requestId: string;
  error: {
    code:
      | "invalid_json"
      | "invalid_message"
      | "unsupported_protocol_version"
      | "unknown_message_type"
      | "frame_too_large";
    message: string;
  };
}

export type WorkerMessage =
  | WorkerHelloRequest
  | WorkerHelloResponse
  | WorkerRunRequest
  | WorkerRunResponse
  | WorkerCancelRequest
  | WorkerCancelResponse
  | WorkerShutdownRequest
  | WorkerShutdownResponse
  | WorkerProtocolError;

export type WorkerRequest =
  | WorkerHelloRequest
  | WorkerRunRequest
  | WorkerCancelRequest
  | WorkerShutdownRequest;

export type WorkerResponse =
  | WorkerHelloResponse
  | WorkerRunResponse
  | WorkerCancelResponse
  | WorkerShutdownResponse
  | WorkerProtocolError;
