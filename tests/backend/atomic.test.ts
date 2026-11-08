import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb';
import type { RawTransaction, StorageBackend } from '../../src/backend/index.js';
import { MemoryBackend } from '../../src/backend/memory.js';
import { IndexedDBBackend } from '../../src/backend/indexedDB.js';
import { NexusStorageError } from '../../src/errors.js';

let originalIndexedDB: PropertyDescriptor | undefined;
let factory: IDBFactory;
let backends: StorageBackend[];

beforeEach(() => {
  originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  factory = new IDBFactory();
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
  backends = [];
});

afterEach(async () => {
  await Promise.all(backends.map(backend => backend.close()));
  if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
});

function create(kind: 'memory' | 'indexedDB', namespace = 'atomic'): StorageBackend {
  const result = kind === 'memory' ? new MemoryBackend(namespace) : new IndexedDBBackend(namespace);
  backends.push(result);
  return result;
}

function hasCode(code: string): (error: unknown) => boolean {
  return error => error instanceof NexusStorageError && error.code === code;
}

for (const kind of ['memory', 'indexedDB'] as const) {
  test(`${kind} atomically commits staged reads, replacements and removals`, async () => {
    const backend = create(kind);
    await backend.set('debit', '10');
    await backend.set('empty', '');
    await backend.set('untouched', 'exact raw\n');
    const result = await backend.atomic!(['debit', 'credit', 'empty', 'untouched', 'absent'], tx => {
      assert.equal(tx.get('debit'), '10');
      assert.equal(tx.get('credit'), undefined);
      tx.set('debit', '7');
      tx.set('credit', '3');
      assert.equal(tx.get('debit'), '7');
      assert.equal(tx.get('credit'), '3');
      assert.equal(tx.remove('empty'), true);
      assert.equal(tx.remove('empty'), false);
      assert.equal(tx.remove('absent'), false);
      assert.equal(tx.get('empty'), undefined);
      assert.equal(tx.get('untouched'), 'exact raw\n');
      return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(await backend.keys(), ['credit', 'debit', 'untouched']);
    assert.equal(await backend.get('debit'), '7');
    assert.equal(await backend.get('credit'), '3');
    assert.equal(await backend.get('untouched'), 'exact raw\n');
  });

  test(`${kind} preserves preceding commits and all prior values when the callback throws`, async () => {
    const backend = create(kind);
    await backend.atomic!(['one', 'two'], tx => {
      tx.set('one', 'first');
      tx.set('two', 'second');
    });
    const failure = new Error('Refuse the transfer');
    let expired: RawTransaction | undefined;
    await assert.rejects(backend.atomic!(['one', 'two', 'new'], tx => {
      expired = tx;
      tx.set('one', 'changed');
      tx.remove('two');
      tx.set('new', 'created');
      throw failure;
    }), error => error === failure);
    assert.throws(() => expired!.get('one'), hasCode('TRANSACTION_INACTIVE'));
    assert.equal(await backend.get('one'), 'first');
    assert.equal(await backend.get('two'), 'second');
    assert.equal(await backend.get('new'), undefined);
    await backend.atomic!(['one'], tx => tx.set('one', 'next commit'));
    assert.equal(await backend.get('one'), 'next commit');
  });

  test(`${kind} serializes overlapping concurrent transfers without losing money`, async () => {
    const backend = create(kind);
    const other = kind === 'indexedDB' ? create(kind) : backend;
    await backend.set('alice', '100');
    await backend.set('bob', '100');
    await Promise.all(Array.from({ length: 80 }, (_, index) => {
      const selected = index % 2 === 0 ? backend : other;
      const [from, to] = index < 50 ? ['alice', 'bob'] : ['bob', 'alice'];
      return selected.atomic!([from!, to!], tx => {
        const fromBalance = Number(tx.get(from!));
        const toBalance = Number(tx.get(to!));
        assert.ok(fromBalance >= 1);
        tx.set(from!, String(fromBalance - 1));
        tx.set(to!, String(toBalance + 1));
      });
    }));
    assert.equal(await backend.get('alice'), '80');
    assert.equal(await backend.get('bob'), '120');
  });

  test(`${kind} snapshots duplicate declared keys before asynchronous work`, async () => {
    const backend = create(kind);
    await backend.set('declared', 'before');
    const keys = ['declared', 'declared', '__proto__', ''];
    const pending = backend.atomic!(keys, tx => {
      assert.equal(tx.get('declared'), 'before');
      assert.throws(() => tx.get('injected'), hasCode('INVALID_KEY'));
      tx.set('declared', 'after');
      tx.set('__proto__', 'special');
      tx.set('', 'empty key');
    });
    keys.splice(0, keys.length, 'injected');
    await pending;
    assert.equal(await backend.get('declared'), 'after');
    assert.equal(await backend.get('__proto__'), 'special');
    assert.equal(await backend.get(''), 'empty key');
    assert.equal(await backend.get('injected'), undefined);
  });

  for (const operation of ['get', 'set', 'remove'] as const) {
    test(`${kind} rejects undeclared ${operation} access and rolls back staged writes`, async () => {
      const backend = create(kind);
      await backend.set('allowed', 'before');
      await backend.set('forbidden', 'protected');
      await assert.rejects(backend.atomic!(['allowed'], tx => {
        tx.set('allowed', 'after');
        if (operation === 'set') tx.set('forbidden', 'changed');
        else tx[operation]('forbidden');
      }), hasCode('INVALID_KEY'));
      assert.equal(await backend.get('allowed'), 'before');
      assert.equal(await backend.get('forbidden'), 'protected');
    });
  }

  test(`${kind} invalidates every transaction method immediately after its callback returns`, async () => {
    const backend = create(kind);
    let retained: RawTransaction | undefined;
    let microtaskChecked = false;
    await backend.atomic!(['key'], tx => {
      retained = tx;
      tx.set('key', 'committed');
      queueMicrotask(() => {
        assert.throws(() => tx.get('key'), hasCode('TRANSACTION_INACTIVE'));
        assert.throws(() => tx.set('key', 'too late'), hasCode('TRANSACTION_INACTIVE'));
        assert.throws(() => tx.remove('key'), hasCode('TRANSACTION_INACTIVE'));
        microtaskChecked = true;
      });
    });
    assert.equal(microtaskChecked, true);
    assert.throws(() => retained!.get('outside'), hasCode('TRANSACTION_INACTIVE'));
    assert.equal(await backend.get('key'), 'committed');
  });

  test(`${kind} runs zero-key callbacks and expires their scope on success and failure`, async () => {
    const backend = create(kind);
    let retained: RawTransaction | undefined;
    assert.equal(await backend.atomic!([], tx => {
      retained = tx;
      assert.throws(() => tx.get('outside'), hasCode('INVALID_KEY'));
      return 'empty result';
    }), 'empty result');
    assert.throws(() => retained!.get('outside'), hasCode('TRANSACTION_INACTIVE'));
    const failure = new Error('Empty transaction failed');
    await assert.rejects(backend.atomic!([], tx => { retained = tx; throw failure; }), error => error === failure);
    assert.throws(() => retained!.remove('outside'), hasCode('TRANSACTION_INACTIVE'));
    assert.deepEqual(await backend.keys(), []);
  });

  test(`${kind} rejects and observes asynchronous callbacks without committing`, async () => {
    const backend = create(kind);
    await backend.set('key', 'before');
    let retained: RawTransaction | undefined;
    await assert.rejects(backend.atomic!(['key'], async tx => {
      retained = tx;
      tx.set('key', 'after');
      await Promise.resolve();
      assert.throws(() => tx.get('key'), hasCode('TRANSACTION_INACTIVE'));
      throw new Error('Observe this rejected callback promise');
    }), hasCode('ASYNC_TRANSACTION'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.throws(() => retained!.get('key'), hasCode('TRANSACTION_INACTIVE'));
    assert.equal(await backend.get('key'), 'before');
    await assert.rejects(backend.atomic!([], async () => {}), hasCode('ASYNC_TRANSACTION'));
  });

  test(`${kind} rejects then accessors without invoking them after expiring the transaction`, async () => {
    const backend = create(kind);
    await backend.set('key', 'before');
    let thenReads = 0;
    let observed = false;
    await assert.rejects(backend.atomic!(['key'], tx => {
      tx.set('key', 'after');
      return {
        get then() {
          thenReads++;
          assert.throws(() => tx.get('key'), hasCode('TRANSACTION_INACTIVE'));
          return (_resolve: unknown, reject: (error: unknown) => void) => {
            observed = true;
            reject(new Error('Rejected foreign thenable'));
          };
        },
      };
    }), hasCode('ASYNC_TRANSACTION'));
    assert.equal(thenReads, 0);
    assert.equal(observed, false);
    assert.equal(await backend.get('key'), 'before');
  });

  test(`${kind} close permanently prevents atomic callbacks and writes`, async () => {
    const backend = create(kind);
    await backend.close();
    let called = false;
    await assert.rejects(backend.atomic!(['key'], () => { called = true; }), hasCode('CLOSED'));
    await assert.rejects(backend.atomic!([], () => { called = true; }), hasCode('CLOSED'));
    assert.equal(called, false);
  });

  test(`${kind} closing during the callback prevents the transaction from committing`, async () => {
    const backend = create(kind);
    await backend.set('key', 'before');
    let retained: RawTransaction | undefined;
    await assert.rejects(backend.atomic!(['key'], tx => {
      retained = tx;
      tx.set('key', 'after');
      void backend.close();
    }), hasCode('CLOSED'));
    assert.throws(() => retained!.get('key'), hasCode('TRANSACTION_INACTIVE'));
    if (kind === 'indexedDB') assert.equal(await create(kind).get('key'), 'before');
  });
}

test('memory atomic only commits dirty keys, preserving another synchronous commit to a read-only key', async () => {
  const backend = create('memory');
  await backend.set('write', 'before');
  await backend.set('read', 'initial');
  await backend.atomic!(['write', 'read'], tx => {
    assert.equal(tx.get('read'), 'initial');
    void backend.set('read', 'independent commit');
    tx.set('write', 'after');
  });
  assert.equal(await backend.get('read'), 'independent commit');
  assert.equal(await backend.get('write'), 'after');
});

test('indexedDB atomic rejects a real abort after a successful write and rolls back every key', async () => {
  const backend = create('indexedDB');
  await backend.set('one', 'first');
  await backend.set('two', 'second');
  const original = Object.getOwnPropertyDescriptor(FakeObjectStore.prototype, 'put')!;
  let pending = true;
  Object.defineProperty(FakeObjectStore.prototype, 'put', {
    ...original,
    value: function (this: IDBObjectStore, ...args: unknown[]) {
      const request = Reflect.apply(original.value, this, args) as IDBRequest;
      request.addEventListener('success', () => {
        if (pending) {
          pending = false;
          this.transaction.abort();
        }
      });
      return request;
    },
  });
  try {
    await assert.rejects(backend.atomic!(['one', 'two', 'new'], tx => {
      tx.set('one', 'changed');
      tx.set('two', 'changed');
      tx.set('new', 'created');
      return 'must not resolve before commit';
    }), hasCode('STORAGE_ERROR'));
  } finally {
    Object.defineProperty(FakeObjectStore.prototype, 'put', original);
  }
  const reader = create('indexedDB');
  assert.equal(await reader.get('one'), 'first');
  assert.equal(await reader.get('two'), 'second');
  assert.equal(await reader.get('new'), undefined);
});

test('indexedDB atomic rejects a non-string stored value without invoking its callback', async () => {
  const open = factory.open('nexusstorage:"atomic"', 1);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onupgradeneeded = () => open.result.createObjectStore('entries');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    const transaction = database.transaction('entries', 'readwrite');
    transaction.objectStore('entries').put(undefined, 'corrupt');
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
  const backend = create('indexedDB');
  let called = false;
  await assert.rejects(backend.atomic!(['corrupt'], () => { called = true; }), hasCode('CORRUPT_DATA'));
  assert.equal(called, false);
});
