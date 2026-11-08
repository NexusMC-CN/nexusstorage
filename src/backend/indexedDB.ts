import type { RawTransaction, StorageBackend } from './index.js';
import { runRawTransaction, snapshotTransactionKeys } from './transaction.js';
import { NexusStorageError } from '../errors.js';

interface TransactionHandlers<T> {
  result(value: T): void;
  listen<R>(request: IDBRequest<R>, onSuccess: (value: R) => void): void;
  abort(error: unknown, preserve?: boolean): void;
}

function storageError(message: string, cause: unknown): NexusStorageError {
  return new NexusStorageError('STORAGE_ERROR', message, { cause });
}

function closedError(): NexusStorageError {
  return new NexusStorageError('CLOSED', 'This storage instance is closed.');
}

function readValue(cursor: IDBCursorWithValue | null): string | undefined {
  if (cursor === null) return undefined;
  const value: unknown = cursor.value;
  if (typeof value !== 'string') {
    throw new NexusStorageError('CORRUPT_DATA', 'The stored IndexedDB value is not a JSON string.');
  }
  return value;
}

export class IndexedDBBackend implements StorageBackend {
  private readonly databaseName: string;
  private connection: IDBDatabase | undefined;
  private opening: Promise<IDBDatabase> | undefined;
  private cancelOpening: ((error: NexusStorageError) => void) | undefined;
  private closed = false;

  constructor(namespace: string) {
    this.databaseName = `nexusstorage:${JSON.stringify(namespace)}`;
  }

  async get(key: string): Promise<string | undefined> {
    return this.runTransaction('readonly', (store, handlers) => {
      // A cursor distinguishes a missing key from an invalid stored undefined value.
      handlers.listen(store.openCursor(key), (cursor) => handlers.result(readValue(cursor)));
    });
  }

  async set(key: string, value: string): Promise<void> {
    return this.runTransaction('readwrite', (store, handlers) => {
      store.put(value, key);
      handlers.result(undefined);
    });
  }

  async update(key: string, transform: (raw: string | undefined) => string): Promise<string> {
    return this.runTransaction('readwrite', (store, handlers) => {
      handlers.listen(store.openCursor(key), (cursor) => {
        const raw = readValue(cursor);
        let value: string;
        try {
          value = transform(raw);
        } catch (error) {
          handlers.abort(error, true);
          return;
        }
        store.put(value, key);
        handlers.result(value);
      });
    });
  }

  async atomic<T>(keys: readonly string[], transform: (transaction: RawTransaction) => T): Promise<T> {
    const scope = snapshotTransactionKeys(keys);
    return this.runTransaction('readwrite', (store, handlers) => {
      const snapshot = new Map<string, string | undefined>();
      const apply = () => {
        let transformed: ReturnType<typeof runRawTransaction<T>>;
        try {
          if (this.closed) throw closedError();
          transformed = runRawTransaction(snapshot, transform);
          if (this.closed) throw closedError();
        } catch (error) {
          handlers.abort(error, true);
          return;
        }
        for (const [key, value] of transformed.writes) {
          if (value === undefined) store.delete(key);
          else store.put(value, key);
        }
        handlers.result(transformed.result);
      };

      if (scope.length === 0) {
        // A request event ensures even an empty callback runs inside the active transaction.
        handlers.listen(store.count(), apply);
        return;
      }
      let remaining = scope.length;
      for (const key of scope) {
        handlers.listen(store.openCursor(key), cursor => {
          snapshot.set(key, readValue(cursor));
          if (--remaining === 0) apply();
        });
      }
    });
  }

  async remove(key: string): Promise<boolean> {
    return this.runTransaction('readwrite', (store, handlers) => {
      handlers.listen(store.count(key), (count) => {
        if (count > 0) store.delete(key);
        handlers.result(count > 0);
      });
    });
  }

  async keys(): Promise<string[]> {
    return this.runTransaction('readonly', (store, handlers) => {
      handlers.listen(store.getAllKeys(), (keys) => {
        if (keys.some((key) => typeof key !== 'string')) {
          throw new NexusStorageError('CORRUPT_DATA', 'The stored IndexedDB key is not a string.');
        }
        handlers.result((keys as string[]).sort());
      });
    });
  }

