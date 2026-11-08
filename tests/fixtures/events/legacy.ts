/**
 * Frozen from nexusstorage commit 21c6335, src/events.ts.
 * Only relative import paths are adapted; legacy id-only sending and receiving are unchanged.
 * Keep this independent of current protocol changes and do not read Git at test runtime.
 */
import { NexusStorageError } from '../../../src/errors.js';
import { createRevision } from '../../../src/record/index.js';
import type { StorageDriver } from '../../../src/types.js';

export type StorageEventType = 'change' | 'remove' | 'clear';
export type StorageOperation = 'set' | 'update' | 'compareAndSwap' | 'remove' | 'clear';

export interface StorageEvent {
  readonly type: StorageEventType;
  readonly operation: StorageOperation;
  readonly key?: string;
  readonly driver: StorageDriver;
  readonly namespace: string;
  readonly source: 'local' | 'remote';
}

export type StorageEventListener = (event: StorageEvent) => void | Promise<void>;

interface StorageChange {
  type: StorageEventType;
  operation: StorageOperation;
  key?: string;
}

interface NativeStorageChannel {
  target: Window;
  storage: Storage;
  key: string;
  receive: (event: globalThis.StorageEvent) => void;
}

function readChange(value: unknown): StorageChange | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const { type, operation, key } = value as Record<string, unknown>;
    if (type === 'clear' && operation === 'clear' && key === undefined) return { type, operation };
    if (typeof key !== 'string') return undefined;
    if (type === 'remove' && operation === 'remove') return { type, operation, key };
    if (type === 'change' && (operation === 'set' || operation === 'update' || operation === 'compareAndSwap')) {
      return { type, operation, key };
    }
  } catch {
    // Messages are untrusted: failed property access is not a valid event.
  }
  return undefined;
}

export class StorageEvents {
  readonly #driver: StorageDriver;
  readonly #namespace: string;
  readonly #broadcast: boolean;
  readonly #listeners = new Map<StorageEventType, Set<StorageEventListener>>();
  #channel: BroadcastChannel | undefined;
  #nativeChannel: NativeStorageChannel | undefined;
  #closed = false;

  constructor(driver: StorageDriver, namespace: string, broadcast = false) {
    if (broadcast && (driver === 'memory' || driver === 'sessionStorage')) {
      throw new NexusStorageError('INVALID_OPTIONS', `Broadcasting is not supported by ${driver}.`);
    }
    this.#driver = driver;
    this.#namespace = namespace;
    this.#broadcast = broadcast;
  }

  #assertOpen(): void {
    if (this.#closed) throw new NexusStorageError('CLOSED', 'The storage instance is closed.');
  }

