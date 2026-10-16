/**
 * HttpClient — shared HTTP client for browser-extension fetch requests.
 *
 * Wraps two recurring patterns found across all three platform normalisers:
 * 1. Token caching   — check a global cache first; refetch after expiry.
 * 2. Request abort   — register an AbortController under an exportId so the
 *                      consumer can cancel outstanding work at any time.
 */

// ────────────────────────────── Interfaces ──────────────────────────────────

export interface HttpClientOptions {
  /** Unique export identifier used inside the page world to store/retrieve the AbortController. */
  exportId?: string | null;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
  headers: Headers;
  url: string;
}

// ────────────────────────────── Constants ───────────────────────────────────

const TOKEN_CACHE_EPOCH = 5 * 60 * 1000; // 5 minutes — matches source normalisers

// ────────────────────────────── AbortController registry ─────────────────────

let abortRegistry: Map<string, AbortController> | null = null;

/** Get or create an AbortController from the global registry keyed by exportId. */
export function getOrCreateAbortController(exportId: string): {
  controller: AbortController;
  signal: AbortSignal;
} {
  if (!abortRegistry) {
    const store = globalThis as { __kontekstAbort?: Map<string, AbortController> };
    abortRegistry = store.__kontekstAbort ??= new Map<string, AbortController>();
  }

  let controller = abortRegistry.get(exportId);
  if (!controller) {
    controller = new AbortController();
    abortRegistry.set(exportId, controller);
  }

  return { controller, signal: controller.signal };
}

// ────────────────── Token / session-cache layer (global shared) ─────────────

interface SessionCacheEntry {
  accessToken: string;
  updatedAt: number; // Date.now() timestamp
}

/** Read the global session cache for a given scope key (origin or null). */
function readSessionCache(scopeKey: string | null): SessionCacheEntry | null {
  const key = scopeKey ? `__kontekstAccessToken:${scopeKey}` : "__kontekstAccessToken";
  const cached = (globalThis as Record<string, unknown>)[key] as SessionCacheEntry | undefined;
  if (!cached) return null;
  return cached as SessionCacheEntry;
}

/** Persist a session token into the global cache. */
function writeSessionCache(token: string, scopeKey: string | null): void {
  const key = scopeKey ? `__kontekstAccessToken:${scopeKey}` : "__kontekstAccessToken";
  (globalThis as Record<string, unknown>)[key] = {
    accessToken: token,
    updatedAt: Date.now(),
  };
}

// ──────────────────────────── HttpClient class ──────────────────────────────

export class HttpClient {
  private readonly exportId: string | null;
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  private _cachedToken: SessionCacheEntry | string | null = null;
  private _cachedScopeKey: string | null = null;

  constructor(options?: HttpClientOptions) {
    this.exportId = options?.exportId ?? null;
  }

  // ── Abort helpers ────────────────────────────────────────────────────────

  /** Return the signal tied to this instance's exportId (creates one if needed). */
  private getSignal(): AbortSignal | undefined {
    if (!this.exportId) return undefined;
    const result = getOrCreateAbortController(this.exportId);
    return result.signal;
  }

  /** Abort every outstanding request tied to this instance. */
  abort(reason?: string): void {
    if (!this.exportId) return;
    const result = getOrCreateAbortController(this.exportId);
    result.controller.abort(reason);
  }

  /** Clear the registered AbortController from the global registry after export completes. */
  clearAbort(): void {
    if (!this.exportId || !abortRegistry) return;
    abortRegistry.delete(this.exportId);
    if (abortRegistry.size === 0) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as Record<string, unknown>).__kontekstAbort;
      abortRegistry = null;
    }
  }

  // ── Token / session helpers ──────────────────────────────────────────────

  /**
   * Fetch an access token with the source normalisers' TTL semantics:
   * - read the in-memory cache first, then the global session cache.
   * - refetch from `sessionFetcher` when expired or missing.
   */
  async getToken(
    scopeKey: string | null,
    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
    sessionFetcher?: (signal?: AbortSignal) => Promise<string | null>
  ): Promise<string | null> {
    const now = Date.now();

    // ── check in-memory cache ──
    if (this._cachedToken && this._cachedScopeKey === scopeKey) {
      if (typeof this._cachedToken !== "string") {
        if (now - this._cachedToken.updatedAt < TOKEN_CACHE_EPOCH) {
          return this._cachedToken.accessToken;
        }
      } else {
        // legacy single-string cache key — accept it
        return this._cachedToken as string;
      }
    }

    // ── check global session cache ──
    const cached = readSessionCache(scopeKey);
    if (cached && now - cached.updatedAt < TOKEN_CACHE_EPOCH) {
      this._cachedToken = cached;
      this._cachedScopeKey = scopeKey;
      return cached.accessToken;
    }

    // ── fetch fresh via session endpoint ──
    const signal = this.getSignal();
    if (sessionFetcher) {
      const token = await sessionFetcher(signal);
      if (!token) return null;

      // Persist to both in-memory and global caches.
      writeSessionCache(token, scopeKey);
      this._cachedToken = { accessToken: token, updatedAt: now };
      this._cachedScopeKey = scopeKey;
      return token;
    }

    return null;
  }

  /** Invalidate the in-memory cached token (e.g. after a 401). */
  invalidateToken(): void {
    this._cachedToken = null;
  }

  // ── Public fetch helpers ─────────────────────────────────────────────────

  /** Build Authorization header from a known token. */
  private headersWithAuth(token: string | null, extra?: Record<string, string>): Record<string, string> | undefined {
    if (!token) return extra ? { ...extra } : undefined;
    const h = extra ? { ...extra } : {};
    h.Authorization = `Bearer ${token}`;
    return h;
  }

  /** Fetch with automatic token injection and abort signal wiring. */
  async fetch(
    url: string,
    init?: RequestInit & { sessionId?: string }
  ): Promise<FetchResponse> {
    const scopeKey = init?.sessionId ?? null;
    const signal = this.getSignal() ?? init?.signal;

    // Resolve token.
    let token: string | null = null;
    if (url.includes("/api/auth/session")) {
      // Self-serving — just pass through the request without auth overhead.
      token = null;
    } else {
      token = await this.getToken(scopeKey, init?.sessionId ? undefined : undefined);
    }

    const headers = this.headersWithAuth(token) ?? {};

    const response = await fetch(url, { ...init, signal, headers, credentials: "include" });

    if (!response.ok) {
      throw new Error(`${url}: ${response.status}`);
    }

    return response;
  }

  /** Convenience: fetch and parse JSON. */
  async fetchJson<T>(
    url: string,
    sessionId?: string
  ): Promise<T> {
    const res = await this.fetch(url, { sessionId });
    return res.json<T>();
  }

  /** Convenience: fetch and parse text. */
  async fetchText(url: string, sessionId?: string): Promise<string> {
    const res = await this.fetch(url, { sessionId });
    return res.text();
  }

  /** Convenience: fetch and read a Blob. */
  async fetchBlob(url: string, sessionId?: string): Promise<Blob> {
    const res = await this.fetch(url, { sessionId });
    return res.blob();
  }
}
