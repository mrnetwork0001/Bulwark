// Small pieces every fault catalog shares.

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
  });
}

/**
 * An HTTP error as a client sees it: a status, and the response headers that
 * tell it what to do next (e.g. a 429's `x-ratelimit-reset` / `retry-after`).
 * Agents read `status` and `headers` by duck typing, never `instanceof`.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(`HTTP ${status}: ${message}`);
  }
}
