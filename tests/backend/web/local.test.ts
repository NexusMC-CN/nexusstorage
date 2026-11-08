import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { LocalStorageBackend } from '../../../src/backend/web/local.js';
import { NexusStorageError } from '../../../src/errors.js';
import { MemoryStorage } from '../../helpers/memory/storage.js';

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let storage: MemoryStorage;

function installStorage(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
}

beforeEach(() => { storage = new MemoryStorage(); installStorage(storage); });
afterEach(() => {
  if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof NexusStorageError && error.code === code;
}

test('constructing and closing a backend never access localStorage', async () => {
  let reads = 0;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { reads++; throw new Error('Forbidden'); },
  });
  const backend = new LocalStorageBackend('ssr');
  await backend.close();
  await backend.close();
  assert.equal(reads, 0);
});

test('reads raw strings while distinguishing missing keys from stored null and empty strings', async () => {
  const backend = new LocalStorageBackend('app');
  assert.equal(await backend.get('missing'), undefined);
  await backend.set('nil', 'null');
  await backend.set('empty', '');
  await backend.set('object', '{"a":1}');
  assert.equal(await backend.get('nil'), 'null');
  assert.equal(await backend.get('empty'), '');
  assert.equal(await backend.get('object'), '{"a":1}');
});

test('replaces values and shares persisted data across same-namespace instances', async () => {
  const first = new LocalStorageBackend('app');
  const second = new LocalStorageBackend('app');
  await first.set('record', '[1,2]');
  await second.set('record', '{"changed":true}');
  assert.equal(await first.get('record'), '{"changed":true}');
});

test('lists sorted logical keys including empty and special names', async () => {
  const backend = new LocalStorageBackend('app');
  for (const key of ['z', '中文', '', '__proto__', 'a:b', 'a']) await backend.set(key, '1');
  storage.setItem('foreign', 'untouched');
  await new LocalStorageBackend('elsewhere').set('invisible', '2');
  assert.deepEqual(await backend.keys(), ['', '__proto__', 'a', 'a:b', 'z', '中文']);
});

test('keeps delimiter-containing namespace and key pairs isolated', async () => {
  const first = new LocalStorageBackend('a');
  const second = new LocalStorageBackend('a:b');
  await first.set('b:key', '"first"');
  await second.set('key', '"second"');
  assert.equal(await first.get('b:key'), '"first"');
  assert.equal(await second.get('key'), '"second"');
  await first.clear();
  assert.equal(await second.get('key'), '"second"');
});

test('keeps quoted and escaped namespace names isolated', async () => {
  const first = new LocalStorageBackend('app":\\');
  const second = new LocalStorageBackend('app');
  await first.set('key', '1');
  await second.set('key', '2');
  assert.deepEqual(await first.keys(), ['key']);
  assert.equal(await first.get('key'), '1');
  assert.equal(await second.get('key'), '2');
});

test('remove reports prior presence including a stored empty string', async () => {
  const backend = new LocalStorageBackend('app');
  await backend.set('key', '');
  assert.equal(await backend.remove('key'), true);
  assert.equal(await backend.get('key'), undefined);
  assert.equal(await backend.remove('key'), false);
});

test('clear removes every owned key while preserving foreign data', async () => {
  const first = new LocalStorageBackend('app');
  const second = new LocalStorageBackend('other');
  storage.setItem('unrelated', 'keep');
  for (const key of ['one', 'two', 'three']) await first.set(key, '1');
  await second.set('one', '2');
  await first.clear();
  assert.deepEqual(await first.keys(), []);
  assert.equal(await second.get('one'), '2');
  assert.equal(storage.getItem('unrelated'), 'keep');
  assert.equal(storage.length, 2);
});

test('update reads, transforms and writes synchronously before yielding', async () => {
  const first = new LocalStorageBackend('app');
  const observer = new LocalStorageBackend('app');
  await first.set('counter', '1');
  const pending = first.update('counter', (raw) => {
    assert.equal(raw, '1');
    return '2';
  });
  assert.equal(await observer.get('counter'), '2');
  assert.equal(await pending, '2');
});

