// Node-only Cache API substitute. Real Request/Response bodies retain stream semantics.
export class MemoryCache {
  readonly #entries = new Map<string, { request: Request; response: Response }>();

  #request(input: RequestInfo | URL): Request {
    return input instanceof Request ? input : new Request(input);
  }

  #matchURL(request: Request, ignoreSearch = false): string {
    // Cache matching ignores URL fragments, while keys() retains the stored URL.
    if (ignoreSearch) {
      const url = new URL(request.url);
      url.hash = '';
      url.search = '';
      return url.href;
    }
    return request.url.split('#', 1)[0]!;
  }

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const request = this.#request(input);
    if (request.method !== 'GET') return undefined;
    return this.#entries.get(this.#matchURL(request))?.response.clone();
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    const request = this.#request(input);
    if (request.method !== 'GET') throw new TypeError('Cache only accepts GET requests.');
    this.#entries.set(this.#matchURL(request), { request: request.clone(), response: response.clone() });
  }

  async delete(input: RequestInfo | URL): Promise<boolean> {
    const request = this.#request(input);
    return request.method === 'GET' && this.#entries.delete(this.#matchURL(request));
  }

  async keys(input?: RequestInfo | URL, options: CacheQueryOptions = {}): Promise<Request[]> {
    const filter = input === undefined ? undefined : this.#request(input);
    if (filter && filter.method !== 'GET' && !options.ignoreMethod) return [];
    return [...this.#entries.values()]
      .filter(({ request, response }) => {
        if (!filter) return true;
        if (this.#matchURL(request, options.ignoreSearch) !== this.#matchURL(filter, options.ignoreSearch)) return false;
        const vary = response.headers.get('vary');
        return options.ignoreVary || vary === null || vary.split(',').map(field => field.trim()).filter(Boolean)
          .every(field => field !== '*' && request.headers.get(field) === filter.headers.get(field));
      })
      .map(({ request }) => request.clone());
  }
}

export class MemoryCacheStorage {
  readonly #caches = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    let cache = this.#caches.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.#caches.set(name, cache);
    }
    return cache;
  }

  async delete(name: string): Promise<boolean> {
    return this.#caches.delete(name);
  }

  async keys(): Promise<string[]> {
    return [...this.#caches.keys()];
  }
}
