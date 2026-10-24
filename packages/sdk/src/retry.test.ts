import { describe, expect, it, vi } from "vitest";

import { isRetryableError, withRetry } from "./retry.js";

function callException(): Error & { code: string } {
  return Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION" });
}

function networkError(): Error & { code: string } {
  return Object.assign(new Error("timeout"), { code: "TIMEOUT" });
}

describe("isRetryableError", () => {
  it("is false for a CALL_EXCEPTION (a contract revert)", () => {
    expect(isRetryableError(callException())).toBe(false);
  });

  it("is true for any other coded ethers error", () => {
    expect(isRetryableError(networkError())).toBe(true);
  });

  it("is true for a plain error with no code", () => {
    expect(isRetryableError(new Error("boom"))).toBe(true);
  });

  it("is true for a non-object thrown value", () => {
    expect(isRetryableError("boom")).toBe(true);
    expect(isRetryableError(undefined)).toBe(true);
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
