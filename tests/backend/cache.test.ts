import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { CacheStorageBackend } from '../../src/backend/cache.js';
import { NexusStorage } from '../../src/index.js';
import { NexusStorageError } from '../../src/errors.js';
import { MemoryCacheStorage } from '../helpers/memory/cache.js';

const globalNames = ['caches', 'Request', 'Response', 'window', 'document', 'location', 'fetch'] as const;
const originals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let caches: MemoryCacheStorage;

function installGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeEach(() => { caches = new MemoryCacheStorage(); installGlobal('caches', caches); });
afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function errorCode(code: NexusStorageError['code'], cause?: unknown): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof NexusStorageError);
    assert.equal(error.code, code);
    if (cause !== undefined) assert.equal(error.cause, cause);
    return true;
  };
}

test('constructing and closing never access browser APIs, including Request and Response', async () => {
  for (const name of globalNames) {
    Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`Accessed ${name}`); } });
  }
  const backend = new CacheStorageBackend('ssr');
  await backend.close();
  await backend.close();
  await assert.rejects(backend.get('late'), errorCode('CLOSED'));
});

test('works without page globals and never fetches its synthetic URL', async () => {
  for (const name of ['window', 'document', 'location', 'fetch']) {
    Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`Accessed ${name}`); } });
  }
  const backend = new CacheStorageBackend('worker');
  await backend.set('value', '{"worker":true}');
  assert.equal(await backend.get('value'), '{"worker":true}');
  assert.deepEqual(await backend.keys(), ['value']);
  await backend.clear();
  assert.equal(await backend.get('value'), undefined);
});

test('reads raw strings repeatedly without consuming the persisted response', async () => {
  const backend = new CacheStorageBackend('app');
  assert.equal(await backend.get('missing'), undefined);
  for (const [key, raw] of [['nil', 'null'], ['empty', ''], ['object', '{"a":1}']] as const) {
    await backend.set(key, raw);
    assert.equal(await backend.get(key), raw);
    assert.equal(await backend.get(key), raw);
  }
});

test('stores the declared JSON content type and canonical URL for an empty key', async () => {
  await new CacheStorageBackend('app').set('', '{"value":1}');
  const cache = await caches.open('nexusstorage:"app"');
  const response = await cache.match('https://nexusstorage.invalid/v1/%22%22');
  assert.ok(response);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(await response.text(), '{"value":1}');
});

test('the memory Cache helper filters keys by request method and URL while ignoring fragments', async () => {
  const cache = await caches.open('helper');
  const fragment = 'https://nexusstorage.invalid/v1/%22a%22#external';
  await cache.put(fragment, new Response('external'));
  await cache.put('https://example.test/unrelated', new Response('unrelated'));
  assert.deepEqual((await cache.keys(new Request('https://nexusstorage.invalid/v1/%22a%22'))).map(request => request.url), [fragment]);
  assert.deepEqual(await cache.keys(new Request(fragment, { method: 'POST' })), []);
});

test('the memory Cache helper applies Vary unless query options explicitly ignore it', async () => {
  const cache = await caches.open('varyHelper');
  const fragment = 'https://nexusstorage.invalid/v1/%22a%22#external';
  const externalRequest = new Request(fragment, { headers: { 'X-Language': 'zh' } });
  await cache.put(externalRequest, new Response('external', { headers: { Vary: 'X-Language' } }));
  assert.deepEqual(await cache.keys(new Request('https://nexusstorage.invalid/v1/%22a%22')), []);
  assert.deepEqual((await cache.keys(new Request(fragment, { headers: { 'X-Language': 'en' } }))).map(request => request.url), []);
  assert.deepEqual((await cache.keys(externalRequest)).map(request => request.url), [fragment]);
  assert.deepEqual((await cache.keys(new Request('https://nexusstorage.invalid/v1/%22a%22'), { ignoreVary: true })).map(request => request.url), [fragment]);
});

test('the memory Cache helper honors ignoreSearch and ignoreMethod query options', async () => {
  const cache = await caches.open('queryHelper');
  const url = 'https://example.test/item?stored=1#fragment';
  await cache.put(url, new Response('external'));
  assert.deepEqual(await cache.keys('https://example.test/item?other=1'), []);
  assert.deepEqual((await cache.keys('https://example.test/item?other=1', { ignoreSearch: true })).map(request => request.url), [url]);
  assert.deepEqual((await cache.keys(new Request(url, { method: 'POST' }), { ignoreMethod: true })).map(request => request.url), [url]);
});

