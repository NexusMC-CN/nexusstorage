import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { NexusStorage, NexusStorageError } from '../../src/index.js';
import type { StorageDriver } from '../../src/types.js';
import { MemoryCacheStorage } from '../helpers/memory/cache.js';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

for (const driver of ['localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage'] as const satisfies readonly StorageDriver[]) {
  describe(`NexusStorage (${driver})`, () => {
    const instances: NexusStorage[] = [];
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const originalIDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    const originalSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    function create(namespace = 'app') {
      const instance = new NexusStorage({ driver, namespace });
      instances.push(instance);
      return instance;
    }
    beforeEach(() => {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
      Object.defineProperty(globalThis, 'caches', { configurable: true, value: new MemoryCacheStorage() });
    });
    afterEach(async () => {
      await Promise.all(instances.splice(0).map(instance => instance.close()));
      for (const [key, original] of [['localStorage', originalStorage], ['indexedDB', originalIDB],
        ['sessionStorage', originalSession], ['caches', originalCaches]] as const) {
        if (original) Object.defineProperty(globalThis, key, original);
        else Reflect.deleteProperty(globalThis, key);
      }
    });

    it('persists nested JSON across instances and distinguishes missing keys from null', async () => {
      const store = create();
      assert.equal(await store.get('absent'), undefined);
      assert.deepEqual(await store.set('profile', { name: 'Alex', flags: [true, null, 3] }), {
        name: 'Alex', flags: [true, null, 3],
      });
      assert.deepEqual(await create().get('profile'), { name: 'Alex', flags: [true, null, 3] });
      await store.set('nil', null);
      assert.equal(await store.get('nil'), null);
      assert.equal(await store.has('nil'), true);
      assert.equal(await store.has('absent'), false);
    });

    it('replaces values with set and shallow merges objects with update', async () => {
      const store = create();
      await store.set('user', { name: 'Alex', settings: { theme: 'light', lang: 'zh' }, tags: ['a'] });
      assert.deepEqual(await store.update('user', { settings: { theme: 'dark' }, tags: ['b'], name: null }), {
        name: null, settings: { theme: 'dark' }, tags: ['b'],
      });
      await store.set('user', [1, 2]);
      assert.deepEqual(await store.get('user'), [1, 2]);
    });

    it('captures input at invocation time and isolates returned objects', async () => {
      const store = create();
      const input = { items: [{ score: 1 }] };
      const saving = store.set('item', input);
      input.items[0]!.score = 9;
      const saved = await saving;
      assert.deepEqual(saved, { items: [{ score: 1 }] });
      saved.items[0]!.score = 10;
      const read = await store.get<{ items: { score: number }[] }>('item');
      read!.items[0]!.score = 11;
      assert.deepEqual(await store.get('item'), { items: [{ score: 1 }] });
      const patch = { nested: { value: 1 } };
      const updating = store.update('item', patch);
      patch.nested.value = 9;
      assert.deepEqual(await updating, { items: [{ score: 1 }], nested: { value: 1 } });
    });

    it('executes calls in order and continues after failed operations', async () => {
      const store = create();
      const first = store.set('item', { a: 1 });
      const second = store.update('item', { b: 2 });
      const reading = store.get('item');
      await first;
      assert.deepEqual(await second, { a: 1, b: 2 });
      assert.deepEqual(await reading, { a: 1, b: 2 });
      await assert.rejects(store.update('absent', {}), { code: 'NOT_FOUND' });
      await store.set('after-error', false);
      assert.equal(await store.get('after-error'), false);
    });

    it('isolates arbitrary namespaces, keys, removal and clear', async () => {
      const first = create('app');
      const second = create('app:x');
      await first.set('', 0);
      await first.set('中文:😀', 'value');
      await second.set('', 2);
      assert.deepEqual(await first.keys(), ['', '中文:😀']);
      assert.equal(await first.remove('中文:😀'), true);
      assert.equal(await first.remove('中文:😀'), false);
      await first.clear();
      assert.deepEqual(await first.keys(), []);
      assert.equal(await second.get(''), 2);
    });

    it('rejects invalid JSON without changing an existing record', async () => {
      const store = create();
      await store.set('item', { a: 1 });
      for (const value of [undefined, { a: undefined }, NaN, new Date(), [1, , 3]]) {
        await assert.rejects(store.set('item', value as never), { code: 'INVALID_VALUE' });
      }
      assert.deepEqual(await store.get('item'), { a: 1 });
    });

    it('rejects updating missing keys and non-object targets or patches', async () => {
      const store = create();
      await assert.rejects(store.update('missing', {}), { code: 'NOT_FOUND' });
      for (const value of [null, [], 3, 'string']) {
        await store.set('item', value);
        await assert.rejects(store.update('item', {}), { code: 'TYPE_MISMATCH' });
      }
      await store.set('item', {});
      await assert.rejects(store.update('item', [] as never), { code: 'TYPE_MISMATCH' });
    });

    it('reports invalid keys using rejected promises', async () => {
      const store = create();
      await assert.rejects(store.get(3 as never), { code: 'INVALID_KEY' });
      await assert.rejects(store.set(null as never, 1), { code: 'INVALID_KEY' });
    });

    it('finishes pending writes on close and permanently rejects further operations', async () => {
      const store = create();
      const pending = store.set('item', 1);
      const closing = store.close();
      await assert.rejects(store.set('late', 2), { code: 'CLOSED' });
      await pending;
      await closing;
      await store.close();
      await assert.rejects(store.get('item'), { code: 'CLOSED' });
      assert.equal(await create().get('item'), 1);
    });
  });
}

