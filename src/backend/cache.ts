import type { StorageBackend } from './index.js';
import { NexusStorageError } from '../errors.js';

const KEY_URL_PREFIX = 'https://nexusstorage.invalid/v1/';

interface CacheAPI {
  caches: CacheStorage;
  Request: typeof Request;
  Response: typeof Response;
}

function keyURL(key: string): string {
  return KEY_URL_PREFIX + encodeURIComponent(JSON.stringify(key));
}

function contentType(value: string): string {
  if (/^NexusStorage\/\d+\n/.test(value)) return 'application/x.nexusstorage-record; charset=utf-8';
  try {
    JSON.parse(value);
    return 'application/json; charset=utf-8';
  } catch {
    return 'text/plain; charset=utf-8';
  }
}

export class CacheStorageBackend implements StorageBackend {
  readonly #name: string;
  #closed = false;

  constructor(namespace: string) {
    this.#name = `nexusstorage:${JSON.stringify(namespace)}`;
  }

  #getAPI(): CacheAPI {
    if (this.#closed) throw new NexusStorageError('CLOSED', 'The storage instance is closed.');
    try {
      const caches = globalThis.caches;
      const Request = globalThis.Request;
      const Response = globalThis.Response;
      if (!caches || typeof caches.open !== 'function'
        || typeof Request !== 'function' || typeof Response !== 'function') {
        throw new NexusStorageError('STORAGE_UNAVAILABLE', 'Cache Storage is not available.');
      }
      return { caches, Request, Response };
    } catch (error) {
      if (error instanceof NexusStorageError) throw error;
      throw new NexusStorageError('STORAGE_UNAVAILABLE', 'Unable to access Cache Storage.', { cause: error });
    }
  }

  async #execute<T>(operation: (cache: Cache, api: CacheAPI) => Promise<T>): Promise<T> {
    try {
      const api = this.#getAPI();
      // Reopen each time: another context may have deleted and recreated this cache.
      const cache = await api.caches.open(this.#name);
      return await operation(cache, api);
    } catch (error) {
      if (error instanceof NexusStorageError) throw error;
      throw new NexusStorageError('STORAGE_ERROR', 'A Cache Storage operation failed.', { cause: error });
    }
  }

  async #ownedEntries(cache: Cache): Promise<Array<{ key: string; request: Request }>> {
    const entries: Array<{ key: string; request: Request }> = [];
    const fragmentURLs = new Set<string>();
    for (const request of await cache.keys()) {
      if (request.method !== 'GET') continue;
      const baseURL = request.url.split('#', 1)[0]!;
      if (baseURL !== request.url) fragmentURLs.add(baseURL);
      if (!request.url.startsWith(KEY_URL_PREFIX)) continue;
      try {
        const key: unknown = JSON.parse(decodeURIComponent(request.url.slice(KEY_URL_PREFIX.length)));
        if (typeof key === 'string' && keyURL(key) === request.url) entries.push({ key, request });
      } catch {
        // Foreign resources and malformed/noncanonical keys do not belong to this backend.
      }
    }
    // Validate the complete snapshot before reading responses or deleting any entry.
    const canonicalURLs = new Set<string>();
    for (const { request } of entries) {
      if (fragmentURLs.has(request.url) || canonicalURLs.has(request.url)) {
        throw new NexusStorageError('CORRUPT_DATA', 'Multiple Cache Storage entries conflict with this key.');
      }
      canonicalURLs.add(request.url);
    }
    return entries;
  }

  async #matchedResponse(cache: Cache, request: Request): Promise<Response | undefined> {
    const response = await cache.match(request);
    // Internal records are a single value per key, independent of HTTP request headers.
    if (response?.headers.get('vary')?.trim()) {
      throw new NexusStorageError('CORRUPT_DATA', 'An internal Cache Storage response must not vary by request headers.');
    }
    return response;
  }

  async #assertNoKeyConflict(cache: Cache, canonical: Request): Promise<void> {
    // Cache match/put/delete ignore fragments, but fragment URLs are not owned keys.
    // Vary must not hide foreign variants from this ownership check.
    // Supplying the request limits returned entries; browser lookup complexity is unspecified.
    let owned: Request | undefined;
    for (const request of await cache.keys(canonical, { ignoreVary: true })) {
      if (request.method === 'GET' && request.url !== canonical.url && request.url.split('#', 1)[0] === canonical.url) {
        throw new NexusStorageError('CORRUPT_DATA', 'A noncanonical Cache Storage entry conflicts with this key.');
      }
      if (request.method === 'GET' && request.url === canonical.url) {
        if (owned) throw new NexusStorageError('CORRUPT_DATA', 'Multiple Cache Storage entries conflict with this key.');
        owned = request;
      }
    }
    // Match the unique saved request to inspect Vary even when a headerless request cannot match it.
    if (owned) await this.#matchedResponse(cache, owned);
  }

  async get(key: string): Promise<string | undefined> {
    return this.#execute(async (cache, api) => {
      const request = new api.Request(keyURL(key));
      await this.#assertNoKeyConflict(cache, request);
      const response = await this.#matchedResponse(cache, request);
      return response ? response.text() : undefined;
    });
  }

  async set(key: string, value: string): Promise<void> {
    return this.#execute(async (cache, api) => {
      const request = new api.Request(keyURL(key));
      await this.#assertNoKeyConflict(cache, request);
      await cache.put(request, new api.Response(value, {
        headers: { 'content-type': contentType(value) },
      }));
    });
  }

  async update(key: string, transform: (raw: string | undefined) => string): Promise<string> {
    return this.#execute(async (cache, api) => {
      const request = new api.Request(keyURL(key));
      await this.#assertNoKeyConflict(cache, request);
      const response = await this.#matchedResponse(cache, request);
      const updated = transform(response ? await response.text() : undefined);
      // Cache Storage has no transaction spanning this read and write across instances.
      await this.#assertNoKeyConflict(cache, request);
      await cache.put(request, new api.Response(updated, {
        headers: { 'content-type': contentType(updated) },
      }));
      return updated;
    });
  }

  async remove(key: string): Promise<boolean> {
    return this.#execute(async (cache, api) => {
      const request = new api.Request(keyURL(key));
      await this.#assertNoKeyConflict(cache, request);
      return cache.delete(request);
    });
  }

  async keys(): Promise<string[]> {
    return this.#execute(async cache => {
      const entries = await this.#ownedEntries(cache);
      for (const { request } of entries) await this.#matchedResponse(cache, request);
      return entries.map(entry => entry.key).sort();
    });
  }

  async scan(visit: (entry: { key: string; value: string }) => void): Promise<void> {
    return this.#execute(async cache => {
      const entries = await this.#ownedEntries(cache);
      for (const { key, request } of entries) {
        const response = await this.#matchedResponse(cache, request);
        if (response) visit({ key, value: await response.text() });
      }
    });
  }

  async clear(): Promise<void> {
    return this.#execute(async cache => {
      // This snapshot has no transaction with deletion across Cache Storage users.
      const entries = await this.#ownedEntries(cache);
      // Reject all malformed internal variants before deleting the first valid record.
      for (const { request } of entries) await this.#matchedResponse(cache, request);
      for (const { request } of entries) {
        await cache.delete(request);
      }
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
