import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { NexusStorage } from '../../src/index.js';
import type { StandardSchemaV1 } from '../../src/index.js';
import { MemoryStorage } from '../helpers/memory/storage.js';
import { MemoryCacheStorage } from '../helpers/memory/cache.js';

function schema<I, O>(validate: StandardSchemaV1.Props<I, O>['validate']): StandardSchemaV1<I, O> {
  return { '~standard': { version: 1, vendor: 'validation-regression', validate } };
}
const numeric = schema<number, number>(value => typeof value === 'number'
  ? { value } : { issues: [{ message: 'Expected number' }] });
const length = schema<string, number>(value => typeof value === 'string'
  ? { value: value.length } : { issues: [{ message: 'Expected string' }] });
const increment = schema<number, number>(value => typeof value === 'number'
  ? { value: value + 1 } : { issues: [{ message: 'Expected number' }] });

for (const driver of ['memory', 'localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage'] as const) {
  describe(`input and stored schema separation (${driver})`, () => {
    const globals = ['localStorage', 'sessionStorage', 'indexedDB', 'caches'] as const;
    const originals = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const stores: Array<{ close(): Promise<void> }> = [];
    beforeEach(() => {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
      Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
      Object.defineProperty(globalThis, 'caches', { configurable: true, value: new MemoryCacheStorage() });
    });
    afterEach(async () => {
      await Promise.all(stores.splice(0).map(store => store.close()));
      globals.forEach((key, index) => {
        const descriptor = originals[index];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      });
    });

    it('round-trips different input/output types without reapplying input conversion', async () => {
      let inputCalls = 0;
      const store = new NexusStorage({ driver, schemas: {
        length: schema<string, number>(value => { inputCalls++; return length['~standard'].validate(value); }),
      }, storedSchemas: { length: numeric } });
      stores.push(store);
      assert.equal(await store.set('length', 'abc'), 3);
      assert.equal(await store.get('length'), 3);
      assert.equal((await store.getEntry('length'))!.value, 3);
      assert.equal(await store.get('length'), 3);
      assert.equal(inputCalls, 1);
    });

    it('keeps a non-idempotent input transform stable on all reads', async () => {
      const store = new NexusStorage({ driver, schemas: { count: increment }, storedSchemas: { count: numeric } });
      stores.push(store);
      assert.equal(await store.set('count', 1), 2);
      assert.equal(await store.get('count'), 2);
      assert.equal(await store.get('count'), 2);
    });

    it('rejects unsafe implicit stored validation before writing and never emits a change', async () => {
      const store = new NexusStorage({ driver, schemas: { length, count: increment } });
      stores.push(store);
      const changes: string[] = [];
      store.on('change', event => { changes.push(event.key!); });
      await assert.rejects(store.set('length', 'abc'), { code: 'VALIDATION_ERROR' });
      await assert.rejects(store.set('count', 1), { code: 'VALIDATION_ERROR' });
      assert.deepEqual(await store.keys(), []);
      assert.deepEqual(changes, []);
    });

    it('merges patches into stored output without transforming unmodified fields', async () => {
      type Input = { label: string; count: string };
      type Output = { label: string; count: number };
      let inputCalls = 0;
      const input = schema<Input, Output>(value => {
        inputCalls++;
        const item = value as Partial<Input>;
        return item && typeof item.label === 'string' && typeof item.count === 'string'
          ? { value: { label: item.label, count: item.count.length } }
          : { issues: [{ message: 'Expected input' }] };
      });
      let reject = false;
      const stored = schema<Output, Output>(value => {
        const item = value as Partial<Output>;
        return !reject && item && typeof item.label === 'string' && typeof item.count === 'number'
          ? { value: { count: item.count, label: item.label } }
          : { issues: [{ message: 'Expected stored output' }] };
      });
      const store = new NexusStorage({ driver, schemas: { item: input }, storedSchemas: { item: stored } });
      stores.push(store);
      assert.deepEqual(await store.set('item', { label: 'old', count: 'abc' }, { ttl: 60_000 }), { label: 'old', count: 3 });
      assert.deepEqual(await store.update('item', { label: 'new' }), { label: 'new', count: 3 });
      if (driver === 'memory' || driver === 'indexedDB') {
        assert.deepEqual(await store.transaction(['item'], tx => tx.update('item', { label: 'transaction' })),
          { label: 'transaction', count: 3 });
      }
      const before = await store.getEntry('item');
      const changes: unknown[] = [];
      store.on('change', event => { changes.push(event); });
      reject = true;
      await assert.rejects(store.get('item'), { code: 'VALIDATION_ERROR' });
      await assert.rejects(store.update('item', { label: 'rejected' }), { code: 'VALIDATION_ERROR' });
      await assert.rejects(store.set('item', { label: 'rejected', count: 'abcd' }), { code: 'VALIDATION_ERROR' });
      reject = false;
      assert.deepEqual(await store.getEntry('item'), before);
      assert.deepEqual(changes, []);
      assert.equal(inputCalls, 2);
    });

    if (driver !== 'memory') it('validates old stored values without converting or rewriting them', async () => {
      const namespace = 'legacy-output';
      const untyped = new NexusStorage({ driver, namespace });
      const store = new NexusStorage({ driver, namespace, schemas: { count: increment }, storedSchemas: { count: numeric } });
      stores.push(untyped, store);
      await untyped.set('count', 7);
      assert.equal(await store.get('count'), 7);
      await untyped.set('count', 'old-invalid-output');
      await assert.rejects(store.get('count'), { code: 'VALIDATION_ERROR' });
      assert.equal(await untyped.get('count'), 'old-invalid-output');
    });

    it('rejects a transforming stored validator before saving a result', async () => {
      const store = new NexusStorage({ driver, schemas: { count: numeric }, storedSchemas: { count: increment } });
      stores.push(store);
      await assert.rejects(store.set('count', 1), { code: 'VALIDATION_ERROR' });
      assert.equal(await store.has('count'), false);
    });

    if (driver === 'memory' || driver === 'indexedDB') it('uses the same separation for transactions and CAS and rolls back output failure', async () => {
      let rejecting = false;
      const stored = schema<number, number>(value => !rejecting && typeof value === 'number'
        ? { value } : { issues: [{ message: 'Rejected output' }] });
      const store = new NexusStorage({ driver, schemas: { count: increment }, storedSchemas: { count: stored } });
      stores.push(store);
      const first = await store.compareAndSwap('count', null, 1);
      assert.equal(first.value, 2);
      assert.equal(await store.transaction(['count'], tx => {
        assert.equal(tx.get('count'), 2);
        return tx.set('count', 5);
      }), 6);
      const before = await store.getEntry('count');
      const changes: unknown[] = [];
      store.on('change', event => { changes.push(event); });
      rejecting = true;
      await assert.rejects(store.transaction(['count'], tx => tx.set('count', 7)), { code: 'VALIDATION_ERROR' });
      await assert.rejects(store.compareAndSwap('count', before!.revision, 8), { code: 'VALIDATION_ERROR' });
      rejecting = false;
      assert.deepEqual(await store.getEntry('count'), before);
      assert.deepEqual(changes, []);
    });
  });
}

it('rejects output schemas for keys without input schemas and captures mappings without invoking accessors', () => {
  assert.throws(() => new NexusStorage({ driver: 'memory', schemas: { length }, storedSchemas: { other: numeric } } as never), { code: 'INVALID_OPTIONS' });
  let reads = 0;
  const storedSchemas = Object.defineProperty({}, 'length', { get() { reads++; return numeric; } });
  assert.throws(() => new NexusStorage({ driver: 'memory', schemas: { length }, storedSchemas } as never), { code: 'INVALID_OPTIONS' });
  assert.equal(reads, 0);
});
