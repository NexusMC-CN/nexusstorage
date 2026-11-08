import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  IDBDatabase as FakeDatabase,
  IDBFactory,
  IDBObjectStore as FakeObjectStore,
  forceCloseDatabase,
} from 'fake-indexeddb';
import { IndexedDBBackend } from '../../src/backend/indexedDB.js';
import { NexusStorageError } from '../../src/errors.js';

let factory: IDBFactory;
let originalIndexedDB: PropertyDescriptor | undefined;
let backends: IndexedDBBackend[];

beforeEach(() => {
  originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  factory = new IDBFactory();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
  backends = [];
});

afterEach(async () => {
  await Promise.all(backends.map((backend) => backend.close()));
  if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
});

function backend(namespace = 'app'): IndexedDBBackend {
  const result = new IndexedDBBackend(namespace);
  backends.push(result);
  return result;
}

function hasCode(code: NexusStorageError['code']): (error: unknown) => boolean {
  return (error) => error instanceof NexusStorageError && error.code === code;
}

function databaseName(namespace = 'app'): string {
  return `nexusstorage:${JSON.stringify(namespace)}`;
}

function openRaw(name = databaseName(), version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('entries')) request.result.createObjectStore('entries');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Unexpected blocked test database'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
    transaction.onerror = () => {};
  });
}

async function seedRaw(value: unknown, key = 'entry'): Promise<void> {
  const database = await openRaw();
  try {
    const transaction = database.transaction('entries', 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore('entries').put(value, key);
    await done;
  } finally {
    database.close();
  }
}

// Requests and transactions remain real; only the timing of a real abort is injected.
function abortAfterNextRequest(after?: 'put' | 'delete'): () => void {
  const methods = ['get', 'getKey', 'count', 'openCursor', 'getAllKeys', 'put', 'delete', 'clear'] as const;
  const restorers: (() => void)[] = [];
  let pending = true;
  for (const method of methods) {
    const original = Object.getOwnPropertyDescriptor(FakeObjectStore.prototype, method)!;
    Object.defineProperty(FakeObjectStore.prototype, method, {
      ...original,
      value: function (this: IDBObjectStore, ...args: unknown[]) {
        const request = Reflect.apply(original.value, this, args) as IDBRequest;
        const transaction = this.transaction;
        request.addEventListener('success', () => {
          if (pending && (after === undefined || method === after)) {
            pending = false;
            transaction.abort();
          }
        });
        return request;
      },
    });
    restorers.push(() => Object.defineProperty(FakeObjectStore.prototype, method, original));
  }
  return () => restorers.forEach((restore) => restore());
}

test('constructs and closes safely when IndexedDB is absent', async () => {
  Reflect.deleteProperty(globalThis, 'indexedDB');
  const storage = backend();
  await storage.close();
  await storage.close();
});

test('reports unavailable storage only when an operation needs it', async () => {
  Reflect.deleteProperty(globalThis, 'indexedDB');
  const storage = backend();
  await assert.rejects(storage.get('entry'), hasCode('STORAGE_UNAVAILABLE'));
});

test('persists values across instances and distinguishes missing entries', async () => {
  const first = backend();
  assert.equal(await first.get('missing'), undefined);
  await first.set('entry', '{"ok":true}');
  assert.equal(await backend().get('entry'), '{"ok":true}');
  await first.set('entry', 'null');
  assert.equal(await first.get('entry'), 'null');
});

test('uses ordinary string keys and returns them in sorted order', async () => {
  const storage = backend();
  for (const key of ['z', '__proto__', '', 'a:1', 'a']) await storage.set(key, '1');
  assert.deepEqual(await storage.keys(), ['', '__proto__', 'a', 'a:1', 'z']);
  assert.equal(await storage.get('__proto__'), '1');
});

test('removes an existing entry exactly once', async () => {
  const storage = backend();
  await storage.set('entry', '1');
  assert.equal(await storage.remove('entry'), true);
  assert.equal(await storage.remove('entry'), false);
  assert.equal(await storage.get('entry'), undefined);
});

test('clear preserves other namespaces including separator-containing names', async () => {
  const first = backend('app');
  const second = backend('app:child');
  const third = backend('app"');
  await Promise.all([first.set('child:key', '1'), second.set('key', '2'), third.set('key', '3')]);
  await first.clear();
  assert.deepEqual(await first.keys(), []);
  assert.equal(await second.get('key'), '2');
  assert.equal(await third.get('key'), '3');
});

test('reads the agreed database and object store format', async () => {
  await seedRaw('{"seeded":true}');
  assert.equal(await backend().get('entry'), '{"seeded":true}');
});

test('updates read and write in one transaction across competing instances', async () => {
  const first = backend();
  const second = backend();
  await first.set('counter', '0');
  await Promise.all(Array.from({ length: 40 }, (_, i) =>
    (i % 2 ? first : second).update('counter', (raw) => String(Number(raw) + 1)),
  ));
  assert.equal(await first.get('counter'), '40');
});

test('passes missing entries to the synchronous update transform', async () => {
  const storage = backend();
  assert.equal(await storage.update('new', (raw) => {
    assert.equal(raw, undefined);
    return '"created"';
  }), '"created"');
  assert.equal(await storage.get('new'), '"created"');
});

test('a thrown transform aborts the update and preserves its original error', async () => {
  const storage = backend();
  const failure = new Error('Transform refused update');
  await storage.set('entry', '"before"');
  await assert.rejects(storage.update('entry', () => { throw failure; }), (error) => error === failure);
  assert.equal(await storage.get('entry'), '"before"');
  assert.equal(await storage.update('entry', () => '"after"'), '"after"');
});

for (const corrupt of [undefined, null, 42, { unexpected: true }]) {
  test(`rejects a stored ${String(corrupt)} value instead of treating it as missing`, async () => {
    await seedRaw(corrupt);
    const storage = backend();
    await assert.rejects(storage.get('entry'), hasCode('CORRUPT_DATA'));
    await assert.rejects(storage.update('entry', () => '1'), hasCode('CORRUPT_DATA'));
  });
}

for (const operation of ['get', 'set', 'update', 'remove', 'keys', 'clear'] as const) {
  test(`${operation} rejects when its transaction aborts after a request succeeds`, async () => {
    const storage = backend();
    await storage.set('entry', '"before"');
    const restore = abortAfterNextRequest(operation === 'update' || operation === 'set'
      ? 'put' : operation === 'remove' ? 'delete' : undefined);
    try {
      const result = operation === 'get' ? storage.get('entry')
        : operation === 'set' ? storage.set('entry', '"after"')
        : operation === 'update' ? storage.update('entry', () => '"after"')
        : operation === 'remove' ? storage.remove('entry')
        : operation === 'keys' ? storage.keys()
        : storage.clear();
      await assert.rejects(result, (error) => hasCode('STORAGE_ERROR')(error)
        && (error as NexusStorageError).cause instanceof Error);
    } finally {
      restore();
    }
    assert.equal(await storage.get('entry'), '"before"');
  });
}

test('wraps synchronous storage denial and retains its cause', async () => {
  const denied = new DOMException('Storage access denied', 'SecurityError');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw denied; } });
  await assert.rejects(backend().get('entry'), (error) =>
    hasCode('STORAGE_ERROR')(error) && (error as NexusStorageError).cause === denied,
  );
});

