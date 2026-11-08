import type { RawTransaction } from './index.js';
import { NexusStorageError } from '../errors.js';

/** Capture the caller's scope before a backend can yield. */
export function snapshotTransactionKeys(keys: readonly string[]): string[] {
  if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) {
    throw new NexusStorageError('INVALID_KEY', 'Transaction keys must be an array of strings.');
  }
  return [...new Set(keys)];
}

/** Reject asynchronous results before commit without leaving native rejections unobserved. */
export function assertSynchronousResult(result: unknown): void {
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) return;

  try {
    // Use the intrinsic to observe native Promises even if their own then is an accessor.
    // Both handlers return undefined so the observation cannot adopt another thenable.
    Reflect.apply(Promise.prototype.then, result, [() => undefined, () => undefined]);
  } catch {
    // Non-Promise values fail the native brand check and need no observation here.
  }
  let target: object | null = result;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, 'then');
    if (descriptor) {
      if (!('value' in descriptor)) {
        throw new NexusStorageError('ASYNC_TRANSACTION', 'Transaction results cannot have a then accessor.');
      }
      break;
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  const then: unknown = (result as { then?: unknown }).then;
  if (typeof then === 'function') {
    // Observe foreign thenables without awaiting or reading their then property again.
    void new Promise((resolve, reject) => {
      Reflect.apply(then, result, [resolve, reject]);
    }).catch(() => {});
    throw new NexusStorageError('ASYNC_TRANSACTION', 'Transaction callbacks must be synchronous.', { cause: result });
  }
}

/** Execute on a detached snapshot; only return a write set after synchronous success. */
export function runRawTransaction<T>(
  snapshot: Map<string, string | undefined>,
  transform: (transaction: RawTransaction) => T,
): { result: T; writes: ReadonlyMap<string, string | undefined> } {
  let active = true;
  const writes = new Map<string, string | undefined>();
  const assertKey = (key: string) => {
    if (!active) throw new NexusStorageError('TRANSACTION_INACTIVE', 'The transaction callback has already finished.');
    if (!snapshot.has(key)) throw new NexusStorageError('INVALID_KEY', 'The key is outside the declared transaction scope.');
  };
  const transaction: RawTransaction = Object.freeze({
    get(key: string) {
      assertKey(key);
      return snapshot.get(key);
    },
    set(key: string, value: string) {
      assertKey(key);
      snapshot.set(key, value);
      writes.set(key, value);
    },
    remove(key: string) {
      assertKey(key);
      const existed = snapshot.get(key) !== undefined;
      if (existed) {
        snapshot.set(key, undefined);
        writes.set(key, undefined);
      }
      return existed;
    },
  });

  let result: T;
  try {
    result = transform(transaction);
  } finally {
    // Even result.then getters or a queued microtask must see an expired scope.
    active = false;
  }

  assertSynchronousResult(result);
  return { result, writes };
}
