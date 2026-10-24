import { describe, expect, it, vi } from "vitest";

import { isRetryableError, withRetry } from "./retry.js";

function coded(code: string, message = "boom"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function callException(): Error & { code: string } {
  return coded("CALL_EXCEPTION", "reverted");
}

function networkError(): Error & { code: string } {
  return coded("TIMEOUT", "timeout");
}

// Every non-retryable code the CTO review named: a wallet rejection,
// insufficient funds, a stale or conflicting nonce, a malformed call and an
// unsupported signer operation all fail the exact same way on every retry.
const NON_RETRYABLE_CODES = [
  "CALL_EXCEPTION",
  "ACTION_REJECTED",
  "INSUFFICIENT_FUNDS",
  "NONCE_EXPIRED",
  "REPLACEMENT_UNDERPRICED",
  "INVALID_ARGUMENT",
  "UNSUPPORTED_OPERATION",
];

describe("isRetryableError", () => {
  it.each(NON_RETRYABLE_CODES)("is false for %s", (code) => {
    expect(isRetryableError(coded(code))).toBe(false);
  });

  it.each(["NETWORK_ERROR", "TIMEOUT", "SERVER_ERROR"])("is true for %s", (code) => {
    expect(isRetryableError(coded(code))).toBe(true);
  });

  it("is false for a plain error with no code and a message that isn't a known transport failure", () => {
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });

  it("is true for a no-code error whose message plainly describes a transport failure", () => {
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("connect ECONNRESET 127.0.0.1:8545"))).toBe(true);
  });

  it("is false for a non-object thrown value", () => {
    expect(isRetryableError("boom")).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the result on the first success, without retrying", async () => {
    const send = vi.fn().mockResolvedValue("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(send, { sleep })).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a retryable error with growing delays, then succeeds", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(send, { baseDelayMs: 100, sleep })).resolves.toBe("ok");
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it("gives up after maxAttempts retryable failures and throws the last error", async () => {
    const errors = [networkError(), networkError(), networkError()];
    const send = vi
      .fn()
      .mockRejectedValueOnce(errors[0])
      .mockRejectedValueOnce(errors[1])
      .mockRejectedValueOnce(errors[2]);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(send, { maxAttempts: 3, sleep })).rejects.toBe(errors[2]);
    expect(send).toHaveBeenCalledTimes(3);
    // Only 2 sleeps: no delay is needed after the final, non-retried attempt.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each(NON_RETRYABLE_CODES)(
    "sends exactly once for a non-retryable %s, never retrying it",
    async (code) => {
      const error = coded(code);
      const send = vi.fn().mockRejectedValue(error);
      const sleep = vi.fn().mockResolvedValue(undefined);

      await expect(withRetry(send, { sleep })).rejects.toBe(error);
      expect(send).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("never retries a CALL_EXCEPTION (a revert), even on the first attempt", async () => {
    const error = callException();
    const send = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(send, { sleep })).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("respects a maxAttempts of 1 (no retries at all)", async () => {
    const error = networkError();
    const send = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(withRetry(send, { maxAttempts: 1, sleep })).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
