import type { AegisPyError, ErrorCode } from "./contracts/types";

export function makeAegisPyError(
  code: ErrorCode,
  message: string,
  detail: Record<string, unknown>,
): AegisPyError {
  return {
    code,
    message,
    detailJson: JSON.stringify(detail),
  };
}

export function parseDetailJson(detailJson: string): Record<string, unknown> {
  return { raw: detailJson };
}