test('TTL records use the internal record media type on set and update with real Response bodies', async () => {
  const store = new NexusStorage({ driver: 'cacheStorage', namespace: 'media' });
  try {
    await store.set('item', { n: 1 }, { ttl: 60_000 });
    const cache = await caches.open('nexusstorage:"media"');
    const url = 'https://nexusstorage.invalid/v1/%22item%22';
    const initial = await cache.match(new Request(url));
    assert.ok(initial instanceof Response);
    assert.equal(initial.headers.get('content-type'), 'application/x.nexusstorage-record; charset=utf-8');
    assert.match(await initial.text(), /^NexusStorage\/1\n/);
    assert.deepEqual(await store.update('item', { n: 2 }), { n: 2 });
    const updated = await cache.match(new Request(url));
    assert.ok(updated instanceof Response);
    assert.equal(updated.headers.get('content-type'), 'application/x.nexusstorage-record; charset=utf-8');
    assert.match(await updated.text(), /^NexusStorage\/1\n/);
    assert.deepEqual(await store.get('item'), { n: 2 });
  } finally { await store.close(); }
});

test('internal record versions use the record media type while plain JSON keeps its JSON media type', async () => {
  const backend = new CacheStorageBackend('media');
  const cache = await caches.open('nexusstorage:"media"');
  for (const raw of ['NexusStorage/1\n{"value":1,"expiresAt":0}', 'NexusStorage/2\n{"value":1,"revision":"r"}']) {
    await backend.set('record', raw);
    assert.equal((await cache.match('https://nexusstorage.invalid/v1/%22record%22'))?.headers.get('content-type'),
      'application/x.nexusstorage-record; charset=utf-8');
    assert.equal(await backend.get('record'), raw);
  }
  await backend.update('record', () => '{"plain":true}');
  const response = await cache.match('https://nexusstorage.invalid/v1/%22record%22');
  assert.equal(response?.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await response?.json(), { plain: true });
});

test('raw non-JSON backend strings are labeled as text rather than JSON', async () => {
  const backend = new CacheStorageBackend('rawMedia');
  const cache = await caches.open('nexusstorage:"rawMedia"');
  for (const raw of ['', 'arbitrary text']) {
    await backend.set('raw', raw);
    const response = await cache.match('https://nexusstorage.invalid/v1/%22raw%22');
    assert.equal(response?.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await response?.text(), raw);
  }
});

test('legacy prefixed records previously labeled JSON remain readable without rewriting', async () => {
  const store = new NexusStorage({ driver: 'cacheStorage', namespace: 'legacyMedia' });
  try {
    const cache = await caches.open('nexusstorage:"legacyMedia"');
    const url = 'https://nexusstorage.invalid/v1/%22item%22';
    const raw = 'NexusStorage/1\n{"value":{"old":true},"expiresAt":9007199254740991}';
    await cache.put(new Request(url), new Response(raw, { headers: { 'content-type': 'application/json; charset=utf-8' } }));
    assert.deepEqual(await store.get('item'), { old: true });
    assert.equal(await (await cache.match(url))?.text(), raw);
  } finally { await store.close(); }
});

test('replaces values and shares persisted data across instances', async () => {
  const backend = new CacheStorageBackend('app');
  await backend.set('key', '1');
  await new CacheStorageBackend('app').set('key', '2');
  assert.equal(await backend.get('key'), '2');
  assert.equal(await new CacheStorageBackend('app').get('key'), '2');
});

test('round trips empty, Unicode, escaped and unpaired surrogate keys', async () => {
  const backend = new CacheStorageBackend('app');
  const keys = ['', 'a:b', '汉字/😀', '\ud800', '\udc00', '%?#\\:\n"', '__proto__', '.', '..'];
  for (const [index, key] of keys.entries()) await backend.set(key, String(index));
  assert.deepEqual(await backend.keys(), [...keys].sort());
  for (const [index, key] of keys.entries()) assert.equal(await backend.get(key), String(index));
  const response = await (await caches.open('nexusstorage:"app"')).match('https://nexusstorage.invalid/v1/%22%5Cud800%22');
  assert.equal(await response?.text(), '3');
});

test('isolates quoted, escaped, empty and delimiter-containing namespaces', async () => {
  const namespaces = ['app', 'app:x', 'app":\\', '', '\ud800'];
  for (const [index, namespace] of namespaces.entries()) await new CacheStorageBackend(namespace).set('key', String(index));
  await new CacheStorageBackend('app').clear();
  for (const [index, namespace] of namespaces.entries()) {
    assert.equal(await new CacheStorageBackend(namespace).get('key'), index === 0 ? undefined : String(index));
  }
});

