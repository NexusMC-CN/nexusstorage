import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { NexusStorage } from '../../src/index.js';
import { MemoryStorage } from '../helpers/memory/storage.js';
import { MemoryCacheStorage } from '../helpers/memory/cache.js';

const profileSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate(value: unknown) {
      const user = value as { name?: unknown; score?: unknown };
      return user && typeof user.name === 'string' && typeof user.score === 'number' && user.score >= 0
        ? { value: { name: user.name.trim(), score: user.score } }
        : { issues: [{ message: 'Expected a name and a non-negative score' }] };
    },
    types: undefined as unknown as { input: { name: string; score: number }; output: { name: string; score: number } },
  },
};

for (const driver of ['memory', 'localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage'] as const) {
  describe(`managed data (${driver})`, () => {
    let now = 10_000;
    const stores: Array<{ close(): Promise<void> }> = [];
    const globals = ['localStorage', 'sessionStorage', 'indexedDB', 'caches'] as const;
    const originals = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    function create() {
      const store = new NexusStorage({ driver, namespace: 'features' });
      stores.push(store);
      return store;
    }
    function typed() {
      const store = new NexusStorage({ driver, namespace: 'features', schemas: { profile: profileSchema } });
      stores.push(store);
      return store;
    }
    beforeEach(() => {
      now = 10_000;
      mock.method(Date, 'now', () => now);
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
      Object.defineProperty(globalThis, 'caches', { configurable: true, value: new MemoryCacheStorage() });
    });
    afterEach(async () => {
      await Promise.all(stores.splice(0).map(store => store.close()));
      mock.restoreAll();
      globals.forEach((key, index) => {
        const descriptor = originals[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      });
    });

    it('hides expired values consistently at the exact deadline without resurrecting them', async () => {
      const store = create();
      await store.set('draft', { title: 'Hello' }, { ttl: 100 });
      await store.set('keep', null);
      now += 99;
      assert.deepEqual(await store.get('draft'), { title: 'Hello' });
      now++;
      assert.equal(await store.get('draft'), undefined);
      assert.equal(await store.has('draft'), false);
      assert.deepEqual(await store.keys(), ['keep']);
      await assert.rejects(store.update('draft', { title: 'Late' }), { code: 'NOT_FOUND' });
      assert.equal(await store.remove('draft'), true);
      assert.equal(await store.remove('draft'), false);
      assert.equal(await store.get('keep'), null);
    });

    it('supports absolute and immediate expiry, preserves update TTL, and resets it on replacement', async () => {
      const store = create();
      await store.set('zero', 1, { ttl: 0 });
      assert.equal(await store.has('zero'), false);
      await store.set('item', { a: 1 }, { expiresAt: now + 100 });
      now += 50;
      await store.update('item', { b: 2 });
      now += 50;
      assert.equal(await store.get('item'), undefined);
      await store.set('item', { a: 2 }, { ttl: 100 });
      await store.update('item', { b: 3 }, { ttl: 200 });
      now += 150;
      assert.deepEqual(await store.get('item'), { a: 2, b: 3 });
      await store.set('item', { permanent: true });
      now += 1000;
      assert.deepEqual(await store.get('item'), { permanent: true });
    });

    it('captures options and JSON at invocation, rejects invalid deadlines without writing', async () => {
      const store = create();
      const value = { n: 1 };
      const options = { ttl: 100 };
      const writing = store.set('item', value, options);
      value.n = 99;
      options.ttl = 0;
      assert.deepEqual(await writing, { n: 1 });
      assert.equal(await store.has('item'), true);
      for (const invalid of [{ ttl: -1 }, { ttl: Infinity }, { ttl: NaN }, { expiresAt: -1 },
        { ttl: 1, expiresAt: now + 1 }, null, { ttl: '1' }]) {
        await assert.rejects(store.set('item', { changed: true }, invalid as never), { code: 'INVALID_OPTIONS' });
      }
      assert.deepEqual(await store.get('item'), { n: 1 });
    });

    it('keeps metadata-looking user data intact and hides expired entries before schema validation', async () => {
      const store = create();
      const value = { value: { version: 1 }, expiresAt: 0, version: 2 };
      await store.set('item', value, { ttl: 100 });
      assert.deepEqual(await store.get('item'), value);
      await typed().set('profile', { name: 'Alex', score: 2 }, { ttl: 0 });
      // Memory is explicitly instance-local; use a single typed instance for its assertions.
      const schemaStore = typed();
      await schemaStore.set('profile', { name: 'Alex', score: 2 }, { ttl: 0 });
      now += 1;
      assert.equal(await schemaStore.get('profile'), undefined);
    });

    it('validates and transforms set/get and the full merged object without damaging old data', async () => {
      const store = typed();
      assert.deepEqual(await store.set('profile', { name: ' Alex ', score: 2 }), { name: 'Alex', score: 2 });
      assert.deepEqual(await store.update('profile', { score: 3 }), { name: 'Alex', score: 3 });
      await assert.rejects(store.update('profile', { score: -1 }), { code: 'VALIDATION_ERROR' });
      await assert.rejects(store.set('profile', { name: 'Broken', score: -2 }), { code: 'VALIDATION_ERROR' });
      assert.deepEqual(await store.get('profile'), { name: 'Alex', score: 3 });
      await store.update('profile', { score: 4 });
      assert.deepEqual(await store.get('profile'), { name: 'Alex', score: 4 });
    });

    it('starts TTL before synchronous validation and skips validation of expired records', async () => {
      let calls = 0;
      const store = new NexusStorage({ driver, namespace: 'slow-validation', schemas: {
        item: { '~standard': { version: 1 as const, vendor: 'test', validate(value: unknown) {
          calls++;
          now += 100;
          return { value };
        } } },
      } });
      stores.push(store);
      await store.set('item', { n: 1 }, { ttl: 50 });
      assert.equal(now, 10_200);
      assert.equal(await store.get('item'), undefined);
      assert.equal(await store.has('item'), false);
      assert.deepEqual(await store.keys(), []);
      assert.equal(calls, 2); // Input conversion, followed by validation of the stored output.
    });

    if (driver === 'cacheStorage') it('starts a replacement TTL before waiting for a backend read', async () => {
      const store = create();
      await store.set('item', { n: 1 }, { ttl: 500 });
      const cache = await caches.open('nexusstorage:"features"');
      const match = cache.match.bind(cache);
      cache.match = async (...args: Parameters<Cache['match']>) => {
        now += 100;
        return match(...args);
      };
      await store.update('item', { n: 2 }, { ttl: 50 });
      cache.match = match;
      assert.equal(await store.get('item'), undefined);
    });

    if (driver === 'cacheStorage') it('does not list an immediately expired record created during enumeration', async () => {
      const store = create();
      const peer = create();
      const cache = await caches.open('nexusstorage:"features"');
      const keys = cache.keys.bind(cache);
      let injected = false;
      cache.keys = async (...args: Parameters<Cache['keys']>) => {
        if (!injected) {
          injected = true;
          now += 100;
          await peer.set('never-live', {}, { ttl: 0 });
        }
        return keys(...args);
      };
      assert.deepEqual(await store.keys(), []);
      assert.equal(await peer.has('never-live'), false);
    });

    it('rejects asynchronous validators and non-JSON schema outputs without persisting', async () => {
      const store = new NexusStorage({ driver, namespace: 'async', schemas: {
        async: { '~standard': { version: 1 as const, vendor: 'test', validate: async () => { throw new Error('async failure'); } } },
        date: { '~standard': { version: 1 as const, vendor: 'test', validate: () => ({ value: new Date() }) } },
      } });
      stores.push(store);
      await assert.rejects(store.set('async', {}), { code: 'ASYNC_SCHEMA' });
      await assert.rejects(store.set('date', {}), { code: 'INVALID_VALUE' });
      assert.deepEqual(await store.keys(), []);
    });
  });
}

it('reads legacy plain JSON and validates existing data without rewriting it', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const backend = new MemoryStorage();
  const raw = '{"value":1,"expiresAt":0,"version":1}';
  backend.setItem('nexusstorage:"legacy":old', raw);
  backend.setItem('nexusstorage:"legacy":profile', '{"name":"Old","score":-1}');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: backend });
  const store = new NexusStorage({ namespace: 'legacy', schemas: { profile: profileSchema } });
  const untyped = new NexusStorage({ namespace: 'legacy' });
  try {
    assert.deepEqual(await untyped.get('old'), { value: 1, expiresAt: 0, version: 1 });
    await assert.rejects(store.get('profile'), { code: 'VALIDATION_ERROR' });
    assert.equal(backend.getItem('nexusstorage:"legacy":old'), raw);
    assert.equal(backend.getItem('nexusstorage:"legacy":profile'), '{"name":"Old","score":-1}');
  } finally {
    await store.close();
    await untyped.close();
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
