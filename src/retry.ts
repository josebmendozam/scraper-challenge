export interface RetryResponse<TBody = unknown> {
  status: number;
  headers?: unknown;
  body: TBody;
}

export interface RetryResult<TResponse extends RetryResponse> {
  value: TResponse;
  attempts: number;
  status: number;
  body: TResponse["body"];
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export type RetryFailureReason =
  | "max-attempts"
  | "non-retryable-status"
  | "non-retryable-error";

interface RetryErrorDetails {
  attempts: number;
  status?: number;
  body?: unknown;
  reason: RetryFailureReason;
  cause?: unknown;
}

interface ErrorResponse {
  status: number;
  headers: unknown;
  body: unknown;
}

const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_NETWORK",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

const defaultSleep = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly status: number | undefined;
  readonly body: unknown;
  readonly reason: RetryFailureReason;

  constructor(details: RetryErrorDetails) {
    const statusText = details.status === undefined ? "" : ` with HTTP ${details.status}`;
    const attemptText = details.attempts === 1 ? "1 attempt" : `${details.attempts} attempts`;
    super(`Request failed${statusText} after ${attemptText}`, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "RetryExhaustedError";
    this.attempts = details.attempts;
    this.status = details.status;
    this.body = details.body;
    this.reason = details.reason;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "AbortError") {
    return false;
  }

  if (error.name === "TimeoutError") {
    return true;
  }

  const code = errorCode(error);
  if (code !== undefined && NETWORK_ERROR_CODES.has(code)) {
    return true;
  }

  if (/fetch failed|failed to fetch|network error|networkerror|socket hang up/i.test(error.message)) {
    return true;
  }

  return error.cause !== undefined && error.cause !== error && isRetryableNetworkError(error.cause);
}

export function retryAfterMilliseconds(headers: unknown, now: number = Date.now()): number | undefined {
  const value = headerValue(headers, "retry-after");
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.round(Number(trimmed) * 1_000);
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return Math.max(0, timestamp - now);
}

export async function withRetry<TResponse extends RetryResponse>(
  operation: (attempt: number) => Promise<TResponse>,
  options: RetryOptions = {}
): Promise<RetryResult<TResponse>> {
  const settings = retrySettings(options);

  for (let attempts = 1; attempts <= settings.maxAttempts; attempts += 1) {
    try {
      const response = await operation(attempts);
      assertStatus(response.status);

      if (response.status >= 200 && response.status <= 299) {
        return {
          value: response,
          attempts,
          status: response.status,
          body: response.body
        };
      }

      if (!isRetryableStatus(response.status)) {
        throw new RetryExhaustedError({
          attempts,
          status: response.status,
          body: response.body,
          reason: "non-retryable-status"
        });
      }

      if (attempts === settings.maxAttempts) {
        throw new RetryExhaustedError({
          attempts,
          status: response.status,
          body: response.body,
          reason: "max-attempts"
        });
      }

      const retryAfter = retryAfterMilliseconds(response.headers, settings.now());
      await settings.sleep(retryDelay(attempts, retryAfter, settings));
    } catch (error) {
      if (error instanceof RetryExhaustedError) {
        throw error;
      }

      const response = responseFromError(error);
      const retryable = response === undefined
        ? isRetryableNetworkError(error)
        : isRetryableStatus(response.status);

      if (!retryable || attempts === settings.maxAttempts) {
        throw new RetryExhaustedError({
          attempts,
          ...(response === undefined ? {} : { status: response.status, body: response.body }),
          reason: retryable ? "max-attempts" : response === undefined ? "non-retryable-error" : "non-retryable-status",
          cause: error
        });
      }

      const retryAfter = response === undefined
        ? undefined
        : retryAfterMilliseconds(response.headers, settings.now());
      await settings.sleep(retryDelay(attempts, retryAfter, settings));
    }
  }

  throw new Error("Retry loop ended unexpectedly");
}

interface RetrySettings {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  sleep: (delayMs: number) => Promise<void>;
  random: () => number;
  now: () => number;
}

function retrySettings(options: RetryOptions): RetrySettings {
  const settings: RetrySettings = {
    maxAttempts: options.maxAttempts ?? 5,
    baseDelayMs: options.baseDelayMs ?? 500,
    maxDelayMs: options.maxDelayMs ?? 30_000,
    jitterRatio: options.jitterRatio ?? 0.2,
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? Math.random,
    now: options.now ?? Date.now
  };

  if (!Number.isInteger(settings.maxAttempts) || settings.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  if (!Number.isFinite(settings.baseDelayMs) || settings.baseDelayMs < 0) {
    throw new RangeError("baseDelayMs must be a non-negative finite number");
  }
  if (!Number.isFinite(settings.maxDelayMs) || settings.maxDelayMs < settings.baseDelayMs) {
    throw new RangeError("maxDelayMs must be finite and at least baseDelayMs");
  }
  if (!Number.isFinite(settings.jitterRatio) || settings.jitterRatio < 0 || settings.jitterRatio > 1) {
    throw new RangeError("jitterRatio must be between 0 and 1");
  }

  return settings;
}

function retryDelay(attempt: number, retryAfter: number | undefined, settings: RetrySettings): number {
  const exponential = Math.min(settings.maxDelayMs, settings.baseDelayMs * (2 ** (attempt - 1)));
  const random = settings.random();
  if (!Number.isFinite(random) || random < 0 || random > 1) {
    throw new RangeError("random must return a number between 0 and 1");
  }

  const jittered = Math.round(exponential * (1 - settings.jitterRatio + (2 * settings.jitterRatio * random)));
  const boundedBackoff = Math.min(settings.maxDelayMs, jittered);
  return retryAfter === undefined ? boundedBackoff : Math.max(retryAfter, boundedBackoff);
}

function assertStatus(status: number): void {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError("operation must return a valid HTTP status");
  }
}

function errorCode(error: Error): string | undefined {
  const value = Reflect.get(error, "code");
  return typeof value === "string" ? value : undefined;
}

function responseFromError(error: unknown): ErrorResponse | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const response = isRecord(error.response) ? error.response : undefined;
  if (response === undefined || typeof response.status !== "number") {
    return undefined;
  }

  return {
    status: response.status,
    headers: response.headers,
    body: "data" in response ? response.data : response.body
  };
}

function headerValue(headers: unknown, requestedName: string): string | undefined {
  if (!isRecord(headers)) {
    return undefined;
  }

  const getter = headers.get;
  if (typeof getter === "function") {
    const value = Reflect.apply(getter, headers, [requestedName]);
    const normalized = normalizeHeaderValue(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === requestedName) {
      return normalizeHeaderValue(value);
    }
  }

  return undefined;
}

function normalizeHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(String).join(", ");
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