test('remove reports presence including a stored empty string', async () => {
  const backend = new CacheStorageBackend('app');
  await backend.set('key', '');
  assert.equal(await backend.remove('key'), true);
  assert.equal(await backend.get('key'), undefined);
  assert.equal(await backend.remove('key'), false);
});

test('keys and clear ignore malformed, foreign and noncanonical resource URLs', async () => {
  const backend = new CacheStorageBackend('app');
  const cache = await caches.open('nexusstorage:"app"');
  const external = [
    'https://example.test/script.js',
    'https://nexusstorage.invalid/v1/%ZZ',
    'https://nexusstorage.invalid/v1/1',
    'https://nexusstorage.invalid/v1/%7B%7D',
    'https://nexusstorage.invalid/v1/%22a%22?external=1',
    'https://nexusstorage.invalid/v1/%22%61%22',
    'https://nexusstorage.invalid/v1/%22%5Cu0061%22',
    'https://nexusstorage.invalid/v1/%22a%22/',
    'https://nexusstorage.invalid/v2/%22a%22',
    'http://nexusstorage.invalid/v1/%22a%22',
  ];
  for (const url of external) await cache.put(url, new Response('external'));
  await backend.set('a', '1');
  await backend.set('b', '2');
  const other = await caches.open('external-cache');
  await other.put('https://example.test/keep', new Response('keep'));
  assert.deepEqual(await backend.keys(), ['a', 'b']);
  await backend.clear();
  assert.deepEqual(await backend.keys(), []);
  for (const url of external) assert.equal(await (await cache.match(url))?.text(), 'external');
  assert.equal(await (await other.match('https://example.test/keep'))?.text(), 'keep');
});

test('keys and clear ignore a non-GET request even when its URL looks internal', async () => {
  const backend = new CacheStorageBackend('app');
  const cache = await caches.open('nexusstorage:"app"');
  const keys = cache.keys.bind(cache);
  cache.keys = async () => [...await keys(), new Request('https://nexusstorage.invalid/v1/%22post%22', { method: 'POST' })];
  const remove = cache.delete.bind(cache);
  cache.delete = async input => {
    if (input instanceof Request) assert.equal(input.method, 'GET');
    return remove(input);
  };
  await backend.set('get', '1');
  assert.deepEqual(await backend.keys(), ['get']);
  await backend.clear();
  assert.deepEqual(await backend.keys(), []);
});

for (const operationName of ['get', 'set', 'update', 'remove'] as const) {
  test(`${operationName} rejects a fragment URL conflict without reading or changing the external entry`, async () => {
    const backend = new CacheStorageBackend('app');
    const cache = await caches.open('nexusstorage:"app"');
    const externalURL = 'https://nexusstorage.invalid/v1/%22a%22#external';
    await cache.put(externalURL, new Response('{"external":true}'));
    assert.deepEqual(await backend.keys(), []);
    const match = cache.match.bind(cache);
    let matched = 0;
    cache.match = async input => { matched++; return match(input); };
    let transformed = false;
    const operations = {
      get: () => backend.get('a'),
      set: () => backend.set('a', '{"owned":true}'),
      update: () => backend.update('a', () => { transformed = true; return '{"owned":true}'; }),
      remove: () => backend.remove('a'),
    };
    await assert.rejects(operations[operationName](), errorCode('CORRUPT_DATA'));
    assert.equal(matched, 0, 'The conflict must be rejected before reading an external response.');
    assert.equal(transformed, false);
    assert.deepEqual((await cache.keys()).map(request => request.url), [externalURL]);
    assert.equal(await (await match(externalURL))?.text(), '{"external":true}');
  });

  test(`${operationName} rejects a fragment URL conflict hidden by a Vary header mismatch`, async () => {
    const backend = new CacheStorageBackend('varyConflict');
    const cache = await caches.open('nexusstorage:"varyConflict"');
    const canonical = new Request('https://nexusstorage.invalid/v1/%22a%22');
    const externalRequest = new Request(canonical.url + '#external', { headers: { 'X-Language': 'zh' } });
    await cache.put(externalRequest, new Response('{"external":true}', { headers: { Vary: 'X-Language' } }));
    assert.deepEqual(await cache.keys(canonical), [], 'The fixture must exercise a real Vary mismatch.');
    const operations = {
      get: () => backend.get('a'),
      set: () => backend.set('a', '{"owned":true}'),
      update: () => backend.update('a', () => '{"owned":true}'),
      remove: () => backend.remove('a'),
    };
    await assert.rejects(operations[operationName](), errorCode('CORRUPT_DATA'));
    assert.deepEqual((await cache.keys()).map(request => request.url), [externalRequest.url]);
    assert.equal(await (await cache.match(externalRequest))?.text(), '{"external":true}');
  });
}

