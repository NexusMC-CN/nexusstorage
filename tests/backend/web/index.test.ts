import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { LocalStorageBackend } from '../../../src/backend/web/local.js';
import { WebStorageBackend } from '../../../src/backend/web/index.js';
import { NexusStorageError } from '../../../src/errors.js';
import { MemoryStorage } from '../../helpers/memory/storage.js';

const drivers = ['localStorage', 'sessionStorage'] as const;
type WebStorageDriver = typeof drivers[number];
const originalDescriptors = new Map(drivers.map((driver) => [driver, Object.getOwnPropertyDescriptor(globalThis, driver)]));
let local: MemoryStorage;
let session: MemoryStorage;

function installStorage(driver: WebStorageDriver, value: unknown): void {
  Object.defineProperty(globalThis, driver, { configurable: true, value });
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof NexusStorageError && error.code === code;
}

function errorWithCause(code: string, cause: unknown): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof NexusStorageError);
    assert.equal(error.code, code);
    assert.equal(error.cause, cause);
    return true;
  };
}

beforeEach(() => {
  local = new MemoryStorage();
  session = new MemoryStorage();
  installStorage('localStorage', local);
  installStorage('sessionStorage', session);
});

afterEach(() => {
  for (const driver of drivers) {
    const descriptor = originalDescriptors.get(driver);
    if (descriptor) Object.defineProperty(globalThis, driver, descriptor);
    else Reflect.deleteProperty(globalThis, driver);
  }
});

test('keeps the same namespace independent between local and session storage', async () => {
  const persistent = new WebStorageBackend('app', 'localStorage');
  const temporary = new WebStorageBackend('app', 'sessionStorage');
  await persistent.set('key', '"local"');
  assert.equal(await temporary.get('key'), undefined);
  await temporary.set('key', '"session"');
  assert.equal(await persistent.get('key'), '"local"');
  assert.equal(await temporary.get('key'), '"session"');
  await temporary.clear();
  assert.equal(await persistent.get('key'), '"local"');
});

test('the compatibility backend and shared local backend read the same legacy key format', async () => {
  local.setItem('nexusstorage:"app":existing', '"legacy"');
  const legacy = new LocalStorageBackend('app');
  const shared = new WebStorageBackend('app', 'localStorage');
  assert.equal(await shared.get('existing'), '"legacy"');
  await legacy.set('from-legacy', '1');
  assert.equal(await shared.get('from-legacy'), '1');
  await shared.set('from-shared', '2');
  assert.equal(await legacy.get('from-shared'), '2');
  assert.equal(local.getItem('nexusstorage:"app":from-shared'), '2');
});