describe('construction', () => {
  it('lets separate site features select different drivers with the same logical key', async () => {
    const globals = ['localStorage', 'sessionStorage', 'indexedDB', 'caches'] as const;
    const originals = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const stores: NexusStorage[] = [];
    try {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
      Object.defineProperty(globalThis, 'caches', { configurable: true, value: new MemoryCacheStorage() });
      for (const driver of ['localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage'] as const) {
        const store = new NexusStorage({ driver, namespace: 'same-feature' });
        stores.push(store);
        await store.set('data', { feature: driver });
      }
      assert.deepEqual(await Promise.all(stores.map(store => store.get('data'))), [
        { feature: 'localStorage' }, { feature: 'sessionStorage' },
        { feature: 'indexedDB' }, { feature: 'cacheStorage' },
      ]);
      await stores[1]!.clear();
      assert.deepEqual(await stores[0]!.get('data'), { feature: 'localStorage' });
      assert.deepEqual(await stores[3]!.get('data'), { feature: 'cacheStorage' });
    } finally {
      await Promise.all(stores.map(store => store.close()));
      globals.forEach((key, index) => {
        const original = originals[index];
        if (original) Object.defineProperty(globalThis, key, original);
        else Reflect.deleteProperty(globalThis, key);
      });
    }
  });

  it('can construct and close without accessing browser APIs', async () => {
    const globals = ['localStorage', 'indexedDB', 'sessionStorage', 'caches'];
    const originals = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    try {
      for (const key of globals) {
        Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error('Browser global accessed'); } });
      }
      await new NexusStorage().close();
      await new NexusStorage({ driver: 'indexedDB' }).close();
      await new NexusStorage({ driver: 'sessionStorage' }).close();
      await new NexusStorage({ driver: 'cacheStorage' }).close();
    } finally {
      globals.forEach((key, index) => {
        const original = originals[index];
        if (original) Object.defineProperty(globalThis, key, original);
        else Reflect.deleteProperty(globalThis, key);
      });
    }
  });

  it('rejects invalid options and exports a recognizable error class', () => {
    assert.throws(() => new NexusStorage({ driver: 'unknown' as never }), { code: 'INVALID_OPTIONS' });
    assert.throws(() => new NexusStorage({ namespace: 1 as never }), { code: 'INVALID_OPTIONS' });
    assert.throws(() => new NexusStorage(null as never), NexusStorageError);
  });
});