test('clear preserves an external fragment URL when no canonical record exists', async () => {
  const backend = new CacheStorageBackend('app');
  const cache = await caches.open('nexusstorage:"app"');
  const externalURL = 'https://nexusstorage.invalid/v1/%22a%22#external';
  await cache.put(externalURL, new Response('{"external":true}'));
  await backend.clear();
  assert.deepEqual(await backend.keys(), []);
  assert.equal(await (await cache.match(externalURL))?.text(), '{"external":true}');
});

test('clear refuses to delete a canonical record when the listed requests include a conflicting fragment URL', async () => {
  const backend = new CacheStorageBackend('app');
  const cache = await caches.open('nexusstorage:"app"');
  const externalURL = 'https://nexusstorage.invalid/v1/%22a%22#external';
  await cache.put(externalURL, new Response('{"external":true}'));
  const keys = cache.keys.bind(cache);
  // Multiple variants may be listed by a real Cache; deletion must guard all entries.
  cache.keys = async () => [new Request('https://nexusstorage.invalid/v1/%22a%22'), ...await keys()];
  await assert.rejects(backend.clear(), errorCode('CORRUPT_DATA'));
  assert.equal(await (await cache.match(externalURL))?.text(), '{"external":true}');
});

test('update rechecks fragment conflicts before writing after its asynchronous read', async () => {
  const backend = new CacheStorageBackend('app');
  const cache = await caches.open('nexusstorage:"app"');
  await backend.set('a', '{"owned":true}');
  const match = cache.match.bind(cache);
  const externalURL = 'https://nexusstorage.invalid/v1/%22a%22#external';
  cache.match = async input => {
    const response = await match(input);
    await cache.put(externalURL, new Response('{"external":true}'));
    return response;
  };
  await assert.rejects(backend.update('a', () => '{"changed":true}'), errorCode('CORRUPT_DATA'));
  assert.equal(await (await match(externalURL))?.text(), '{"external":true}');
});

test('clear preserves the named cache so old and new instances continue sharing writes', async () => {
  const first = new CacheStorageBackend('app');
  const second = new CacheStorageBackend('app');
  await first.set('old', '1');
  assert.equal(await second.get('old'), '1');
  const originalCache = await caches.open('nexusstorage:"app"');
  await first.clear();
  assert.equal(await caches.open('nexusstorage:"app"'), originalCache);
  await second.set('new', '2');
  assert.equal(await first.get('new'), '2');
  assert.equal(await new CacheStorageBackend('app').get('new'), '2');
});

test('reopens the current cache after an external deletion', async () => {
  const backend = new CacheStorageBackend('app');
  await backend.set('old', '1');
  await caches.delete('nexusstorage:"app"');
  assert.equal(await backend.get('old'), undefined);
  await backend.set('new', '2');
  assert.equal(await new CacheStorageBackend('app').get('new'), '2');
});

test('update supplies the current raw string and persists its returned value', async () => {
  const backend = new CacheStorageBackend('app');
  await backend.set('counter', '1');
  assert.equal(await backend.update('counter', raw => {
    assert.equal(raw, '1');
    return '2';
  }), '2');
  assert.equal(await new CacheStorageBackend('app').get('counter'), '2');
});

test('update supplies undefined for a missing entry', async () => {
  const backend = new CacheStorageBackend('app');
  assert.equal(await backend.update('new', raw => {
    assert.equal(raw, undefined);
    return '{"created":true}';
  }), '{"created":true}');
  assert.equal(await backend.get('new'), '{"created":true}');
});

test('a failed transform preserves the record and the original library error', async () => {
  const backend = new CacheStorageBackend('app');
  await backend.set('key', '1');
  const cause = new NexusStorageError('TYPE_MISMATCH', 'Expected object');
  await assert.rejects(backend.update('key', () => { throw cause; }), error => error === cause);
  assert.equal(await backend.get('key'), '1');
});