test('update supplies undefined to the transform for a missing raw key', async () => {
  const backend = new LocalStorageBackend('app');
  const updated = await backend.update('new', (raw) => {
    assert.equal(raw, undefined);
    return '{"created":true}';
  });
  assert.equal(updated, '{"created":true}');
  assert.equal(await backend.get('new'), '{"created":true}');
});

test('failed transform preserves data and rethrows an existing library error', async () => {
  const backend = new LocalStorageBackend('app');
  await backend.set('key', '1');
  const cause = new NexusStorageError('TYPE_MISMATCH', 'Expected object');
  await assert.rejects(backend.update('key', () => { throw cause; }), (error) => error === cause);
  assert.equal(await backend.get('key'), '1');
});

test('all data operations reject after close while close remains idempotent', async () => {
  const backend = new LocalStorageBackend('app');
  await backend.set('keep', '1');
  await backend.close();
  await backend.close();
  const operations = [
    () => backend.get('keep'), () => backend.set('key', '1'),
    () => backend.update('keep', () => '2'), () => backend.remove('keep'),
    () => backend.keys(), () => backend.clear(),
  ];
  for (const operation of operations) await assert.rejects(operation(), errorCode('CLOSED'));
  assert.equal(await new LocalStorageBackend('app').get('keep'), '1');
});

test('reports storage unavailable when the API is absent', async () => {
  Reflect.deleteProperty(globalThis, 'localStorage');
  const backend = new LocalStorageBackend('app');
  await assert.rejects(backend.get('key'), errorCode('STORAGE_UNAVAILABLE'));
});

test('reports storage unavailable and preserves the cause when acquiring the API throws', async () => {
  const cause = new DOMException('Access denied', 'SecurityError');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw cause; } });
  await assert.rejects(new LocalStorageBackend('app').set('key', '1'), (error: unknown) => {
    assert.ok(error instanceof NexusStorageError);
    assert.equal(error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(error.cause, cause);
    return true;
  });
});

test('reports storage unavailable for an incomplete API', async () => {
  installStorage({ getItem: undefined });
  await assert.rejects(new LocalStorageBackend('app').get('key'), errorCode('STORAGE_UNAVAILABLE'));
});

const failedOperations: Array<[string, (cause: Error) => Storage, (backend: LocalStorageBackend) => Promise<unknown>]> = [
  ['read', (cause) => new (class extends MemoryStorage { override getItem(): never { throw cause; } })(), (backend) => backend.get('key')],
  ['write', (cause) => new (class extends MemoryStorage { override setItem(): never { throw cause; } })(), (backend) => backend.set('key', '1')],
  ['remove', (cause) => new (class extends MemoryStorage {
    override getItem(): string { return '1'; }
    override removeItem(): never { throw cause; }
  })(), (backend) => backend.remove('key')],
  ['key enumeration', (cause) => new (class extends MemoryStorage {
    override get length(): number { return 1; }
    override key(): never { throw cause; }
  })(), (backend) => backend.keys()],
  ['length access', (cause) => new (class extends MemoryStorage { override get length(): never { throw cause; } })(), (backend) => backend.clear()],
  ['update write', (cause) => new (class extends MemoryStorage { override setItem(): never { throw cause; } })(), (backend) => backend.update('key', () => '2')],
];

for (const [name, makeStorage, operation] of failedOperations) {
  test(`wraps native ${name} failures with STORAGE_ERROR and the original cause`, async () => {
    const cause = new DOMException('Operation failed', 'QuotaExceededError');
    installStorage(makeStorage(cause));
    await assert.rejects(operation(new LocalStorageBackend('app')), (error: unknown) => {
      assert.ok(error instanceof NexusStorageError);
      assert.equal(error.code, 'STORAGE_ERROR');
      assert.equal(error.cause, cause);
      return true;
    });
  });
}
