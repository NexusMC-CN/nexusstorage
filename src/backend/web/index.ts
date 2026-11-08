import type { StorageBackend } from '../index.js';
import { NexusStorageError } from '../../errors.js';

export class WebStorageBackend implements StorageBackend {
  readonly #prefix: string;
  readonly #driver: 'localStorage' | 'sessionStorage';
  #closed = false;

  constructor(namespace: string, driver: 'localStorage' | 'sessionStorage') {
    this.#prefix = `nexusstorage:${JSON.stringify(namespace)}:`;
    this.#driver = driver;
  }

  #getStorage(): Storage {
    if (this.#closed) throw new NexusStorageError('CLOSED', 'The storage instance is closed.');
    try {
      const storage = globalThis[this.#driver];
      if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function'
        || typeof storage.removeItem !== 'function' || typeof storage.key !== 'function') {
        throw new NexusStorageError('STORAGE_UNAVAILABLE', `${this.#driver} is not available.`);
      }
      return storage;
    } catch (error) {
      if (error instanceof NexusStorageError) throw error;
      throw new NexusStorageError('STORAGE_UNAVAILABLE', `Unable to access ${this.#driver}.`, { cause: error });
    }
  }

  #execute<T>(operation: (storage: Storage) => T): T {
    try {
      return operation(this.#getStorage());
    } catch (error) {
      if (error instanceof NexusStorageError) throw error;
      throw new NexusStorageError('STORAGE_ERROR', `A ${this.#driver} operation failed.`, { cause: error });
    }
  }

  #ownedKeys(storage: Storage): string[] {
    const keys: string[] = [];
    const length = storage.length;
    for (let index = 0; index < length; index++) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(this.#prefix)) keys.push(key.slice(this.#prefix.length));
    }
    return keys;
  }

  async get(key: string): Promise<string | undefined> {
    return this.#execute((storage) => storage.getItem(this.#prefix + key) ?? undefined);
  }

  async set(key: string, value: string): Promise<void> {
    this.#execute((storage) => storage.setItem(this.#prefix + key, value));
  }

  async update(key: string, transform: (raw: string | undefined) => string): Promise<string> {
    return this.#execute((storage) => {
      const physicalKey = this.#prefix + key;
      const updated = transform(storage.getItem(physicalKey) ?? undefined);
      storage.setItem(physicalKey, updated);
      return updated;
    });
  }

  async remove(key: string): Promise<boolean> {
    return this.#execute((storage) => {
      const physicalKey = this.#prefix + key;
      const existed = storage.getItem(physicalKey) !== null;
      if (existed) storage.removeItem(physicalKey);
      return existed;
    });
  }

  async keys(): Promise<string[]> {
    return this.#execute((storage) => this.#ownedKeys(storage).sort());
  }

  async clear(): Promise<void> {
    this.#execute((storage) => {
      for (const key of this.#ownedKeys(storage)) storage.removeItem(this.#prefix + key);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
