import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NexusStorage } from '../../src/index.js';
import { MemoryCacheStorage } from '../helpers/memory/cache.js';

// Catch bulk body accumulation: an invalid first record must stop before the next body is read.
test('public Cache keys decodes each body before reading the next one', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const caches = new MemoryCacheStorage();
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: caches });
  const store = new NexusStorage({ driver: 'cacheStorage', namespace: 'scan:early-stop' });
  try {
    const cache = await caches.open('nexusstorage:"scan:early-stop"');
    const invalid = 'https://nexusstorage.invalid/v1/%22invalid%22';
    const later = 'https://nexusstorage.invalid/v1/%22later%22';
    await cache.put(invalid, new Response('invalid JSON'));
    await cache.put(later, new Response(JSON.stringify({ large: 'x'.repeat(1024 * 128) })));
    const bodyReads: string[] = [];
    const match = cache.match.bind(cache);
    cache.match = async input => {
      const response = await match(input);
      if (response) {
        const text = response.text.bind(response);
        response.text = async () => {
          bodyReads.push(input instanceof Request ? input.url : String(input));
          return text();
        };
      }
      return response;
    };
    await assert.rejects(store.keys(), { code: 'CORRUPT_DATA' });
    assert.deepEqual(bodyReads, [invalid]);
    assert.equal(await (await match(later))?.json().then(value => value.large.length), 1024 * 128);
  } finally {
    await store.close();
    if (original) Object.defineProperty(globalThis, 'caches', original);
    else Reflect.deleteProperty(globalThis, 'caches');
  }
});
