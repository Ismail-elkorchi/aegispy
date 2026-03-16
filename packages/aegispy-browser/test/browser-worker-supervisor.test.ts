import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserWorkerSupervisor,
  type BrowserWorkerRunRequest,
  type BrowserWorkerRunResult,
} from "../src/runtime/browser-worker-supervisor";

interface TestWorkerPort {
  postMessage(payload: BrowserWorkerRunRequest): void;
  terminate(): Promise<void>;
  onMessage(handler: (payload: BrowserWorkerRunResult) => void): void;
  onError(handler: (error: unknown) => void): void;
}

function makeRequest(requestId: string): BrowserWorkerRunRequest {
  return {
    requestId,
    code: 'print("ok")',
    stdinUtf8: "",
    determinism: {
      enabled: true,
      epochMs: 50,
      rngSeedHex: "abcd1234",
    },
    packages: [],
  };
}

function deliverResult(
  messageHandler: ((payload: BrowserWorkerRunResult) => void) | null,
  payload: BrowserWorkerRunResult,
): void {
  if (messageHandler === null) {
    throw new Error("worker message handler was not registered");
  }
  messageHandler(payload);
}

describe("BrowserWorkerSupervisor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not let a completed request timeout reset a subsequent run", async () => {
    vi.useFakeTimers();

    const postedRequests: string[] = [];
    let messageHandler: ((payload: BrowserWorkerRunResult) => void) | null =
      null;
    let errorHandler: ((error: unknown) => void) | null = null;
    let terminateCalls = 0;
    let secondRequestSeen = false;

    const worker: TestWorkerPort = {
      postMessage(payload) {
        postedRequests.push(payload.requestId);
        if (payload.requestId === "first") {
          deliverResult(messageHandler, {
            requestId: "first",
            status: "ok",
            stdoutUtf8: "first\n",
            stderrUtf8: "",
          });
        }
        if (payload.requestId === "second") {
          secondRequestSeen = true;
        }
      },
      async terminate() {
        terminateCalls += 1;
      },
      onMessage(handler) {
        messageHandler = handler;
      },
      onError(handler) {
        errorHandler = handler;
      },
    };

    const supervisor = new BrowserWorkerSupervisor(async () => worker);

    const firstRunPromise = supervisor.run(makeRequest("first"), 20);
    await expect(firstRunPromise).resolves.toMatchObject({
      requestId: "first",
      status: "ok",
    });

    const secondRunPromise = supervisor.run(makeRequest("second"), 100);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(terminateCalls).toBe(0);
    expect(secondRequestSeen).toBe(true);
    expect(postedRequests).toEqual(["first", "second"]);
    expect(errorHandler).not.toBeNull();

    deliverResult(messageHandler, {
      requestId: "second",
      status: "ok",
      stdoutUtf8: "second\n",
      stderrUtf8: "",
    });

    await expect(secondRunPromise).resolves.toMatchObject({
      requestId: "second",
      status: "ok",
    });

    await supervisor.close();
  });
});
