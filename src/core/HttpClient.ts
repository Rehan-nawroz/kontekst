// Centralized HTTP client with abort logic

export class HttpClient {
  private abortController?: AbortController;

  constructor() {
    this.abortController = new AbortController();
  }

  public setAbort(reason: string): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort(reason);
      this.abortController = new AbortController();
    }
  }

  public getSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  public async fetch<T>(
    url: string,
    options?: RequestInit
  ): Promise<T> {
    const response = await fetch(url, {
      ...options,
      signal: options?.signal || this.getSignal(),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  public abort(reason?: string): void {
    this.abortController?.abort(reason);
  }

  public isConnected(): boolean {
    return !this.getSignal()?.aborted;
  }
}
