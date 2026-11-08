import type { StorageDriver } from './types.js';

export interface StorageCapabilities {
  readonly transactions: boolean;
  readonly compareAndSwap: boolean;
  /** Retention across page sessions, not a browser persistence grant. */
  readonly persistent: boolean;
  readonly crossTab: boolean;
  readonly broadcast: boolean;
  readonly atomicity: 'instance' | 'database' | 'none';
}

export function capabilitiesFor(driver: StorageDriver): StorageCapabilities {
  const shared = driver === 'localStorage' || driver === 'indexedDB' || driver === 'cacheStorage';
  const atomic = driver === 'memory' || driver === 'indexedDB';
  return Object.freeze({
    transactions: atomic,
    compareAndSwap: atomic,
    persistent: shared,
    crossTab: shared,
    broadcast: shared,
    atomicity: driver === 'indexedDB' ? 'database' : driver === 'memory' ? 'instance' : 'none',
  });
}
