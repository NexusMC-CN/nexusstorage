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
    for (const request of await cache.keys()) {
      if (request.method !== 'GET' || !request.url.startsWith(KEY_URL_PREFIX)) continue;
      try {
        const key: unknown = JSON.parse(decodeURIComponent(request.url.slice(KEY_URL_PREFIX.length)));
        if (typeof key === 'string' && keyURL(key) === request.url) entries.push({ key, request });
      } catch {
        // Foreign resources and malformed/noncanonical keys do not belong to this backend.
      }
    }
    return entries;
  }

  async #assertNoKeyConflict(cache: Cache, url: string): Promise<void> {
    // Cache match/put/delete ignore fragments, but fragment URLs are not owned keys.
    for (const request of await cache.keys()) {
      if (request.method === 'GET' && request.url !== url && request.url.split('#', 1)[0] === url) {
        throw new NexusStorageError('CORRUPT_DATA', 'A noncanonical Cache Storage entry conflicts with this key.');
      }
    }
  }

  async get(key: string): Promise<string | undefined> {
    return this.#execute(async (cache, api) => {
      const url = keyURL(key);
      await this.#assertNoKeyConflict(cache, url);
      const response = await cache.match(new api.Request(url));
      return response ? response.text() : undefined;
    });
  }

  async set(key: string, value: string): Promise<void> {
    return this.#execute(async (cache, api) => {
      const url = keyURL(key);
      await this.#assertNoKeyConflict(cache, url);
      await cache.put(new api.Request(url), new api.Response(value, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }));
    });
  }

  async update(key: string, transform: (raw: string | undefined) => string): Promise<string> {
    return this.#execute(async (cache, api) => {
      const url = keyURL(key);
      await this.#assertNoKeyConflict(cache, url);
      const request = new api.Request(url);
      const response = await cache.match(request);
      const updated = transform(response ? await response.text() : undefined);
      // Cache Storage has no transaction spanning this read and write across instances.
      await this.#assertNoKeyConflict(cache, url);
      await cache.put(request, new api.Response(updated, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }));
      return updated;
    });
  }

  async remove(key: string): Promise<boolean> {
    return this.#execute(async (cache, api) => {
      const url = keyURL(key);
      await this.#assertNoKeyConflict(cache, url);
      return cache.delete(new api.Request(url));
    });
  }

  async keys(): Promise<string[]> {
    return this.#execute(async cache => (await this.#ownedEntries(cache)).map(entry => entry.key).sort());
  }

  async clear(): Promise<void> {
    return this.#execute(async cache => {
      for (const { request } of await this.#ownedEntries(cache)) {
        await this.#assertNoKeyConflict(cache, request.url);
        await cache.delete(request);
      }
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
