import type { RawTransaction, StorageBackend } from './index.js';
import { runRawTransaction, snapshotTransactionKeys } from './transaction.js';
import { NexusStorageError } from '../errors.js';

export class MemoryBackend implements StorageBackend {
  readonly #entries = new Map<string, string>();
  #closed = false;

  // Each instance owns its data even when callers reuse the same namespace.
  constructor(_namespace?: string) {}

  #assertOpen(): void {
    if (this.#closed) throw new NexusStorageError('CLOSED', 'The storage instance is closed.');
  }

  #execute<T>(operation: () => T): T {
    this.#assertOpen();
    try {
      return operation();
    } catch (error) {
      if (error instanceof NexusStorageError) throw error;
      throw new NexusStorageError('STORAGE_ERROR', 'A memory storage operation failed.', { cause: error });
    }
  }

  async get(key: string): Promise<string | undefined> {
    return this.#execute(() => this.#entries.get(key));
  }

  async set(key: string, value: string): Promise<void> {
    this.#execute(() => { this.#entries.set(key, value); });
  }

  async update(key: string, transform: (raw: string | undefined) => string): Promise<string> {
    return this.#execute(() => {
      const updated = transform(this.#entries.get(key));
      this.#assertOpen();
      this.#entries.set(key, updated);
      return updated;
    });
  }

  async atomic<T>(keys: readonly string[], transform: (transaction: RawTransaction) => T): Promise<T> {
    this.#assertOpen();
    const scope = snapshotTransactionKeys(keys);
    const snapshot = new Map(scope.map(key => [key, this.#entries.get(key)]));
    const { result, writes } = runRawTransaction(snapshot, transform);
    this.#assertOpen();
    for (const [key, value] of writes) {
      if (value === undefined) this.#entries.delete(key);
      else this.#entries.set(key, value);
    }
    return result;
  }

  async remove(key: string): Promise<boolean> {
    return this.#execute(() => this.#entries.delete(key));
  }

  async keys(): Promise<string[]> {
    return this.#execute(() => [...this.#entries.keys()].sort());
  }

  async clear(): Promise<void> {
    this.#execute(() => this.#entries.clear());
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#entries.clear();
  }
}
