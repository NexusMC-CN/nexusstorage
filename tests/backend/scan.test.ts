import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { NexusStorage } from '../../src/index.js';
import { CacheStorageBackend } from '../../src/backend/cache.js';
import type { StorageBackend } from '../../src/backend/index.js';
import { NexusStorageError } from '../../src/errors.js';
import { MemoryCacheStorage } from '../helpers/memory/cache.js';
import type { MemoryCache } from '../helpers/memory/cache.js';

const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
let caches: MemoryCacheStorage;
const stores: NexusStorage[] = [];

beforeEach(() => {
  caches = new MemoryCacheStorage();
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: caches });
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
  else Reflect.deleteProperty(globalThis, 'caches');
});

// Measure both API calls and the returned requests actually traversed by the backend.
function countEnumeration(cache: MemoryCache) {
  const keys = cache.keys.bind(cache);
  const counts = { full: 0, filtered: 0, returned: 0, visited: 0 };
  cache.keys = async (...args) => {
    if (args[0] === undefined) counts.full++;
    else counts.filtered++;
    const requests = await keys(...args);
    counts.returned += requests.length;
    return new Proxy(requests, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) return function* () {
          for (const request of target) { counts.visited++; yield request; }
        };
        return Reflect.get(target, property, receiver);
      },
    });
  };
  return counts;
}

async function populate(cache: MemoryCache, backend: CacheStorageBackend) {
  for (let index = 0; index < 12; index++) await backend.set(`key${index}`, String(index));
  for (let index = 0; index < 8; index++) {
    await cache.put(`https://example.test/foreign/${index}`, new Response('external'));
  }
}

test('public keys reads twelve Cache records with one full enumeration and filters TTL records', async () => {
  const store = new NexusStorage({ driver: 'cacheStorage', namespace: 'scan' });
  stores.push(store);
  for (let index = 0; index < 12; index++) await store.set(`key${index}`, index);
  await store.set('expired', 'hidden', { expiresAt: 0 });
  const cache = await caches.open('nexusstorage:"scan"');
  for (let index = 0; index < 8; index++) {
    await cache.put(`https://example.test/foreign/${index}`, new Response('external'));
  }
  const counts = countEnumeration(cache);
  assert.deepEqual(await store.keys(), [
    'key0', 'key1', 'key10', 'key11', 'key2', 'key3', 'key4', 'key5', 'key6', 'key7', 'key8', 'key9',
  ]);
  assert.deepEqual(counts, { full: 1, filtered: 0, returned: 21, visited: 21 });
});

test('Cache scan reads owned values after one ownership analysis and sees peer writes on its next call', async () => {
  const backend = new CacheStorageBackend('scan');
  const cache = await caches.open('nexusstorage:"scan"');
  await populate(cache, backend);
  const counts = countEnumeration(cache);
  const scan = (backend as StorageBackend).scan;
  assert.ok(scan, 'Cache must expose sequential reading for public keys.');
  const entries: Array<{ key: string; value: string }> = [];
  assert.equal(await scan.call(backend, entry => { entries.push(entry); }), undefined);
  assert.equal(entries.length, 12);
  assert.deepEqual(entries.find(entry => entry.key === 'key11'), { key: 'key11', value: '11' });
  assert.deepEqual(counts, { full: 1, filtered: 0, returned: 20, visited: 20 });
  await new CacheStorageBackend('scan').set('peer', '42');
  entries.length = 0;
  await scan.call(backend, entry => { entries.push(entry); });
  assert.ok(entries.some(entry => entry.key === 'peer' && entry.value === '42'));
});

test('Cache scan visits each body before reading the next body', async () => {
  const backend = new CacheStorageBackend('scan');
  const cache = await caches.open('nexusstorage:"scan"');
  await backend.set('first', '1');
  await backend.set('second', '2');
  const events: string[] = [];
  const match = cache.match.bind(cache);
  cache.match = async (...args) => {
    const response = await match(...args);
    if (response) {
      const text = response.text.bind(response);
      response.text = async () => {
        const body = await text();
        events.push(`body:${body}`);
        return body;
      };
    }
    return response;
  };
  await backend.scan(entry => { events.push(`visit:${entry.key}:${entry.value}`); });
  assert.deepEqual(events, ['body:1', 'visit:first:1', 'body:2', 'visit:second:2']);
});