  /** Establish notification transport before an operation commits business data. */
  prepare(): void {
    this.#assertOpen();
    if (!this.#broadcast || this.#channel || this.#nativeChannel) return;
    if (this.#driver === 'localStorage') {
      this.#prepareNativeStorage();
      return;
    }
    let channel: BroadcastChannel | undefined;
    try {
      const Channel = globalThis.BroadcastChannel;
      if (typeof Channel !== 'function') {
        throw new NexusStorageError('STORAGE_UNAVAILABLE', 'BroadcastChannel is not available.');
      }
      channel = new Channel(`nexusstorage:events:1:${JSON.stringify([this.#driver, this.#namespace])}`);
      if (typeof channel.postMessage !== 'function' || typeof channel.close !== 'function') {
        throw new NexusStorageError('STORAGE_UNAVAILABLE', 'BroadcastChannel is not available.');
      }
      channel.onmessage = event => {
        if (this.#closed) return;
        const change = readChange(event.data);
        if (change) this.#notify(change, 'remote');
      };
      // Node channels otherwise keep SSR and test processes alive indefinitely.
      const nodeChannel = channel as BroadcastChannel & { unref?: () => void };
      if (typeof nodeChannel.unref === 'function') nodeChannel.unref();
      this.#channel = channel;
    } catch (error) {
      try { channel?.close(); } catch { /* A partially initialized channel may fail to close. */ }
      throw new NexusStorageError('STORAGE_UNAVAILABLE', 'Unable to open BroadcastChannel.', { cause: error });
    }
  }

  #prepareNativeStorage(): void {
    let channel: NativeStorageChannel | undefined;
    try {
      const target = globalThis.window;
      const storage = globalThis.localStorage;
      if (!target || typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function'
        || !storage || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
        throw new NexusStorageError('STORAGE_UNAVAILABLE', 'Native storage notifications are not available.');
      }
      // This cannot overlap nexusstorage:JSON(namespace):, the backend's data prefix.
      const key = `nexusstorage:events:1:${JSON.stringify([this.#driver, this.#namespace])}`;
      const receive = (event: globalThis.StorageEvent) => {
        if (this.#closed) return;
        try {
          if (event.storageArea !== storage || event.key !== key || typeof event.newValue !== 'string') return;
          const message: unknown = JSON.parse(event.newValue);
          if (!message || typeof message !== 'object' || Array.isArray(message)) return;
          const envelope = message as Record<string, unknown>;
          if (envelope.driver !== 'localStorage' || envelope.namespace !== this.#namespace || envelope.source !== 'local'
            || typeof envelope.id !== 'string' || envelope.id.length === 0) return;
          const change = readChange(message);
          if (change) this.#notify(change, 'remote');
        } catch {
          // Foreign or malformed control entries are not storage notifications.
        }
      };
      channel = { target, storage, key, receive };
      target.addEventListener('storage', receive);
      this.#nativeChannel = channel;
    } catch (error) {
      try { channel?.target.removeEventListener('storage', channel.receive); } catch { /* Ignore partial attachment cleanup failures. */ }
      throw new NexusStorageError('STORAGE_UNAVAILABLE', 'Unable to prepare native storage notifications.', { cause: error });
    }
  }

  on(type: StorageEventType, listener: StorageEventListener): () => void {
    this.#assertOpen();
    if ((type !== 'change' && type !== 'remove' && type !== 'clear') || typeof listener !== 'function') {
      throw new NexusStorageError('INVALID_OPTIONS', 'An event type and listener function are required.');
    }
    this.prepare();
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(type);
    };
  }

  #notify(change: StorageChange, source: StorageEvent['source']): void {
    const event: StorageEvent = Object.freeze({
      ...change,
      driver: this.#driver,
      namespace: this.#namespace,
      source,
    });
    const listeners = this.#listeners.get(event.type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      if (this.#closed) break;
      try {
        Promise.resolve(listener(event)).catch(() => {});
      } catch {
        // Listener failures cannot change the result of an already committed write.
      }
    }
  }

  /** Called only after commit; publication failures must not reject the write. */
  publish(change: { type: StorageEventType; operation: StorageOperation; key?: string }): void {
    if (this.#closed) return;
    const metadata = readChange(change);
    if (!metadata) return;
    this.#notify(metadata, 'local');
    const native = this.#nativeChannel;
    if (native) {
      try {
        native.storage.setItem(native.key, JSON.stringify({
          ...metadata, id: createRevision(), driver: this.#driver, namespace: this.#namespace, source: 'local',
        }));
      } catch {
        // Metadata transport failures cannot undo the committed business write.
      } finally {
        try { native.storage.removeItem(native.key); } catch { /* Best effort control entry cleanup. */ }
      }
      return;
    }
    try {
      this.#channel?.postMessage(metadata);
    } catch {
      // Broadcasts are best effort and contain no business values.
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    const channel = this.#channel;
    this.#channel = undefined;
    const native = this.#nativeChannel;
    this.#nativeChannel = undefined;
    if (native) {
      try { native.target.removeEventListener('storage', native.receive); } catch { /* The instance remains closed. */ }
    }
    if (channel) {
      try { channel.onmessage = null; } catch { /* Ignore platform cleanup failures. */ }
      try { channel.close(); } catch { /* The instance remains closed even if cleanup fails. */ }
    }
  }
}
