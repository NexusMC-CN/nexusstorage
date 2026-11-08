import { IndexedDBBackend } from '../backend/indexedDB.js';
import { WebStorageBackend } from '../backend/web/index.js';
import { CacheStorageBackend } from '../backend/cache.js';
import { MemoryBackend } from '../backend/memory.js';
import type { StorageBackend } from '../backend/index.js';
import { assertSynchronousResult } from '../backend/transaction.js';
import { NexusStorageError } from '../errors.js';
import { snapshotJson } from '../json.js';
import { decodeRecord, isExpired, revisionOf, snapshotWriteOptions } from '../record/index.js';
import type { WriteOptions } from '../record/index.js';
import { snapshotSchemas } from '../schema.js';
import type { InferSchemaInput, InferSchemaOutput, StorageSchemas } from '../schema.js';
import type { FreeStorageKey, StorageKey, JsonInput, JsonObject, JsonValue, NexusStorageOptions } from '../types.js';
import { capabilitiesFor } from '../capabilities.js';
import type { StorageCapabilities } from '../capabilities.js';
import { StorageEvents } from '../events.js';
import type { StorageEventListener, StorageEventType, StorageOperation } from '../events.js';
import { RecordCodec, TransactionContext } from '../record/context.js';
import type { SchemaJsonInput, SchemaPatch, UnknownInputKey, StorageEntry, StorageTransaction, SynchronousResult } from './api.js';