test('wraps a non-library transform error and leaves persisted data untouched', async () => {
  const backend = new CacheStorageBackend('app');
  await backend.set('key', '1');
  const cause = new Error('Transform failed');
  await assert.rejects(backend.update('key', () => { throw cause; }), errorCode('STORAGE_ERROR', cause));
  assert.equal(await backend.get('key'), '1');
});

test('all operations permanently reject after an idempotent close', async () => {
  const backend = new CacheStorageBackend('app');
  await backend.set('key', '1');
  await backend.close();
  await backend.close();
  for (const operation of [
    () => backend.get('key'), () => backend.set('key', '2'), () => backend.update('key', () => '2'),
    () => backend.remove('key'), () => backend.keys(), () => backend.clear(),
  ]) await assert.rejects(operation(), errorCode('CLOSED'));
  assert.equal(await new CacheStorageBackend('app').get('key'), '1');
});

for (const name of ['caches', 'Request', 'Response'] as const) {
  test(`reports unavailable storage when ${name} is absent`, async () => {
    installGlobal(name, undefined);
    await assert.rejects(new CacheStorageBackend('app').get('key'), errorCode('STORAGE_UNAVAILABLE'));
  });

  test(`preserves the acquisition failure when the ${name} getter throws`, async () => {
    const cause = new DOMException('Access denied', 'SecurityError');
    Object.defineProperty(globalThis, name, { configurable: true, get() { throw cause; } });
    await assert.rejects(new CacheStorageBackend('app').set('key', '1'), errorCode('STORAGE_UNAVAILABLE', cause));
  });
}

test('reports unavailable storage for an incomplete CacheStorage API', async () => {
  installGlobal('caches', {});
  await assert.rejects(new CacheStorageBackend('app').keys(), errorCode('STORAGE_UNAVAILABLE'));
});

test('wraps a rejected cache opening with its original cause', async () => {
  const cause = new DOMException('Cannot open cache', 'SecurityError');
  caches.open = async () => { throw cause; };
  await assert.rejects(new CacheStorageBackend('app').set('key', '1'), errorCode('STORAGE_ERROR', cause));
});

for (const kind of ['match', 'put', 'delete', 'keys', 'text', 'update put', 'clear delete'] as const) {
  test(`wraps ${kind} failures and preserves their cause`, async () => {
    const backend = new CacheStorageBackend('app');
    await backend.set('key', '1');
    const cache = await caches.open('nexusstorage:"app"');
    const cause = new DOMException('Operation failed', 'QuotaExceededError');
    let operation: () => Promise<unknown>;
    switch (kind) {
      case 'match': cache.match = async () => { throw cause; }; operation = () => backend.get('key'); break;
      case 'put': cache.put = async () => { throw cause; }; operation = () => backend.set('key', '2'); break;
      case 'delete': cache.delete = async () => { throw cause; }; operation = () => backend.remove('key'); break;
      case 'keys': cache.keys = async () => { throw cause; }; operation = () => backend.keys(); break;
      case 'text': {
        const response = new Response('1');
        response.text = async () => { throw cause; };
        cache.match = async () => response;
        operation = () => backend.get('key');
        break;
      }
      case 'update put': cache.put = async () => { throw cause; }; operation = () => backend.update('key', () => '2'); break;
      case 'clear delete': cache.delete = async () => { throw cause; }; operation = () => backend.clear(); break;
    }
    await assert.rejects(operation(), errorCode('STORAGE_ERROR', cause));
  });
}

test('keeps an existing library error from the Cache API unchanged', async () => {
  const cause = new NexusStorageError('STORAGE_UNAVAILABLE', 'Unavailable');
  caches.open = async () => { throw cause; };
  await assert.rejects(new CacheStorageBackend('app').get('key'), error => error === cause);
});

test('set and update wait for cache persistence before resolving', async () => {
  const backend = new CacheStorageBackend('app');
  const cache = await caches.open('nexusstorage:"app"');
  const put = cache.put.bind(cache);
  for (const operation of [() => backend.set('key', '1'), () => backend.update('key', () => '2')]) {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    cache.put = async (...args) => { entered(); await gate; await put(...args); };
    let finished = false;
    const pending = operation().then(() => { finished = true; });
    await Promise.race([started, pending.then(() => { assert.fail('Write resolved before Cache.put was invoked.'); })]);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    release();
    await pending;
    assert.equal(finished, true);
  }
  assert.equal(await backend.get('key'), '2');
});