for (const driver of drivers) {
  test(`${driver}: constructing and closing never acquire either browser API`, async () => {
    let accesses = 0;
    for (const name of drivers) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() { accesses++; throw new Error('Forbidden'); },
      });
    }
    const backend = new WebStorageBackend('ssr', driver);
    await backend.close();
    await backend.close();
    assert.equal(accesses, 0);
  });

  test(`${driver}: acquires only the selected API at operation time`, async () => {
    Reflect.deleteProperty(globalThis, driver);
    const backend = new WebStorageBackend('app', driver);
    const other = driver === 'localStorage' ? 'sessionStorage' : 'localStorage';
    Object.defineProperty(globalThis, other, {
      configurable: true,
      get() { throw new Error('The other API must remain unused'); },
    });
    const storage = new MemoryStorage();
    installStorage(driver, storage);
    await backend.set('key', '1');
    assert.equal(await backend.get('key'), '1');
    assert.equal(storage.getItem('nexusstorage:"app":key'), '1');
  });

  test(`${driver}: reads raw values and shares replacements with same-namespace instances`, async () => {
    const first = new WebStorageBackend('app', driver);
    const second = new WebStorageBackend('app', driver);
    assert.equal(await first.get('missing'), undefined);
    for (const [key, raw] of [['nil', 'null'], ['empty', ''], ['object', '{"a":1}']] as const) {
      await first.set(key, raw);
      assert.equal(await second.get(key), raw);
    }
    await second.set('object', '[2]');
    assert.equal(await first.get('object'), '[2]');
    assert.equal(await first.remove('empty'), true);
    assert.equal(await second.remove('empty'), false);
    assert.equal(await first.get('empty'), undefined);
  });

  test(`${driver}: lists sorted logical keys and clears only its own namespace`, async () => {
    const storage = driver === 'localStorage' ? local : session;
    const backend = new WebStorageBackend('a', driver);
    const neighbor = new WebStorageBackend('a:b', driver);
    const escaped = new WebStorageBackend('a":\\', driver);
    storage.setItem('foreign', 'keep');
    await neighbor.set('key', '"neighbor"');
    await escaped.set('key', '"escaped"');
    for (const key of ['z', '中文', '', '__proto__', 'b:key', 'a']) await backend.set(key, '1');
    assert.deepEqual(await backend.keys(), ['', '__proto__', 'a', 'b:key', 'z', '中文']);
    await backend.clear();
    assert.deepEqual(await backend.keys(), []);
    assert.equal(await neighbor.get('key'), '"neighbor"');
    assert.equal(await escaped.get('key'), '"escaped"');
    assert.equal(storage.getItem('foreign'), 'keep');
    assert.equal(storage.length, 3);
  });

  test(`${driver}: update transforms and writes before yielding and initializes missing values`, async () => {
    const backend = new WebStorageBackend('app', driver);
    const observer = new WebStorageBackend('app', driver);
    assert.equal(await backend.update('counter', (raw) => {
      assert.equal(raw, undefined);
      return '1';
    }), '1');
    const pending = backend.update('counter', (raw) => {
      assert.equal(raw, '1');
      return '2';
    });
    assert.equal(await observer.get('counter'), '2');
    assert.equal(await pending, '2');
  });

  test(`${driver}: a failed transform preserves data and an existing library error`, async () => {
    const backend = new WebStorageBackend('app', driver);
    await backend.set('key', '1');
    const cause = new NexusStorageError('TYPE_MISMATCH', 'Expected object');
    await assert.rejects(backend.update('key', () => { throw cause; }), (error) => error === cause);
    assert.equal(await backend.get('key'), '1');
  });

  test(`${driver}: a native transform failure retains its cause without changing the value`, async () => {
    const backend = new WebStorageBackend('app', driver);
    await backend.set('key', '1');
    const cause = new Error('Transform failed');
    await assert.rejects(backend.update('key', () => { throw cause; }), errorWithCause('STORAGE_ERROR', cause));
    assert.equal(await backend.get('key'), '1');
  });

  test(`${driver}: close permanently rejects every data operation without acquiring storage`, async () => {
    const backend = new WebStorageBackend('app', driver);
    await backend.set('keep', '1');
    await backend.close();
    await backend.close();
    Object.defineProperty(globalThis, driver, {
      configurable: true,
      get() { assert.fail('Closed backends must not acquire browser storage'); },
    });
    for (const operation of [
      () => backend.get('keep'), () => backend.set('key', '1'),
      () => backend.update('keep', () => '2'), () => backend.remove('keep'),
      () => backend.keys(), () => backend.clear(),
    ]) await assert.rejects(operation(), errorCode('CLOSED'));
    installStorage(driver, driver === 'localStorage' ? local : session);
    await assert.rejects(backend.get('keep'), errorCode('CLOSED'));
    assert.equal(await new WebStorageBackend('app', driver).get('keep'), '1');
  });

  test(`${driver}: reports an absent or incomplete API as STORAGE_UNAVAILABLE`, async () => {
    const backend = new WebStorageBackend('app', driver);
    Reflect.deleteProperty(globalThis, driver);
    await assert.rejects(backend.get('key'), errorCode('STORAGE_UNAVAILABLE'));
    installStorage(driver, { getItem: undefined });
    await assert.rejects(backend.get('key'), errorCode('STORAGE_UNAVAILABLE'));
  });

  test(`${driver}: an acquisition failure reports STORAGE_UNAVAILABLE with the original cause`, async () => {
    const cause = new DOMException('Access denied', 'SecurityError');
    Object.defineProperty(globalThis, driver, { configurable: true, get() { throw cause; } });
    await assert.rejects(new WebStorageBackend('app', driver).set('key', '1'), errorWithCause('STORAGE_UNAVAILABLE', cause));
  });

  test(`${driver}: preserves a library error thrown while acquiring the API`, async () => {
    const cause = new NexusStorageError('STORAGE_UNAVAILABLE', 'Browser storage disabled');
    Object.defineProperty(globalThis, driver, { configurable: true, get() { throw cause; } });
    await assert.rejects(new WebStorageBackend('app', driver).get('key'), (error) => error === cause);
  });
}

const failedOperations: Array<[string, (cause: Error) => Storage, (backend: WebStorageBackend) => Promise<unknown>]> = [
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
  ['update read', (cause) => new (class extends MemoryStorage { override getItem(): never { throw cause; } })(), (backend) => backend.update('key', () => '2')],
  ['update write', (cause) => new (class extends MemoryStorage { override setItem(): never { throw cause; } })(), (backend) => backend.update('key', () => '2')],
  ['clear removal', (cause) => new (class extends MemoryStorage {
    override get length(): number { return 1; }
    override key(): string { return 'nexusstorage:"app":key'; }
    override removeItem(): never { throw cause; }
  })(), (backend) => backend.clear()],
];

for (const driver of drivers) {
  for (const [name, makeStorage, operation] of failedOperations) {
    test(`${driver}: native ${name} failures retain their cause as STORAGE_ERROR`, async () => {
      const cause = new DOMException('Operation failed', 'QuotaExceededError');
      installStorage(driver, makeStorage(cause));
      await assert.rejects(operation(new WebStorageBackend('app', driver)), errorWithCause('STORAGE_ERROR', cause));
    });
  }
}