/** A namespaced, asynchronous JSON store. Browser APIs are accessed lazily. */
export class NexusStorage<S extends StorageSchemas = Record<never, never>> {
  private readonly backend: StorageBackend;
  readonly capabilities: StorageCapabilities;
  private readonly codec: RecordCodec;
  private readonly events: StorageEvents;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(options: NexusStorageOptions<S> = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new NexusStorageError('INVALID_OPTIONS', 'Options must be an object.');
    }
    const driver = options.driver ?? 'localStorage';
    const namespace = options.namespace ?? 'nexusstorage';
    if (!['memory', 'localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage'].includes(driver)
      || typeof namespace !== 'string' || (options.broadcast !== undefined && typeof options.broadcast !== 'boolean')) {
      throw new NexusStorageError('INVALID_OPTIONS', 'Expected a supported driver and a string namespace.');
    }
    this.capabilities = capabilitiesFor(driver);
    this.codec = new RecordCodec(snapshotSchemas(options.schemas), this.capabilities.compareAndSwap);
    this.events = new StorageEvents(driver, namespace, options.broadcast ?? false);
    switch (driver) {
      case 'memory':
        this.backend = new MemoryBackend(namespace);
        break;
      case 'localStorage':
      case 'sessionStorage':
        this.backend = new WebStorageBackend(namespace, driver);
        break;
      case 'indexedDB':
        this.backend = new IndexedDBBackend(namespace);
        break;
      case 'cacheStorage':
        this.backend = new CacheStorageBackend(namespace);
        break;
    }
  }

  set<T extends JsonValue, K extends UnknownInputKey<S> = UnknownInputKey<S>>(key: K, value: T, options?: WriteOptions): Promise<InferSchemaOutput<S[K]>>;
  set<K extends Extract<keyof S, string>, V = InferSchemaInput<S[K]>>(key: K, value: SchemaJsonInput<S[K], V>, options?: WriteOptions): Promise<InferSchemaOutput<S[K]>>;
  set<T extends JsonValue>(key: FreeStorageKey<S>, value: T, options?: WriteOptions): Promise<T>;
  set<T>(key: FreeStorageKey<S>, value: T & JsonInput<T>, options?: WriteOptions): Promise<T>;
  async set(key: string, value: unknown, options?: WriteOptions): Promise<unknown> {
    this.assertKey(key);
    const snapshot = snapshotJson(value);
    const settings = snapshotWriteOptions(options);
    return this.enqueue(async () => {
      const now = Date.now();
      this.events.prepare();
      const raw = this.codec.set(key, snapshot, settings, now);
      await this.backend.set(key, raw);
      this.events.publish({ type: 'change', operation: 'set', key });
      return decodeRecord(raw).value;
    });
  }

  get<K extends Extract<keyof S, string>>(key: K): Promise<InferSchemaOutput<S[K]> | undefined>;
  get<T = JsonValue>(key: FreeStorageKey<S>): Promise<T | undefined>;
  async get(key: string): Promise<unknown> {
    this.assertKey(key);
    return this.enqueue(async () => {
      return this.codec.entry(key, await this.backend.get(key))?.value;
    });
  }

  getEntry<K extends Extract<keyof S, string>>(key: K): Promise<StorageEntry<InferSchemaOutput<S[K]>> | undefined>;
  getEntry<T = JsonValue>(key: FreeStorageKey<S>): Promise<StorageEntry<T> | undefined>;
  async getEntry(key: string): Promise<StorageEntry<unknown> | undefined> {
    this.assertKey(key);
    return this.enqueue(async () => this.codec.entry(key, await this.backend.get(key)));
  }

  update<K extends Extract<keyof S, string>, P extends object = JsonObject>(key: K, patch: SchemaPatch<S[K], P>, options?: WriteOptions): Promise<InferSchemaOutput<S[K]>>;
  update<T extends object = JsonObject>(key: FreeStorageKey<S>, patch: Partial<T> & JsonInput<Partial<T>>, options?: WriteOptions): Promise<T>;
  async update(key: string, patch: unknown, options?: WriteOptions): Promise<unknown> {
    this.assertKey(key);
    const snapshot = snapshotJson(patch);
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new NexusStorageError('TYPE_MISMATCH', 'The update patch must be a JSON object.');
    }
    const settings = snapshotWriteOptions(options);
    return this.enqueue(async () => {
      const now = Date.now();
      this.events.prepare();
      const raw = await this.backend.update(key, current => this.codec.update(key, current, snapshot, settings, now));
      this.events.publish({ type: 'change', operation: 'update', key });
      return decodeRecord(raw).value;
    });
  }

  compareAndSwap<T extends JsonValue, K extends UnknownInputKey<S> = UnknownInputKey<S>>(key: K, expectedRevision: string | null, value: T, options?: WriteOptions): Promise<StorageEntry<InferSchemaOutput<S[K]>>>;
  compareAndSwap<K extends Extract<keyof S, string>, V = InferSchemaInput<S[K]>>(key: K, expectedRevision: string | null, value: SchemaJsonInput<S[K], V>, options?: WriteOptions): Promise<StorageEntry<InferSchemaOutput<S[K]>>>;
  compareAndSwap<T extends JsonValue>(key: FreeStorageKey<S>, expectedRevision: string | null, value: T, options?: WriteOptions): Promise<StorageEntry<T>>;
  compareAndSwap<T>(key: FreeStorageKey<S>, expectedRevision: string | null, value: T & JsonInput<T>, options?: WriteOptions): Promise<StorageEntry<T>>;
  async compareAndSwap(key: string, expectedRevision: string | null, value: unknown, options?: WriteOptions): Promise<StorageEntry<unknown>> {
    this.assertKey(key);
    if (!this.backend.atomic) throw new NexusStorageError('UNSUPPORTED_OPERATION', 'This driver does not support atomic compare-and-swap.');
    if (expectedRevision !== null && (typeof expectedRevision !== 'string' || expectedRevision.length === 0)) {
      throw new NexusStorageError('INVALID_OPTIONS', 'The expected revision must be a nonempty string or null.');
    }
    const snapshot = snapshotJson(value);
    const settings = snapshotWriteOptions(options);
    return this.enqueue(async () => {
      const now = Date.now();
      this.events.prepare();
      const result = await this.backend.atomic!([key], tx => {
        const current = tx.get(key);
        const record = current === undefined ? undefined : decodeRecord(current);
        const actual = !record || isExpired(record, Date.now()) ? null : revisionOf(current!, record);
        if (actual !== expectedRevision) throw new NexusStorageError('CONFLICT', 'The stored revision has changed.');
        const raw = this.codec.set(key, snapshot, settings, now);
        tx.set(key, raw);
        // Do not revalidate or hide a ttl:0 write when returning the committed value.
        const saved = decodeRecord(raw);
        const entry: StorageEntry = { value: saved.value, revision: revisionOf(raw, saved) };
        if (saved.expiresAt !== undefined) entry.expiresAt = saved.expiresAt;
        return entry;
      });
      this.events.publish({ type: 'change', operation: 'compareAndSwap', key });
      return result;
    });
  }

  async transaction<T>(keys: readonly StorageKey<S>[], callback: (tx: StorageTransaction<S>) => SynchronousResult<T>): Promise<T> {
    this.assertOpen();
    if (!this.backend.atomic) throw new NexusStorageError('UNSUPPORTED_OPERATION', 'This driver does not support transactions.');
    if (!Array.isArray(keys) || typeof callback !== 'function') {
      throw new NexusStorageError('INVALID_OPTIONS', 'Transactions require a key array and a synchronous callback.');
    }
    const scope = [...new Set(keys)];
    for (const key of scope) this.assertKey(key);
    return this.enqueue(async () => {
      const now = Date.now();
      this.events.prepare();
      const changes = new Map<string, StorageOperation>();
      const result = await this.backend.atomic!(scope, raw => {
        const initial = new Map(scope.map(key => [key, raw.get(key)]));
        const context = new TransactionContext(raw, this.codec, now, (key, operation) => { changes.set(key, operation); });
        let value: SynchronousResult<T>;
        try {
          value = callback(context as unknown as StorageTransaction<S>);
        } finally {
          context.deactivate();
        }
        assertSynchronousResult(value);
        // Capture the result while failure can still abort all writes. In particular,
        // a caller-owned Proxy must never reach Promise resolution after commit.
        const snapshot = value === undefined ? undefined : snapshotJson(value);
        for (const key of changes.keys()) if (raw.get(key) === initial.get(key as StorageKey<S>)) changes.delete(key);
        return snapshot as T;
      });
      for (const [key, operation] of changes) {
        this.events.publish({ type: operation === 'remove' ? 'remove' : 'change', operation, key });
      }
      return result;
    });
  }

  on(type: StorageEventType, listener: StorageEventListener): () => void {
    this.assertOpen();
    return this.events.on(type, listener);
  }

  async has(key: StorageKey<S>): Promise<boolean> {
    this.assertKey(key);
    return this.enqueue(async () => {
      const raw = await this.backend.get(key);
      return raw !== undefined && !isExpired(decodeRecord(raw), Date.now());
    });
  }

  async remove(key: StorageKey<S>): Promise<boolean> {
    this.assertKey(key);
    return this.enqueue(async () => {
      this.events.prepare();
      const existed = await this.backend.remove(key);
      if (existed) this.events.publish({ type: 'remove', operation: 'remove', key });
      return existed;
    });
  }

  async keys(): Promise<string[]> {
    return this.enqueue(async () => {
      const live: string[] = [];
      for (const key of await this.backend.keys()) {
        const raw = await this.backend.get(key);
        if (raw !== undefined && !isExpired(decodeRecord(raw), Date.now())) live.push(key);
      }
      return live;
    });
  }

  async clear(): Promise<void> {
    return this.enqueue(async () => {
      this.events.prepare();
      await this.backend.clear();
      this.events.publish({ type: 'clear', operation: 'clear' });
    });
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.tail.then(() => this.backend.close()).finally(() => this.events.close());
    }
    return this.closing;
  }

  private assertKey(key: string): void {
    this.assertOpen();
    if (typeof key !== 'string') {
      throw new NexusStorageError('INVALID_KEY', 'A storage key must be a string.');
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new NexusStorageError('CLOSED', 'This NexusStorage instance is closed.');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = this.tail.then(operation);
    // A failed operation must not poison later operations or close().
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