test('Cache scan preserves a visitor library error and stops before reading any later body', async () => {
  const backend = new CacheStorageBackend('scan');
  const cache = await caches.open('nexusstorage:"scan"');
  await backend.set('first', '1');
  await backend.set('second', '2'.repeat(128 * 1024));
  const bodies: string[] = [];
  const match = cache.match.bind(cache);
  cache.match = async (...args) => {
    const response = await match(...args);
    if (response) {
      const text = response.text.bind(response);
      response.text = async () => {
        bodies.push(args[0] instanceof Request ? args[0].url : String(args[0]));
        return text();
      };
    }
    return response;
  };
  const cause = new NexusStorageError('CORRUPT_DATA', 'Invalid record.');
  const visited: string[] = [];
  await assert.rejects(backend.scan(entry => { visited.push(entry.key); throw cause; }), error => error === cause);
  assert.deepEqual(visited, ['first']);
  assert.deepEqual(bodies, ['https://nexusstorage.invalid/v1/%22first%22']);
});

test('Cache scan wraps body failures and does not visit or read subsequent records', async () => {
  const backend = new CacheStorageBackend('scan');
  const cache = await caches.open('nexusstorage:"scan"');
  await backend.set('first', '1');
  await backend.set('broken', '2');
  await backend.set('later', '3');
  const match = cache.match.bind(cache);
  const bodies: string[] = [];
  const cause = new Error('Body stream failed.');
  cache.match = async (...args) => {
    const response = await match(...args);
    if (response) {
      const text = response.text.bind(response);
      response.text = async () => {
        const body = await text();
        bodies.push(body);
        if (body === '2') throw cause;
        return body;
      };
    }
    return response;
  };
  const visited: string[] = [];
  await assert.rejects(backend.scan(entry => { visited.push(entry.key); }), { code: 'STORAGE_ERROR', cause });
  assert.deepEqual(visited, ['first']);
  assert.deepEqual(bodies, ['1', '2']);
});

test('Cache clear enumerates and traverses all requests once while preserving foreign resources', async () => {
  const backend = new CacheStorageBackend('scan');
  const cache = await caches.open('nexusstorage:"scan"');
  await populate(cache, backend);
  const counts = countEnumeration(cache);
  await backend.clear();
  assert.deepEqual(counts, { full: 1, filtered: 0, returned: 20, visited: 20 });
  assert.deepEqual(await backend.keys(), []);
  assert.equal(await (await cache.match('https://example.test/foreign/7'))?.text(), 'external');
});

for (const operation of ['get', 'set', 'update', 'remove'] as const) {
  test(`single key ${operation} limits conflict-query results to the matching request`, async () => {
    const backend = new CacheStorageBackend('scan');
    const cache = await caches.open('nexusstorage:"scan"');
    await populate(cache, backend);
    const counts = countEnumeration(cache);
    if (operation === 'get') assert.equal(await backend.get('key1'), '1');
    if (operation === 'set') await backend.set('key1', '100');
    if (operation === 'update') assert.equal(await backend.update('key1', () => '100'), '100');
    if (operation === 'remove') assert.equal(await backend.remove('key1'), true);
    const queries = operation === 'update' ? 2 : 1;
    assert.deepEqual(counts, { full: 0, filtered: queries, returned: queries, visited: queries });
  });
}

test('Cache scan rejects listed canonical/fragment conflicts before reading any response', async () => {
  const backend = new CacheStorageBackend('scan');
  const cache = await caches.open('nexusstorage:"scan"');
  await backend.set('safe', '1');
  const fragment = 'https://nexusstorage.invalid/v1/%22conflict%22#external';
  await cache.put(fragment, new Response('external'));
  const keys = cache.keys.bind(cache);
  cache.keys = async () => [...await keys(), new Request('https://nexusstorage.invalid/v1/%22conflict%22')];
  let matches = 0;
  const match = cache.match.bind(cache);
  cache.match = async input => { matches++; return match(input); };
  const scan = (backend as StorageBackend).scan;
  assert.ok(scan, 'Cache must expose sequential reading for public keys.');
  await assert.rejects(scan.call(backend, () => { assert.fail('A conflicted snapshot must not visit records.'); }), { code: 'CORRUPT_DATA' });
  assert.equal(matches, 0);
  assert.equal(await (await match(fragment))?.text(), 'external');
});

test('Cache clear checks every listed conflict before deleting any owned record', async () => {
  const backend = new CacheStorageBackend('scan');
  const cache = await caches.open('nexusstorage:"scan"');
  await backend.set('safe', '1');
  const fragment = 'https://nexusstorage.invalid/v1/%22conflict%22#external';
  await cache.put(fragment, new Response('external'));
  const keys = cache.keys.bind(cache);
  cache.keys = async () => [...await keys(), new Request('https://nexusstorage.invalid/v1/%22conflict%22')];
  await assert.rejects(backend.clear(), { code: 'CORRUPT_DATA' });
  assert.equal(await (await cache.match('https://nexusstorage.invalid/v1/%22safe%22'))?.text(), '1');
  assert.equal(await (await cache.match(fragment))?.text(), 'external');
});
