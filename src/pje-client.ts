import axios, {
  type AxiosRequestConfig,
  type AxiosResponse
} from "axios";
import { Buffer } from "node:buffer";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";

export type Sleep = (milliseconds: number) => Promise<void>;

export interface PjeClientOptions {
  baseUrl: string;
  delayMs?: number;
  timeoutMs?: number;
  sleep?: Sleep;
}

export type PjeHeaders = Record<string, string | string[]>;

export interface PjeResponse<T> {
  status: number;
  headers: PjeHeaders;
  body: T;
  finalUrl: string;
}

const defaultSleep: Sleep = async (milliseconds) => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

export class PjeClient {
  private readonly baseUrl: string;
  private readonly delayMs: number;
  private readonly sleep: Sleep;
  private readonly http;
  private queue: Promise<void> = Promise.resolve();
  private hasRequested = false;

  public constructor(options: PjeClientOptions) {
    this.baseUrl = new URL(options.baseUrl).toString();
    this.delayMs = options.delayMs ?? 1_000;
    this.sleep = options.sleep ?? defaultSleep;

    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.delayMs) || this.delayMs < 0) {
      throw new RangeError("delayMs must be a non-negative finite number");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive finite number");
    }

    this.http = wrapper(
      axios.create({
        timeout: timeoutMs,
        jar: new CookieJar(),
        withCredentials: true,
        maxRedirects: 10,
        responseType: "arraybuffer",
        validateStatus: () => true,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
          "User-Agent":
            "scraper-challenge/1.0 (educational, rate-limited TRF5 public-data scraper)"
        }
      })
    );
  }

  public resolveUrl(url: string): string {
    return new URL(url, this.baseUrl).toString();
  }

  public async getText(url: string, referer?: string): Promise<PjeResponse<string>> {
    return this.requestText({
      method: "GET",
      url: this.resolveUrl(url),
      headers: this.requestHeaders(referer)
    });
  }

  public async postFormText(
    url: string,
    form: URLSearchParams,
    referer?: string
  ): Promise<PjeResponse<string>> {
    return this.requestText({
      method: "POST",
      url: this.resolveUrl(url),
      data: form.toString(),
      headers: this.formHeaders(referer)
    });
  }

  public async getBinary(url: string, referer?: string): Promise<PjeResponse<Buffer>> {
    return this.requestBinary({
      method: "GET",
      url: this.resolveUrl(url),
      headers: this.requestHeaders(referer)
    });
  }

  public async postFormBinary(
    url: string,
    form: URLSearchParams,
    referer?: string
  ): Promise<PjeResponse<Buffer>> {
    return this.requestBinary({
      method: "POST",
      url: this.resolveUrl(url),
      data: form.toString(),
      headers: this.formHeaders(referer)
    });
  }

  private async requestText(config: AxiosRequestConfig): Promise<PjeResponse<string>> {
    const response = await this.perform(config);
    const buffer = this.toBuffer(response.data);
    const contentType = response.headers["content-type"];
    const body = buffer.toString(this.encodingFor(contentType));

    return this.result(response, body, config.url ?? this.baseUrl);
  }

  private async requestBinary(config: AxiosRequestConfig): Promise<PjeResponse<Buffer>> {
    const response = await this.perform(config);
    return this.result(
      response,
      this.toBuffer(response.data),
      config.url ?? this.baseUrl
    );
  }

  private perform(config: AxiosRequestConfig): Promise<AxiosResponse<ArrayBuffer>> {
    return this.enqueue(() => this.http.request<ArrayBuffer>(config));
  }

  private enqueue<T>(request: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => {
      if (this.hasRequested && this.delayMs > 0) {
        await this.sleep(this.delayMs);
      }
      this.hasRequested = true;
      return request();
    });

    this.queue = pending.then(
      () => undefined,
      () => undefined
    );

    return pending;
  }

  private requestHeaders(referer?: string): Record<string, string> {
    if (referer === undefined) {
      return {};
    }
    return { Referer: this.resolveUrl(referer) };
  }

  private formHeaders(referer?: string): Record<string, string> {
    return {
      ...this.requestHeaders(referer),
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest"
    };
  }

  private encodingFor(contentType: unknown): "latin1" | "utf8" {
    const value = Array.isArray(contentType) ? contentType.join(";") : String(contentType ?? "");
    return /charset\s*=\s*["']?(?:iso-8859-1|latin-?1)\b/i.test(value)
      ? "latin1"
      : "utf8";
  }

  private toBuffer(data: ArrayBuffer): Buffer {
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
  }

  private result<T>(
    response: AxiosResponse<ArrayBuffer>,
    body: T,
    requestedUrl: string
  ): PjeResponse<T> {
    return {
      status: response.status,
      headers: this.normalizeHeaders(response.headers),
      body,
      finalUrl: response.request?.res?.responseUrl ?? requestedUrl
    };
  }

  private normalizeHeaders(headers: AxiosResponse<ArrayBuffer>["headers"]): PjeHeaders {
    const normalized: PjeHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === null || value === undefined) {
        continue;
      }
      normalized[name.toLowerCase()] = Array.isArray(value)
        ? value.map(String)
        : String(value);
    }
    return normalized;
  }
}
