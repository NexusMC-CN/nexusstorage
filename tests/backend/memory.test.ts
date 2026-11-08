import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryBackend } from '../../src/backend/memory.js';
import { NexusStorageError } from '../../src/errors.js';

function errorCode(code: NexusStorageError['code'], cause?: unknown): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof NexusStorageError);
    assert.equal(error.code, code);
    if (cause !== undefined) assert.equal(error.cause, cause);
    return true;
  };
}

test('reads missing values and round trips raw strings without JSON parsing', async () => {
  const backend = new MemoryBackend();
  assert.equal(await backend.get('missing'), undefined);
  for (const [key, raw] of [['nil', 'null'], ['empty', ''], ['object', '{"a":1}'], ['raw', 'not JSON']] as const) {
    await backend.set(key, raw);
    assert.equal(await backend.get(key), raw);
    assert.equal(await backend.get(key), raw);
  }
  await backend.set('object', '[2]');
  assert.equal(await backend.get('object'), '[2]');
});

test('round trips special keys and returns sorted independent key arrays', async () => {
  const backend = new MemoryBackend('app');
  const keys = ['z', '', '__proto__', 'constructor', 'a:b', '汉字/😀', '\ud800', '\udc00', '%?#\\:\n"'];
  for (const [index, key] of keys.entries()) await backend.set(key, String(index));
  const listed = await backend.keys();
  assert.deepEqual(listed, [...keys].sort());
  listed.length = 0;
  assert.deepEqual(await backend.keys(), [...keys].sort());
  for (const [index, key] of keys.entries()) assert.equal(await backend.get(key), String(index));
});

for (const namespace of [undefined, '', 'same']) {
  test(`keeps independent instances with namespace ${JSON.stringify(namespace)}`, async () => {
    const first = new MemoryBackend(namespace);
    const second = new MemoryBackend(namespace);
    await first.set('key', 'first');
    assert.equal(await second.get('key'), undefined);
    await second.set('key', 'second');
    assert.equal(await first.get('key'), 'first');
    assert.equal(await second.get('key'), 'second');
    await first.clear();
    assert.equal(await second.get('key'), 'second');
    await first.close();
    assert.equal(await second.get('key'), 'second');
  });
}

test('remove reports physical presence including an empty stored string', async () => {
  const backend = new MemoryBackend();
  assert.equal(await backend.remove('missing'), false);
  await backend.set('key', '');
  assert.equal(await backend.remove('key'), true);
  assert.equal(await backend.get('key'), undefined);
  assert.equal(await backend.remove('key'), false);
  assert.deepEqual(await backend.keys(), []);
});

test('update initializes missing values and commits synchronously before yielding', async () => {
  const backend = new MemoryBackend();
  let called = 0;
  const pending = backend.update('counter', raw => {
    called++;
    assert.equal(raw, undefined);
    return '1';
  });
  assert.equal(called, 1);
  assert.equal(await backend.get('counter'), '1');
  assert.equal(await pending, '1');
  assert.equal(await backend.update('counter', raw => {
    assert.equal(raw, '1');
    return '2';
  }), '2');
  assert.equal(await backend.get('counter'), '2');
});

test('concurrent synchronous transforms preserve every update', async () => {
  const backend = new MemoryBackend();
  await backend.set('counter', '0');
  const results = await Promise.all(Array.from({ length: 100 }, () => backend.update('counter', raw => String(Number(raw) + 1))));
  assert.deepEqual(results, Array.from({ length: 100 }, (_, index) => String(index + 1)));
  assert.equal(await backend.get('counter'), '100');
});

test('a failed transform preserves the existing value and library error identity', async () => {
  const backend = new MemoryBackend();
  await backend.set('key', '1');
  const cause = new NexusStorageError('TYPE_MISMATCH', 'Expected an object.');
  await assert.rejects(backend.update('key', () => { throw cause; }), error => error === cause);
  assert.equal(await backend.get('key'), '1');
  assert.equal(await backend.update('key', raw => String(Number(raw) + 1)), '2');
});

test('a native transform failure keeps its cause without creating or replacing data', async () => {
  const backend = new MemoryBackend();
  await backend.set('existing', 'old');
  const cause = new Error('Transform failed.');
  for (const key of ['existing', 'missing']) {
    await assert.rejects(backend.update(key, () => { throw cause; }), errorCode('STORAGE_ERROR', cause));
  }
  assert.equal(await backend.get('existing'), 'old');
  assert.equal(await backend.get('missing'), undefined);
  assert.deepEqual(await backend.keys(), ['existing']);
});

test('clear removes every record and leaves the instance usable', async () => {
  const backend = new MemoryBackend();
  await backend.set('a', '1');
  await backend.set('b', '2');
  await backend.clear();
  assert.deepEqual(await backend.keys(), []);
  assert.equal(await backend.get('a'), undefined);
  assert.equal(await backend.remove('b'), false);
  await backend.clear();
  await backend.set('new', '3');
  assert.equal(await backend.get('new'), '3');
});

test('an idempotent close permanently rejects every data operation', async () => {
  const backend = new MemoryBackend('same');
  await backend.set('key', '1');
  await backend.close();
  await backend.close();
  let transformed = false;
  for (const operation of [
    () => backend.get('key'),
    () => backend.set('key', '2'),
    () => backend.update('key', () => { transformed = true; return '2'; }),
    () => backend.remove('key'),
    () => backend.keys(),
    () => backend.clear(),
  ]) await assert.rejects(operation(), errorCode('CLOSED'));
  assert.equal(transformed, false);
  assert.equal(await new MemoryBackend('same').get('key'), undefined);
});

test('closing inside a transform prevents its pending write', async () => {
  const backend = new MemoryBackend();
  await backend.set('key', 'old');
  await assert.rejects(backend.update('key', () => {
    void backend.close();
    return 'new';
  }), errorCode('CLOSED'));
  await backend.close();
});

test('operates without accessing browser globals', async () => {
  const names = ['window', 'document', 'location', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'fetch'] as const;
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    for (const name of names) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() { assert.fail(`Memory must not access ${name}.`); },
      });
    }
    const backend = new MemoryBackend('ssr');
    await backend.set('key', '1');
    assert.equal(await backend.get('key'), '1');
    assert.equal(await backend.update('key', () => '2'), '2');
    assert.deepEqual(await backend.keys(), ['key']);
    assert.equal(await backend.remove('key'), true);
    await backend.clear();
    await backend.close();
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
