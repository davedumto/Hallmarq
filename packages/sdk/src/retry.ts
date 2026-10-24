export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * True if `error` looks like a transport-level failure worth retrying,
 * rather than a contract revert (which will fail the same way every time).
 * ethers v6 tags every revert with `code: "CALL_EXCEPTION"`; anything else
 * thrown while sending — a timeout, a dropped connection, an RPC rate
 * limit — is a genuine network failure.
 */
export function isRetryableError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    return (error as { code?: unknown }).code !== "CALL_EXCEPTION";
  }
  return true;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `send` up to `maxAttempts` times with growing delays, but only
 * for errors {@link isRetryableError} calls retryable. The delay doubles
 * each attempt (`baseDelayMs`, `baseDelayMs * 2`, ...).
 *
 * `send` must be a step that cannot have taken effect yet when it throws —
 * e.g. broadcasting a transaction, before a hash exists. Once a step might
 * have already succeeded partially (a transaction is in flight), retrying
 * it risks resending; callers must not wrap that step in `withRetry`.
 */
export async function withRetry<T>(
  send: () => Promise<T>,
  { maxAttempts = 3, baseDelayMs = 500, sleep = defaultSleep }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (!isRetryableError(error) || attempt === maxAttempts) {
        throw error;
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new Error("unreachable: withRetry's loop always returns or throws");
}
