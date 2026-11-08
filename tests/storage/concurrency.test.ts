import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { NexusStorage } from '../../src/index.js';
import type { StorageTransaction } from '../../src/index.js';
import { MemoryStorage } from '../helpers/memory/storage.js';
import { MemoryCacheStorage } from '../helpers/memory/cache.js';

for (const driver of ['memory', 'indexedDB'] as const) {
  describe(`atomic public API (${driver})`, () => {
    let store: NexusStorage;
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    beforeEach(() => {
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
      store = new NexusStorage({ driver, namespace: 'atomic' });
    });
    afterEach(async () => {
      await store.close();
      mock.restoreAll();
      if (original) Object.defineProperty(globalThis, 'indexedDB', original);
      else Reflect.deleteProperty(globalThis, 'indexedDB');
    });

    it('declares actual atomicity and exposes detached versioned entries', async () => {
      assert.equal(store.capabilities.transactions, true);
      assert.equal(store.capabilities.compareAndSwap, true);
      assert.equal(store.capabilities.atomicity, driver === 'memory' ? 'instance' : 'database');
      assert.equal(Object.isFrozen(store.capabilities), true);
      await store.set('a', { n: 1 });
      const entry = await store.getEntry<{ n: number }>('a');
      assert.equal(typeof entry!.revision, 'string');
      entry!.value.n = 10;
      assert.deepEqual(await store.get('a'), { n: 1 });
      assert.equal(await store.getEntry('missing'), undefined);
    });

    it('compares revisions atomically and rejects stale/ABA writes without events', async () => {
      const events: string[] = [];
      store.on('change', event => { events.push(event.operation); });
      const first = await store.compareAndSwap('item', null, { n: 1 });
      const second = await store.compareAndSwap('item', first.revision, { n: 2 });
      assert.notEqual(second.revision, first.revision);
      await assert.rejects(store.compareAndSwap('item', first.revision, { n: 3 }), { code: 'CONFLICT' });
      await store.remove('item');
      await store.set('item', { n: 2 });
      const recreated = await store.getEntry('item');
      assert.notEqual(recreated!.revision, second.revision);
      await assert.rejects(store.compareAndSwap('item', second.revision, { n: 4 }), { code: 'CONFLICT' });
      assert.deepEqual(events, ['compareAndSwap', 'compareAndSwap', 'set']);
      assert.deepEqual(await store.get('item'), { n: 2 });
    });

    it('commits multiple keys and publishes only after complete success', async () => {
      await store.set('a', { balance: 10 });
      await store.set('b', { balance: 0 });
      const events: string[] = [];
      store.on('change', event => { events.push(event.key!); });
      const total = await store.transaction(['a', 'b'], tx => {
        const a = tx.get<{ balance: number }>('a')!;
        const b = tx.get<{ balance: number }>('b')!;
        tx.update('a', { balance: a.balance - 3 });
        tx.set('b', { balance: b.balance + 3 });
        assert.deepEqual(events, []);
        assert.equal(tx.has('a'), true);
        return a.balance + b.balance;
      });
      assert.equal(total, 10);
      assert.deepEqual(await store.get('a'), { balance: 7 });
      assert.deepEqual(await store.get('b'), { balance: 3 });
      assert.deepEqual(events, ['a', 'b']);
    });

    it('rolls back throws, invalid values, out-of-scope keys and async callbacks', async () => {
      await store.set('a', { n: 1 });
      const events: string[] = [];
      store.on('change', () => { events.push('change'); });
      const failure = new Error('rollback');
      await assert.rejects(store.transaction(['a'], tx => { tx.set('a', { n: 2 }); throw failure; }), error => error === failure);
      await assert.rejects(store.transaction(['a'], tx => { tx.set('a', { n: 3 }); tx.set('other', 1); }), { code: 'INVALID_KEY' });
      await assert.rejects(store.transaction(['a'], tx => { tx.set('a', { n: 4 }); tx.set('a', new Date() as never); }), { code: 'INVALID_VALUE' });
      await assert.rejects(store.transaction(['a'], (async (tx: StorageTransaction) => { tx.set('a', { n: 5 }); throw new Error('async'); }) as never), { code: 'ASYNC_TRANSACTION' });
      assert.deepEqual(await store.get('a'), { n: 1 });
      assert.deepEqual(events, []);
    });

    it('expires transaction contexts and deduplicates committed notifications', async () => {
      const events: string[] = [];
      store.on('change', event => { events.push(event.key!); });
      let retained: { get(key: string): unknown } | undefined;
      await store.transaction(['a', 'a'], tx => {
        retained = tx;
        tx.set('a', { n: 1 });
        tx.update('a', { n: 2 });
      });
      assert.throws(() => retained!.get('a'), { code: 'TRANSACTION_INACTIVE' });
      assert.deepEqual(events, ['a']);
    });

    it('clears expiry explicitly, rejects expired updates and permits CAS create after expiry', async () => {
      let now = 1000;
      mock.method(Date, 'now', () => now);
      await store.set('a', { n: 1 }, { ttl: 50 });
      await store.update('a', { n: 2 }, { ttl: null });
      assert.equal((await store.getEntry('a'))!.expiresAt, undefined);
      now = 1100;
      assert.deepEqual(await store.get('a'), { n: 2 });
      await store.set('a', { n: 3 }, { ttl: 0 });
      await assert.rejects(store.update('a', { n: 4 }), { code: 'NOT_FOUND' });
      assert.deepEqual((await store.compareAndSwap('a', null, { n: 5 })).value, { n: 5 });
    });

    it('isolates listener failures and cancellation from committed data', async () => {
      let changes = 0;
      const off = store.on('change', () => { changes++; });
      store.on('change', () => { throw new Error('listener'); });
      store.on('change', async () => { throw new Error('async listener'); });
      await store.set('a', 1);
      off();
      await store.set('a', 2);
      assert.equal(changes, 1);
      assert.equal(await store.get('a'), 2);
    });

    it('rejects unstable then accessors before a transaction can commit', async () => {
      await store.set('a', 0);
      let reads = 0;
      const events: string[] = [];
      store.on('change', () => { events.push('change'); });
      const result = Object.defineProperty({}, 'then', { get() {
        reads++;
        return reads === 1 ? undefined : (_resolve: unknown, reject: (reason: unknown) => void) => reject(new Error('late rejection'));
      } });
      await assert.rejects(store.transaction(['a'], tx => { tx.set('a', 1); return result; }), { code: 'ASYNC_TRANSACTION' });
      assert.equal(reads, 0);
      assert.equal(await store.get('a'), 0);
      assert.deepEqual(events, []);
    });

    it('snapshots JSON results before commit without assimilating a returned Proxy', async () => {
      let thenReads = 0;
      const source = new Proxy({ nested: { n: 1 } }, {
        get(target, key, receiver) {
          if (key === 'then') {
            thenReads++;
            return thenReads === 1 ? undefined : (_resolve: unknown, reject: (reason: unknown) => void) => reject(new Error('late rejection'));
          }
          return Reflect.get(target, key, receiver);
        },
      });
      const result = await store.transaction(['a'], tx => { tx.set('a', 1); return source; });
      assert.deepEqual(result, { nested: { n: 1 } });
      assert.notEqual(result, source);
      assert.notEqual(result.nested, source.nested);
      source.nested.n = 2;
      assert.equal(result.nested.n, 1);
      assert.equal(thenReads, 1);
      assert.equal(await store.get('a'), 1);
    });

    it('expires the public context before inspecting the returned JSON result', async () => {
      let reflections = 0;
      const result = await store.transaction(['a'], tx => {
        tx.set('a', 1);
        const assertInactive = () => {
          reflections++;
          assert.throws(() => tx.get('a'), { code: 'TRANSACTION_INACTIVE' });
          assert.throws(() => tx.set('a', 2), { code: 'TRANSACTION_INACTIVE' });
        };
        return new Proxy({ ok: true }, {
          getOwnPropertyDescriptor(target, key) { assertInactive(); return Reflect.getOwnPropertyDescriptor(target, key); },
          getPrototypeOf(target) { assertInactive(); return Reflect.getPrototypeOf(target); },
          get(target, key, receiver) { if (key === 'then') assertInactive(); return Reflect.get(target, key, receiver); },
        });
      });
      assert.ok(reflections > 0);
      assert.deepEqual(result, { ok: true });
      assert.equal(await store.get('a'), 1);
    });

    it('rolls back a non-JSON result and publishes no events', async () => {
      await store.set('a', 0);
      const events: string[] = [];
      store.on('change', () => { events.push('change'); });
      await assert.rejects(store.transaction(['a'], tx => { tx.set('a', 1); return new Date() as never; }), { code: 'INVALID_VALUE' });
      assert.equal(await store.get('a'), 0);
      assert.deepEqual(events, []);
    });

    it('observes a rejected native Promise even when its then is an accessor', async () => {
      await store.set('a', 0);
      let thenReads = 0;
      await assert.rejects(store.transaction(['a'], tx => {
        tx.set('a', 1);
        const result = Promise.reject(new Error('rejected transaction result'));
        Object.defineProperty(result, 'then', { get() { thenReads++; return Promise.prototype.then; } });
        return result as never;
      }), { code: 'ASYNC_TRANSACTION' });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(thenReads, 0);
      assert.equal(await store.get('a'), 0);
    });
  });
}

it('rejects unsupported atomic operations and keeps browser construction lazy', async () => {
  for (const driver of ['localStorage', 'sessionStorage', 'cacheStorage'] as const) {
    const store = new NexusStorage({ driver });
    assert.equal(store.capabilities.transactions, false);
    await assert.rejects(store.transaction(['a'], () => 1), { code: 'UNSUPPORTED_OPERATION' });
    await assert.rejects(store.compareAndSwap('a', null, 1), { code: 'UNSUPPORTED_OPERATION' });
    await store.close();
  }
});

it('keeps explicit TTL clearing consistent on the three non-atomic drivers', async () => {
  const globals = ['localStorage', 'sessionStorage', 'caches'] as const;
  const originals = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: new MemoryCacheStorage() });
    for (const driver of ['localStorage', 'sessionStorage', 'cacheStorage'] as const) {
      const store = new NexusStorage({ driver });
      await store.set('a', { n: 1 }, { ttl: 60_000 });
      await store.update('a', { n: 2 }, { ttl: null });
      assert.equal((await store.getEntry('a'))!.expiresAt, undefined);
      await store.close();
    }
  } finally {
    globals.forEach((key, index) => {
      const descriptor = originals[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