  async clear(): Promise<void> {
    return this.runTransaction('readwrite', (store, handlers) => {
      store.clear();
      handlers.result(undefined);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connection?.close();
    this.connection = undefined;
    this.cancelOpening?.(closedError());
  }

  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(closedError());
    if (this.connection) return Promise.resolve(this.connection);
    if (this.opening) return this.opening;

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (error: NexusStorageError) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      this.cancelOpening = fail;

      let request: IDBOpenDBRequest;
      try {
        const factory = globalThis.indexedDB;
        if (!factory || typeof factory.open !== 'function') {
          fail(new NexusStorageError('STORAGE_UNAVAILABLE', 'IndexedDB is not available in this environment.'));
          return;
        }
        request = factory.open(this.databaseName, 1);
      } catch (cause) {
        fail(storageError('Could not open the IndexedDB database.', cause));
        return;
      }

      request.onupgradeneeded = () => {
        try {
          if (!request.result.objectStoreNames.contains('entries')) request.result.createObjectStore('entries');
        } catch (cause) {
          fail(storageError('Could not initialize the IndexedDB database.', cause));
          request.transaction?.abort();
        }
      };
      request.onblocked = () => {
        fail(new NexusStorageError('DATABASE_BLOCKED', 'Another connection is blocking the IndexedDB database.'));
      };
      request.onerror = () => fail(storageError('Could not open the IndexedDB database.', request.error));
      request.onsuccess = () => {
        const database = request.result;
        // Open requests cannot be cancelled, so rejected requests still need cleanup.
        if (settled || this.closed) {
          database.close();
          fail(closedError());
          return;
        }
        database.onversionchange = () => {
          database.close();
          if (this.connection === database) this.connection = undefined;
        };
        database.onclose = () => {
          if (this.connection === database) this.connection = undefined;
        };
        this.connection = database;
        settled = true;
        resolve(database);
      };
    });
    this.opening = opening;
    const resetOpening = () => {
      if (this.opening === opening) {
        this.opening = undefined;
        this.cancelOpening = undefined;
      }
    };
    void opening.then(resetOpening, resetOpening);
    return opening;
  }

  private async runTransaction<T>(
    mode: IDBTransactionMode,
    execute: (store: IDBObjectStore, handlers: TransactionHandlers<T>) => void,
  ): Promise<T> {
    const database = await this.open();
    if (this.closed) throw closedError();

    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction('entries', mode);
      } catch (cause) {
        reject(storageError('Could not create an IndexedDB transaction.', cause));
        return;
      }

      let result: T;
      let failure: unknown;
      let hasFailure = false;
      let preserveFailure = false;
      const rejectFailure = () => reject(preserveFailure || failure instanceof NexusStorageError
        ? failure
        : storageError('The IndexedDB transaction failed.', failure));

      const handlers: TransactionHandlers<T> = {
        result(value) { result = value; },
        listen(request, onSuccess) {
          request.onsuccess = () => {
            if (hasFailure) return;
            try {
              onSuccess(request.result);
            } catch (cause) {
              handlers.abort(cause);
            }
          };
        },
        abort(error, preserve = false) {
          if (!hasFailure) {
            failure = error;
            hasFailure = true;
            preserveFailure = preserve;
          }
          try {
            transaction.abort();
          } catch {
            rejectFailure();
          }
        },
      };

      // Request success does not imply commit: resolve only on transaction complete.
      transaction.oncomplete = () => hasFailure ? rejectFailure() : resolve(result);
      transaction.onerror = (event) => {
        if (!hasFailure) {
          failure = (event.target as IDBRequest).error ?? transaction.error;
          hasFailure = true;
        }
      };
      transaction.onabort = () => {
        if (!hasFailure) {
          failure = transaction.error ?? new DOMException('The IndexedDB transaction was aborted.', 'AbortError');
          hasFailure = true;
        }
        rejectFailure();
      };
      try {
        execute(transaction.objectStore('entries'), handlers);
      } catch (cause) {
        handlers.abort(cause);
      }
    });
  }
}
