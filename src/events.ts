import { NexusStorageError } from './errors.js';
import { createRevision } from './record/index.js';
import type { StorageDriver } from './types.js';

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

interface NativeMessage extends StorageChange {
  instanceId: string;
  eventId: string;
}

interface NativeSubscriber {
  instanceId: string;
  notify: (change: StorageChange, source: StorageEvent['source']) => void;
}

interface NativeStorageGroup {
  target: Window;
  storage: Storage;
  namespace: string;
  key: string;
  receive: (event: globalThis.StorageEvent) => void;
  subscribers: Set<NativeSubscriber>;
  seen: Set<string>;
  pending: Array<{ message: NativeMessage; sender?: NativeSubscriber; subscribers: NativeSubscriber[] }>;
  dispatching: boolean;
}

interface NativeStorageChannel {
  group: NativeStorageGroup;
  subscriber: NativeSubscriber;
}

// Only opted-in localStorage transports participate; SSR Memory instances never share state.
const nativeGroups = new WeakMap<Window, Map<string, NativeStorageGroup>>();

function dispatchNative(group: NativeStorageGroup, message: NativeMessage, sender?: NativeSubscriber): void {
  const identity = JSON.stringify([message.instanceId, message.eventId]);
  if (group.seen.has(identity)) return;
  group.seen.add(identity);
  if (group.seen.size > 256) group.seen.delete(group.seen.values().next().value!);
  group.pending.push({ message, ...(sender ? { sender } : {}), subscribers: [...group.subscribers] });
  if (group.dispatching) return;
  group.dispatching = true;
  try {
    while (group.pending.length > 0) {
      const next = group.pending.shift()!;
      if (next.sender) {
        try {
          // Queue the native notification before listeners can reenter publication.
          group.storage.setItem(group.key, JSON.stringify({
            ...next.message, driver: 'localStorage', namespace: group.namespace, source: 'local',
          }));
        } catch {
          // Transport failures cannot undo a committed write or prevent same-page delivery.
        } finally {
          try { group.storage.removeItem(group.key); } catch { /* Best effort control entry cleanup. */ }
        }
      }
      const { type, operation, key } = next.message;
      const metadata: StorageChange = { type, operation, ...(key === undefined ? {} : { key }) };
      for (const subscriber of next.subscribers) {
        if (!group.subscribers.has(subscriber)) continue;
        if (!next.sender && subscriber.instanceId === next.message.instanceId) continue;
        subscriber.notify(metadata, subscriber === next.sender ? 'local' : 'remote');
      }
    }
  } finally {
    group.dispatching = false;
  }
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
  #instanceId: string | undefined;
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
    try {
      const target = globalThis.window;
      const storage = globalThis.localStorage;
      if (!target || typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function'
        || !storage || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
        throw new NexusStorageError('STORAGE_UNAVAILABLE', 'Native storage notifications are not available.');
      }
      const groups = nativeGroups.get(target) ?? new Map<string, NativeStorageGroup>();
      let group = groups.get(this.#namespace);
      if (!group) {
        // This cannot overlap nexusstorage:JSON(namespace):, the backend's data prefix.
        const key = `nexusstorage:events:1:${JSON.stringify([this.#driver, this.#namespace])}`;
        const created: NativeStorageGroup = {
          target, storage, namespace: this.#namespace, key,
          subscribers: new Set(), seen: new Set(), pending: [], dispatching: false,
          receive: (event: globalThis.StorageEvent) => {
            if (created.subscribers.size === 0) return;
            try {
              if (event.storageArea !== storage || event.key !== key || typeof event.newValue !== 'string') return;
              const message: unknown = JSON.parse(event.newValue);
              if (!message || typeof message !== 'object' || Array.isArray(message)) return;
              const envelope = message as Record<string, unknown>;
              if (envelope.driver !== 'localStorage' || envelope.namespace !== created.namespace || envelope.source !== 'local'
                || typeof envelope.instanceId !== 'string' || envelope.instanceId.length === 0
                || typeof envelope.eventId !== 'string' || envelope.eventId.length === 0) return;
              const change = readChange(message);
              if (change) dispatchNative(created, { ...change, instanceId: envelope.instanceId, eventId: envelope.eventId });
            } catch {
              // Foreign or malformed control entries are not storage notifications.
            }
          },
        };
        try { target.addEventListener('storage', created.receive); } catch (error) {
          try { target.removeEventListener('storage', created.receive); } catch { /* Ignore partial attachment cleanup failures. */ }
          throw error;
        }
        group = created;
        groups.set(this.#namespace, group);
        nativeGroups.set(target, groups);
      }
      this.#instanceId ??= createRevision();
      const subscriber: NativeSubscriber = {
        instanceId: this.#instanceId,
        notify: (change, source) => { if (!this.#closed) this.#notify(change, source); },
      };
      group.subscribers.add(subscriber);
      this.#nativeChannel = { group, subscriber };
    } catch (error) {
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
    // A registration owns its wrapper even when another registration uses the same callback.
    const subscription: StorageEventListener = event => listener(event);
    listeners.add(subscription);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(subscription);
      if (listeners.size === 0 && this.#listeners.get(type) === listeners) this.#listeners.delete(type);
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
    const native = this.#nativeChannel;
    if (native) {
      dispatchNative(native.group, { ...metadata, instanceId: native.subscriber.instanceId, eventId: createRevision() }, native.subscriber);
      return;
    }
    this.#notify(metadata, 'local');
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
      const { group, subscriber } = native;
      group.subscribers.delete(subscriber);
      if (group.subscribers.size === 0) {
        try { group.target.removeEventListener('storage', group.receive); } catch { /* The instance remains closed. */ }
        const groups = nativeGroups.get(group.target);
        groups?.delete(this.#namespace);
        if (groups?.size === 0) nativeGroups.delete(group.target);
      }
    }
    if (channel) {
      try { channel.onmessage = null; } catch { /* Ignore platform cleanup failures. */ }
      try { channel.close(); } catch { /* The instance remains closed even if cleanup fails. */ }
    }
  }
}