test('wraps asynchronous database opening failures with their cause', async () => {
  const newer = await openRaw(databaseName(), 2);
  newer.close();
  await assert.rejects(backend().get('entry'), (error) => {
    const cause = (error as NexusStorageError).cause;
    return hasCode('STORAGE_ERROR')(error) && cause instanceof DOMException && cause.name === 'VersionError';
  });
});

test('closes on versionchange and can open a replacement database', { timeout: 2000 }, async () => {
  const storage = backend();
  await storage.set('entry', '1');
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(databaseName());
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Backend kept a connection open during versionchange'));
  });
  assert.equal(await storage.get('entry'), undefined);
  await storage.set('entry', '2');
  assert.equal(await storage.get('entry'), '2');
});

test('reopens after an unexpected connection close', async () => {
  const originalOpen = factory.open.bind(factory);
  let connection: IDBDatabase | undefined;
  factory.open = (...args) => {
    const request = originalOpen(...args);
    request.addEventListener('success', () => { connection = request.result; });
    return request;
  };
  const storage = backend();
  await storage.set('entry', '1');
  assert.ok(connection);
  forceCloseDatabase(connection as unknown as typeof FakeDatabase);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await storage.get('entry'), '1');
});

test('rejects a blocked open promptly and closes any late successful connection', { timeout: 2000 }, async () => {
  const holder = await openRaw();
  const originalOpen = factory.open.bind(factory);
  // Force an actual version upgrade so the real open request emits blocked.
  factory.open = (name) => originalOpen(name, 2);
  const storage = backend();
  try {
    await assert.rejects(storage.get('entry'), hasCode('DATABASE_BLOCKED'));
  } finally {
    holder.close();
    factory.open = originalOpen;
  }
  // A leaked connection from the rejected request would block this upgrade.
  const upgraded = await openRaw(databaseName(), 3);
  upgraded.close();
});

test('close during a pending open prevents use and releases the late connection', { timeout: 2000 }, async () => {
  const storage = backend();
  const pending = storage.get('entry');
  await storage.close();
  await assert.rejects(pending, hasCode('CLOSED'));
  const upgraded = await openRaw(databaseName(), 2);
  upgraded.close();
});

test('close is idempotent and permanently rejects every operation', async () => {
  const storage = backend();
  await storage.set('entry', '1');
  await storage.close();
  await storage.close();
  const operations = [
    storage.get('entry'), storage.set('entry', '2'), storage.update('entry', () => '2'),
    storage.remove('entry'), storage.keys(), storage.clear(),
  ];
  await Promise.all(operations.map((operation) => assert.rejects(operation, hasCode('CLOSED'))));
  assert.equal(await backend().get('entry'), '1');
});
