export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * ethers error codes worth retrying: a transport-level failure that may
 * genuinely succeed on a later attempt. Everything else — a revert
 * (`CALL_EXCEPTION`), a wallet rejection (`ACTION_REJECTED`),
 * `INSUFFICIENT_FUNDS`, a stale or conflicting nonce (`NONCE_EXPIRED`,
 * `REPLACEMENT_UNDERPRICED`), a malformed call (`INVALID_ARGUMENT`), an
 * operation the signer doesn't support (`UNSUPPORTED_OPERATION`), and so
 * on — fails the exact same way on every attempt, so retrying it only
 * delays the error (or, for a wallet prompt, repeats it) without any
 * chance of success.
 */
const RETRYABLE_CODES = new Set(["NETWORK_ERROR", "TIMEOUT", "SERVER_ERROR"]);

/**
 * A thrown value with no `code` at all isn't one of ethers' own typed
 * errors; this is a last resort for that case, matching only messages that
 * plainly describe a transport failure (not an arbitrary string).
 */
const TRANSPORT_FAILURE_PATTERN =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

/**
 * True only for an allowlisted transport-level failure worth retrying.
 * Everything else — including any error this doesn't specifically
 * recognize — is treated as not worth retrying, since retrying the wrong
 * thing (a wallet rejection, an insufficient-funds error, a revert) can
 * only make things worse: repeated wallet prompts, or in the worst case
 * (see `hallmarq.ts`'s broadcast step) resending something that already
 * went through.
 */
export function isRetryableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string") {
    return RETRYABLE_CODES.has(code);
  }
  return typeof message === "string" && TRANSPORT_FAILURE_PATTERN.test(message);
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
