import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run installed public entries, not source aliases or a symlink to this project.
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const nodeDirectory = dirname(process.execPath);
const npmCandidates = [
  process.env.npm_execpath,
  join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
  join(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
  join(nodeDirectory, '../share/nodejs/npm/bin/npm-cli.js'),
].filter(candidate => candidate && /npm-cli\.js$/i.test(candidate));
const npmCli = npmCandidates.find(candidate => existsSync(candidate));
assert.ok(npmCli, 'Cannot locate npm/bin/npm-cli.js beside Node or through npm_execpath.');
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
const fakePackage = dirname(dirname(dirname(require.resolve('fake-indexeddb'))));
const fakeModule = pathToFileURL(join(fakePackage, 'build/esm/index.js')).href;
const temporaryRoot = join(root, '.tmp');
mkdirSync(temporaryRoot, { recursive: true });
const temporary = mkdtempSync(join(temporaryRoot, 'consumer-'));
const consumer = join(temporary, 'app');
mkdirSync(consumer);
const cacheFixtureModule = pathToFileURL(join(consumer, 'memory-cache-storage.mjs')).href;

function run(label, args, cwd = consumer) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NODE_PATH: '', npm_config_cache: join(temporary, 'npm-cache') },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}).\n${result.stdout ?? ''}${result.stderr ?? ''}`, {
      cause: result.error,
    });
  }
  console.log(`PASS ${label}`);
  return result.stdout;
}

const contract = `
const assert = require('node:assert/strict');

class MemoryStorage {
  #values = new Map();
  get length() { return this.#values.size; }
  clear() { this.#values.clear(); }
  getItem(key) { return this.#values.get(String(key)) ?? null; }
  key(index) { return [...this.#values.keys()][index] ?? null; }
  removeItem(key) { this.#values.delete(String(key)); }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
}

module.exports = async function verify({ NexusStorage, NexusStorageError }, format) {
  // Import and construction must not need browser globals, even in SSR.
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
  delete globalThis.indexedDB;
  delete globalThis.caches;
  const drivers = ['localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage'];
  for (const driver of drivers) {
    const ssr = new NexusStorage({ driver });
    await assert.rejects(ssr.get('missing'), error =>
      error instanceof NexusStorageError && error.code === 'STORAGE_UNAVAILABLE');
    await ssr.close();
  }
  // Memory operations must work with every browser storage global absent.
  const memory = new NexusStorage({ driver: 'memory', namespace: 'private' });
  const otherMemory = new NexusStorage({ driver: 'memory', namespace: 'private' });
  await memory.set('profile', { name: 'Alex' });
  assert.deepEqual(await memory.get('profile'), { name: 'Alex' });
  assert.equal(await otherMemory.get('profile'), undefined);
  await otherMemory.set('profile', { name: 'Sam' });
  await memory.clear();
  assert.deepEqual(await otherMemory.get('profile'), { name: 'Sam' });
  await memory.close();
  await assert.rejects(memory.get('profile'), error =>
    error instanceof NexusStorageError && error.code === 'CLOSED');
  await otherMemory.close();
  const { IDBFactory } = await import(${JSON.stringify(fakeModule)});
  const { MemoryCacheStorage } = await import(${JSON.stringify(cacheFixtureModule)});
  globalThis.localStorage = new MemoryStorage();
  globalThis.sessionStorage = new MemoryStorage();
  globalThis.indexedDB = new IDBFactory();
  globalThis.caches = new MemoryCacheStorage();

  for (const driver of drivers) {
    const storage = new NexusStorage({ driver, namespace: 'consumer-' + format });
    await storage.clear();
    assert.equal(await storage.get('missing'), undefined);
    await storage.set('null', null);
    assert.equal(await storage.get('null'), null);
    assert.equal(await storage.has('null'), true);
    // Browser-backed instances continue sharing the same namespace.
    const peer = new NexusStorage({ driver, namespace: 'consumer-' + format });
    assert.equal(await peer.get('null'), null);
    await peer.set('shared', 'from peer');
    assert.equal(await storage.get('shared'), 'from peer');
    await storage.remove('shared');
    await peer.close();
    const input = { name: 'Alex', settings: { theme: 'light', language: 'zh-CN' }, tags: ['developer'] };
    const writing = storage.set('profile', input);
    input.name = 'changed after call';
    input.settings.theme = 'changed after call';
    const written = await writing;
    assert.deepEqual(written, { name: 'Alex', settings: { theme: 'light', language: 'zh-CN' }, tags: ['developer'] });
    written.tags.push('changed after return');
    assert.deepEqual(await storage.get('profile'), { name: 'Alex', settings: { theme: 'light', language: 'zh-CN' }, tags: ['developer'] });
    const patch = { name: 'Sam', settings: { theme: 'dark' } };
    const updating = storage.update('profile', patch);
    patch.name = 'changed after call';
    assert.deepEqual(await updating, { name: 'Sam', settings: { theme: 'dark' }, tags: ['developer'] });
    assert.deepEqual(await storage.get('profile'), { name: 'Sam', settings: { theme: 'dark' }, tags: ['developer'] });
    assert.deepEqual(await storage.keys(), ['null', 'profile']);
    await assert.rejects(storage.update('missing', { name: 'x' }), error =>
      error instanceof NexusStorageError && error.code === 'NOT_FOUND');
    await assert.rejects(storage.set('invalid', { value: undefined }), error =>
      error instanceof NexusStorageError && error.code === 'INVALID_VALUE');
    assert.equal(await storage.remove('profile'), true);
    assert.equal(await storage.remove('profile'), false);
    assert.equal(await storage.has('profile'), false);
    await storage.clear();
    assert.deepEqual(await storage.keys(), []);
    await storage.close();
    await storage.close();
    await assert.rejects(storage.get('null'), error =>
      error instanceof NexusStorageError && error.code === 'CLOSED');
  }

  const profileSchema = {
    '~standard': {
      version: 1, vendor: 'nexusstorage-consumer',
      validate(value) {
        return value && typeof value === 'object' && typeof value.name === 'string' &&
          Number.isInteger(value.visits) && value.visits >= 0
          ? { value: { name: value.name.trim(), visits: value.visits } }
          : { issues: [{ message: 'Invalid profile' }] };
      },
    },
  };
  const numberSchema = {
    '~standard': {
      version: 1, vendor: 'nexusstorage-consumer',
      validate(value) {
        const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
        return Number.isFinite(number) ? { value: number } : { issues: [{ message: 'Invalid number' }] };
      },
    },
  };
  for (const driver of [...drivers, 'memory']) {
    const storage = new NexusStorage({
      driver, namespace: 'managed-' + format,
      schemas: {
        profile: profileSchema, count: numberSchema,
        async: { '~standard': { version: 1, vendor: 'consumer', validate: async () => ({ value: true }) } },
        nonJson: { '~standard': { version: 1, vendor: 'consumer', validate: () => ({ value: new Date() }) } },
      },
    });
    const realNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      await storage.clear();
      if (driver !== 'memory') {
        const legacy = new NexusStorage({ driver, namespace: 'managed-' + format });
        try {
          await legacy.set('profile', { name: false, visits: 1 });
          await assert.rejects(storage.get('profile'), error =>
            error instanceof NexusStorageError && error.code === 'VALIDATION_ERROR');
          assert.deepEqual(await storage.keys(), ['profile']); // Listing does not execute business validation.
        } finally {
          await legacy.close();
        }
      }
      assert.equal(await storage.set('count', '42'), 42);
      assert.equal(await storage.get('count'), 42);
      assert.deepEqual(await storage.set('profile', { name: ' Alex ', visits: 1 }, { ttl: 100 }),
        { name: 'Alex', visits: 1 });
      now = 1_050;
      await assert.rejects(storage.set('profile', { name: false, visits: 1 }), error =>
        error instanceof NexusStorageError && error.code === 'VALIDATION_ERROR');
      await assert.rejects(storage.update('profile', { visits: -1 }), error =>
        error instanceof NexusStorageError && error.code === 'VALIDATION_ERROR');
      // Patches use the output shape; stored validation must not silently trim them.
      await assert.rejects(storage.update('profile', { name: ' Sam ' }), error =>
        error instanceof NexusStorageError && error.code === 'VALIDATION_ERROR');
      assert.deepEqual(await storage.get('profile'), { name: 'Alex', visits: 1 });
      assert.deepEqual(await storage.update('profile', { name: 'Sam' }), { name: 'Sam', visits: 1 });
      now = 1_099;
      assert.equal(await storage.has('profile'), true);
      now = 1_100;
      assert.equal(await storage.get('profile'), undefined);
      assert.equal(await storage.has('profile'), false);
      assert.deepEqual(await storage.keys(), ['count']);
      await assert.rejects(storage.update('profile', { visits: 2 }), error =>
        error instanceof NexusStorageError && error.code === 'NOT_FOUND');
      assert.equal(await storage.remove('profile'), true);
      assert.equal(await storage.remove('profile'), false);
      await storage.set('profile', { name: 'Alex', visits: 1 }, { ttl: 10 });
      await storage.set('profile', { name: 'Alex', visits: 2 });
      now = 1_200;
      assert.equal(await storage.has('profile'), true);
      await storage.update('profile', { visits: 3 }, { expiresAt: 1_250 });
      now = 1_250;
      assert.equal(await storage.get('profile'), undefined);
      assert.equal(await storage.remove('profile'), true);
      await storage.set('immediate', true, { ttl: 0 });
      assert.equal(await storage.get('immediate'), undefined);
      assert.equal(await storage.remove('immediate'), true);
      await assert.rejects(storage.set('bad-ttl', true, { ttl: -1 }), error =>
        error instanceof NexusStorageError && error.code === 'INVALID_OPTIONS');
      await assert.rejects(storage.set('bad-options', true, { ttl: 1, expiresAt: 2_000 }), error =>
        error instanceof NexusStorageError && error.code === 'INVALID_OPTIONS');
      await assert.rejects(storage.set('async', true), error =>
        error instanceof NexusStorageError && error.code === 'ASYNC_SCHEMA');
      assert.equal(await storage.has('async'), false);
      await assert.rejects(storage.set('nonJson', true), error =>
        error instanceof NexusStorageError && error.code === 'INVALID_VALUE');
      assert.equal(await storage.has('nonJson'), false);
      await storage.set('after-failure', 'queue remains usable');
      assert.equal(await storage.get('after-failure'), 'queue remains usable');
    } finally {
      Date.now = realNow;
      await storage.clear();
      await storage.close();
    }
  }
  // Input transforms and storage validation remain separate in the actual tarball.
  const schema = validate => ({ '~standard': { version: 1, vendor: 'consumer-review', validate } });
  const numberStored = schema(value => typeof value === 'number' && Number.isFinite(value)
    ? { value } : { issues: [{ message: 'Expected stored number' }] });
  const stringLength = schema(value => typeof value === 'string'
    ? { value: value.length } : { issues: [{ message: 'Expected string input' }] });
  const increment = schema(value => typeof value === 'number'
    ? { value: value + 1 } : { issues: [{ message: 'Expected number input' }] });
  const validationError = error => error instanceof NexusStorageError && error.code === 'VALIDATION_ERROR';
  const extraStoredSchemas = { length: numberStored, absent: numberStored };
  assert.throws(() => new NexusStorage({ driver: 'memory', schemas: { length: stringLength }, storedSchemas: extraStoredSchemas }),
    error => error instanceof NexusStorageError && error.code === 'INVALID_OPTIONS');
  for (const driver of [...drivers, 'memory']) {
    let inputCalls = 0;
    let alterStored = false;
    const objectInput = schema(value => {
      inputCalls++;
      return value && typeof value.name === 'string' && Number.isInteger(value.visits)
        ? { value: { name: value.name + '!', visits: value.visits, settings: value.settings } }
        : { issues: [{ message: 'Expected input profile' }] };
    });
    const objectStored = schema(value => value && typeof value.name === 'string' && Number.isInteger(value.visits)
      && value.visits >= 0 && value.settings && typeof value.settings === 'object'
      ? { value: { settings: value.settings, visits: value.visits, name: alterStored ? value.name + '?' : value.name } }
      : { issues: [{ message: 'Expected stored profile' }] });
    const namespace = 'review-' + format + '-' + driver;
    const storage = new NexusStorage({ driver, namespace,
      schemas: { length: stringLength, increment, profile: objectInput },
      storedSchemas: { length: numberStored, increment: numberStored, profile: objectStored } });
    const events = [];
    storage.on('change', event => events.push(event));
    try {
      assert.equal(await storage.set('length', 'hello'), 5);
      assert.equal(await storage.get('length'), 5);
      assert.equal(await storage.set('increment', 1), 2);
      assert.equal(await storage.get('increment'), 2);
      await storage.set('profile', { name: 'Alex', visits: 1, settings: { theme: 'light', language: 'zh' } }, { ttl: 60_000 });
      const before = await storage.getEntry('profile');
      assert.deepEqual(await storage.update('profile', { visits: 2, settings: { theme: 'dark' } }),
        { name: 'Alex!', visits: 2, settings: { theme: 'dark' } });
      const updated = await storage.getEntry('profile');
      assert.equal(updated.expiresAt, before.expiresAt);
      assert.equal(inputCalls, 1, driver + ': reads and updates never rerun explicit input conversion');
      const eventCount = events.length;
      await assert.rejects(storage.update('profile', { visits: -1 }), validationError);
      alterStored = true;
      await assert.rejects(storage.get('profile'), validationError);
      await assert.rejects(storage.set('profile', { name: 'Bad', visits: 1, settings: {} }), validationError);
      alterStored = false;
      assert.deepEqual(await storage.getEntry('profile'), updated);
      assert.equal(events.length, eventCount);
      if (driver !== 'memory') {
        const legacy = new NexusStorage({ driver, namespace });
        try {
          await legacy.set('profile', { name: false, visits: 2, settings: {} }, { ttl: 60_000 });
          const invalid = await legacy.getEntry('profile');
          await assert.rejects(storage.get('profile'), validationError);
          assert.deepEqual(await legacy.getEntry('profile'), invalid, driver + ': failed historical read never rewrites data');
          await legacy.set('profile', updated.value, { expiresAt: updated.expiresAt });
        } finally { await legacy.close(); }
      }
      if (driver === 'memory' || driver === 'indexedDB') {
        const swapped = await storage.compareAndSwap('length', (await storage.getEntry('length')).revision, 'xy');
        assert.equal(swapped.value, 2);
        assert.equal(await storage.get('length'), 2);
        assert.deepEqual(await storage.transaction(['profile', 'length', 'increment'], tx => {
          const length = tx.get('length');
          tx.set('increment', 5);
          tx.update('profile', { visits: 3 });
          return [length, tx.get('increment'), tx.get('profile').name];
        }), [2, 6, 'Alex!']);
        const committed = await storage.getEntry('profile');
        const committedEvents = events.length;
        await assert.rejects(storage.transaction(['profile', 'increment'], tx => {
          tx.set('increment', 100);
          tx.update('profile', { visits: -1 });
        }), validationError);
        assert.equal(await storage.get('increment'), 6);
        assert.deepEqual(await storage.getEntry('profile'), committed);
        assert.equal(events.length, committedEvents);
      }
    } finally { await storage.clear(); await storage.close(); }
    for (const [name, input, validator] of [['length', 'abc', stringLength], ['increment', 1, increment]]) {
      const unsafe = new NexusStorage({ driver, namespace: namespace + '-' + name, schemas: { value: validator } });
      try {
        await assert.rejects(unsafe.set('value', input), validationError);
        assert.equal(await unsafe.has('value'), false, driver + ': invalid fallback output must fail before writing');
        if (driver === 'memory' || driver === 'indexedDB') {
          await assert.rejects(unsafe.compareAndSwap('value', null, input), validationError);
          await assert.rejects(unsafe.transaction(['value'], tx => tx.set('value', input)), validationError);
          assert.equal(await unsafe.has('value'), false);
        }
      } finally { await unsafe.clear(); await unsafe.close(); }
    }
  }
  for (const driver of [...drivers, 'memory']) {
    const namespace = 'concurrency-' + format + '-' + driver;
    const storage = new NexusStorage({ driver, namespace });
    const atomic = driver === 'memory' || driver === 'indexedDB';
    const shared = driver === 'localStorage' || driver === 'indexedDB' || driver === 'cacheStorage';
    const code = expected => error => error instanceof NexusStorageError && error.code === expected;
    const realNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    try {
      assert.deepEqual(storage.capabilities, {
        transactions: atomic, compareAndSwap: atomic, persistent: shared,
        crossTab: shared, broadcast: shared,
        atomicity: driver === 'memory' ? 'instance' : driver === 'indexedDB' ? 'database' : 'none',
      });
      assert.ok(Object.isFrozen(storage.capabilities));
      await storage.clear();
      assert.equal(await storage.getEntry('missing'), undefined);
      const events = [];
      const off = storage.on('change', event => { events.push(event); });
      const offRemove = storage.on('remove', event => { events.push(event); });
      const offClear = storage.on('clear', event => { events.push(event); });
      await storage.set('item', { n: 1 }, { ttl: 10 });
      const first = await storage.getEntry('item');
      assert.deepEqual(first.value, { n: 1 });
      assert.equal(typeof first.revision, 'string');
      assert.ok(first.revision.length > 0);
      assert.equal(first.expiresAt, 10_010);
      assert.deepEqual(events[0], {
        type: 'change', operation: 'set', key: 'item', driver, namespace, source: 'local',
      });
      await storage.update('item', { n: 2 });
      assert.equal((await storage.getEntry('item')).expiresAt, 10_010);
      await storage.update('item', { n: 3 }, { ttl: null });
      now = 10_020;
      assert.equal((await storage.getEntry('item')).expiresAt, undefined);
      assert.deepEqual(await storage.get('item'), { n: 3 });
      const beforeFailure = events.length;
      await assert.rejects(storage.set('invalid', new Date()), code('INVALID_VALUE'));
      await assert.rejects(storage.update('absent', { n: 1 }), code('NOT_FOUND'));
      assert.equal(events.length, beforeFailure);

      if (atomic) {
        const created = await storage.compareAndSwap('cas', null, { n: 1 });
        const replaced = await storage.compareAndSwap('cas', created.revision, { n: 1 });
        assert.deepEqual(replaced.value, { n: 1 });
        assert.notEqual(created.revision, replaced.revision);
        assert.deepEqual(await storage.getEntry('cas'), replaced);
        const beforeConflict = events.length;
        await assert.rejects(storage.compareAndSwap('cas', created.revision, { n: 2 }), code('CONFLICT'));
        await assert.rejects(storage.compareAndSwap('cas', null, { n: 2 }), code('CONFLICT'));
        assert.equal(events.length, beforeConflict);
        assert.deepEqual(await storage.getEntry('cas'), replaced);
        await storage.remove('cas');
        const recreated = await storage.compareAndSwap('cas', null, { n: 1 });
        assert.notEqual(recreated.revision, replaced.revision);
        await storage.set('expired', true, { ttl: 1 });
        now++;
        assert.equal(await storage.getEntry('expired'), undefined);
        assert.equal((await storage.compareAndSwap('expired', null, false)).value, false);
        await storage.set('left', { balance: 10 });
        await storage.set('right', { balance: 1 });
        const committedReads = [];
        const stopReads = storage.on('change', event => {
          if (event.key === 'left' || event.key === 'right') {
            committedReads.push(Promise.all([storage.get('left'), storage.get('right')]));
          }
        });
        const beforeTransaction = events.length;
        let escaped;
        const total = await storage.transaction(['left', 'right', 'temporary'], tx => {
          escaped = tx;
          const left = tx.get('left');
          const right = tx.get('right');
          tx.update('left', { balance: left.balance - 3 });
          tx.set('right', { balance: right.balance + 3 });
          tx.set('temporary', null);
          assert.equal(tx.has('temporary'), true);
          assert.equal(tx.remove('temporary'), true);
          return tx.get('left').balance + tx.get('right').balance;
        });
        assert.equal(total, 11);
        assert.equal(events.length, beforeTransaction + 2);
        const balances = [{ balance: 7 }, { balance: 4 }];
        assert.deepEqual(await Promise.all([storage.get('left'), storage.get('right')]), balances);
        assert.deepEqual(await Promise.all(committedReads), [balances, balances]);
        stopReads();
        assert.throws(() => escaped.get('left'), code('TRANSACTION_INACTIVE'));
        const beforeRollback = events.length;
        const failure = new Error('rollback');
        await assert.rejects(storage.transaction(['left', 'right'], tx => {
          tx.set('left', { balance: 0 });
          tx.remove('right');
          throw failure;
        }), error => error === failure);
        await assert.rejects(storage.transaction(['left'], tx => {
          tx.set('left', { balance: 0 });
          tx.set('undeclared', true);
        }), code('INVALID_KEY'));
        await assert.rejects(storage.transaction(['left'], async tx => {
          tx.set('left', { balance: 0 });
          throw new Error('async callbacks are forbidden');
        }), code('ASYNC_TRANSACTION'));
        await assert.rejects(storage.transaction(['left'], tx => {
          tx.set('left', { balance: 0 });
          return new Date();
        }), code('INVALID_VALUE'));
        assert.equal(events.length, beforeRollback);
        assert.deepEqual(await Promise.all([storage.get('left'), storage.get('right')]), balances);
        const callbackResult = { nested: { accepted: true } };
        const resultSnapshot = await storage.transaction([], () => callbackResult);
        callbackResult.nested.accepted = false;
        assert.deepEqual(resultSnapshot, { nested: { accepted: true } });
      } else {
        const beforeUnsupported = events.length;
        await assert.rejects(storage.transaction(['item'], () => 1), code('UNSUPPORTED_OPERATION'));
        await assert.rejects(storage.compareAndSwap('item', first.revision, { n: 4 }), code('UNSUPPORTED_OPERATION'));
        assert.equal(events.length, beforeUnsupported);
      }
      const stopThrowing = storage.on('change', () => { throw new Error('listener failure'); });
      const stopRejecting = storage.on('change', async () => { throw new Error('listener rejection'); });
      await storage.set('listener-safe', true);
      assert.equal(await storage.get('listener-safe'), true);
      stopThrowing(); stopRejecting();
      const beforeUnsubscribe = events.length;
      off(); off();
      await storage.set('unsubscribed', true, { ttl: null });
      assert.equal(events.length, beforeUnsubscribe);
      assert.equal(await storage.remove('unsubscribed'), true);
      assert.equal(events.at(-1).type, 'remove');
      const beforeMissingRemove = events.length;
      assert.equal(await storage.remove('unsubscribed'), false);
      assert.equal(events.length, beforeMissingRemove);
      await storage.clear();
      assert.deepEqual(events.at(-1), { type: 'clear', operation: 'clear', driver, namespace, source: 'local' });
      offRemove(); offClear();
    } finally {
      Date.now = realNow;
      await storage.close();
    }
  }
  console.log(format + ': five-driver JSON/TTL/input+stored schemas/capabilities/events, Memory/IDB CAS/transactions, and three unsupported-driver contracts passed (browser APIs simulated)');
};
`;

const typeContract = `
type JsonObject = import('@nexusmc-cn/nexusstorage').JsonObject;
type StorageDriver = import('@nexusmc-cn/nexusstorage').StorageDriver;
type StandardSchemaV1<Input = unknown, Output = Input> = import('@nexusmc-cn/nexusstorage').StandardSchemaV1<Input, Output>;
type StorageSchemas = import('@nexusmc-cn/nexusstorage').StorageSchemas;
type StoredSchemas<S extends StorageSchemas> = import('@nexusmc-cn/nexusstorage').StoredSchemas<S>;
type InferSchemaInput<S extends StandardSchemaV1> = import('@nexusmc-cn/nexusstorage').InferSchemaInput<S>;
type InferSchemaOutput<S extends StandardSchemaV1> = import('@nexusmc-cn/nexusstorage').InferSchemaOutput<S>;
type WriteOptions = import('@nexusmc-cn/nexusstorage').WriteOptions;
type StorageEntry<T = JsonValue> = import('@nexusmc-cn/nexusstorage').StorageEntry<T>;
type StorageCapabilities = import('@nexusmc-cn/nexusstorage').StorageCapabilities;
type StorageEvent = import('@nexusmc-cn/nexusstorage').StorageEvent;
const drivers: StorageDriver[] = ['localStorage', 'sessionStorage', 'indexedDB', 'cacheStorage', 'memory'];
for (const driver of drivers) {
  void new NexusStorage({ driver, namespace: 'typed-' + driver });
}
// @ts-expect-error Unknown storage drivers are rejected.
void new NexusStorage({ driver: 'unknown-driver' });
interface Profile {
  name: string;
  settings: { theme: 'light' | 'dark'; language: string };
  tags: string[];
}
const storage = new NexusStorage({ driver: 'indexedDB', namespace: 'typed-consumer' });
const profile: Profile = { name: 'Alex', settings: { theme: 'light', language: 'zh-CN' }, tags: ['developer'] };
const written: Promise<Profile> = storage.set('profile', profile);
const explicitWritten: Promise<Profile> = storage.set<Profile>('profile', profile);
const read: Promise<Profile | undefined> = storage.get<Profile>('profile');
const updated: Promise<Profile> = storage.update<Profile>('profile', { name: 'Sam' });
const keys: Promise<string[]> = storage.keys();
const exists: Promise<boolean> = storage.has('profile');
const removed: Promise<boolean> = storage.remove('profile');
const json: JsonValue = { list: [null, true, 1, 'value'] };
function saveJson<T extends JsonValue>(value: T): Promise<T> {
  return storage.set('json', value);
}
function saveObject<T extends JsonObject>(value: T): Promise<T> {
  return storage.set('object', value);
}
void saveJson;
void saveObject;
void storage.set('json', json);
void storage.update('untyped', { enabled: true });
void storage.set('null', null);
void written; void explicitWritten; void read; void updated; void keys; void exists; void removed;
// @ts-expect-error undefined fields are not JSON data.
void storage.set('invalid', { value: undefined });
// @ts-expect-error BigInt fields are not JSON data.
void storage.set('invalid', { value: 1n });
// @ts-expect-error Function fields are not JSON data.
void storage.set('invalid', { value: () => true });
// @ts-expect-error Dates must be converted explicitly, not accepted as JSON objects.
void storage.set('invalid', { value: new Date() });
// @ts-expect-error A profile patch must use the declared field type.
void storage.update<Profile>('profile', { name: 1 });
// @ts-expect-error A patch cannot add an undefined JSON field.
void storage.update('profile', { value: undefined });
void storage.clear();
void storage.close();

const profileSchema: StandardSchemaV1<Profile> = {
  '~standard': {
    version: 1, vendor: 'consumer',
    validate(value: unknown) { return { value: value as Profile }; },
  },
};
const numberSchema: StandardSchemaV1<string | number, number> = {
  '~standard': {
    version: 1, vendor: 'consumer',
    validate(value: unknown) { return { value: Number(value) }; },
  },
};
const schemas = { profile: profileSchema, count: numberSchema } satisfies StorageSchemas;
const typed = new NexusStorage({ driver: 'memory', schemas });
const typedInput: InferSchemaInput<typeof numberSchema> = '42';
const typedOutput: InferSchemaOutput<typeof numberSchema> = 42;
const ttl: WriteOptions = { ttl: 1_000 };
const deadline: WriteOptions = { expiresAt: Date.now() + 1_000 };
const typedWritten: Promise<Profile> = typed.set('profile', profile, ttl);
const typedRead: Promise<Profile | undefined> = typed.get('profile');
const typedUpdated: Promise<Profile> = typed.update('profile', { name: 'Sam' }, deadline);
const converted: Promise<number> = typed.set('count', typedInput);
const convertedRead: Promise<number | undefined> = typed.get('count');
void typed.set('count', typedOutput);

const stringLengthSchema: StandardSchemaV1<string, number> = {
  '~standard': { version: 1, vendor: 'consumer-review', validate(value) {
    return typeof value === 'string' ? { value: value.length } : { issues: [{ message: 'Expected string' }] };
  } },
};
const storedNumberSchema: StandardSchemaV1<number> = {
  '~standard': { version: 1, vendor: 'consumer-review', validate(value) {
    return typeof value === 'number' ? { value } : { issues: [{ message: 'Expected number' }] };
  } },
};
const transformSchemas = { length: stringLengthSchema, profile: profileSchema };
const storedSchemas = { length: storedNumberSchema } satisfies StoredSchemas<typeof transformSchemas>;
const transformed = new NexusStorage({ driver: 'memory', schemas: transformSchemas, storedSchemas });
const transformedWrite: Promise<number> = transformed.set('length', 'hello');
const transformedRead: Promise<number | undefined> = transformed.get('length');
const transformedEntry: Promise<StorageEntry<number> | undefined> = transformed.getEntry('length');
const transformedSwap: Promise<StorageEntry<number>> = transformed.compareAndSwap('length', null, 'hello');
const transformedTransaction: Promise<number | undefined> = transformed.transaction(['length', 'profile'], tx => {
  const written: number = tx.set('length', 'hello');
  const read: number | undefined = tx.get('length');
  const patched: Profile = tx.update('profile', { name: 'Sam' });
  void written; void patched;
  return read;
});
void transformedWrite; void transformedRead; void transformedEntry; void transformedSwap; void transformedTransaction;
// @ts-expect-error Input types remain string after adding a number storage validator.
void transformed.set('length', 5);
// @ts-expect-error A stored schema can only use an already declared input-schema key.
void new NexusStorage({ schemas: { length: stringLengthSchema }, storedSchemas: { absent: storedNumberSchema } });
// @ts-expect-error Storage validators require matching input schemas.
void new NexusStorage({ storedSchemas: { length: storedNumberSchema } });
// @ts-expect-error A string input validator cannot validate a numeric stored value.
void new NexusStorage({ schemas: { length: stringLengthSchema }, storedSchemas: { length: stringLengthSchema } });
const changesStoredType = {} as StandardSchemaV1<number, string>;
// @ts-expect-error Stored validator output must retain the input schema's numeric output type.
void new NexusStorage({ schemas: { length: stringLengthSchema }, storedSchemas: { length: changesStoredType } });
const unknownStoredOutput = {} as StandardSchemaV1<number, unknown>;
// @ts-expect-error Unknown storage-validator output cannot erase the numeric output contract.
void new NexusStorage({ schemas: { length: stringLengthSchema }, storedSchemas: { length: unknownStoredOutput } });
const unknownStoredTypes = {} as StandardSchemaV1;
// @ts-expect-error An untyped validator cannot bypass a typed storage-output contract.
void new NexusStorage({ schemas: { length: stringLengthSchema }, storedSchemas: { length: unknownStoredTypes } });
void typed.has('profile');
void typed.remove('count');
void typedWritten; void typedRead; void typedUpdated; void converted; void convertedRead;
const unknownSchema = new NexusStorage({
  driver: 'memory',
  schemas: { raw: { '~standard': { version: 1, vendor: 'consumer', validate(value: unknown) { return { value }; } } } },
});
const unknownRead: Promise<unknown> = unknownSchema.get('raw');
void unknownRead;
void unknownSchema.set('raw', { valid: true });
// Unknown schema input keeps the same JSON interface support as an unconfigured store.
void unknownSchema.set('raw', profile);
function saveUnknownJson<T extends JsonValue>(value: T): Promise<unknown> {
  return unknownSchema.set('raw', value);
}
function saveUnknownObject<T extends JsonObject>(value: T): Promise<unknown> {
  return unknownSchema.set('raw', value);
}
void saveUnknownJson;
void saveUnknownObject;
void unknownSchema.update('raw', { name: 'Sam' });
// @ts-expect-error Unknown schema output still requires a plain JSON object patch.
void unknownSchema.update('raw', new Date());
// @ts-expect-error An array cannot be used as an unknown-schema object patch.
void unknownSchema.update('raw', ['invalid']);
// @ts-expect-error A schema without declared input/output types must not silently infer any.
const assumedNumber: Promise<number> = unknownSchema.get('raw');
// @ts-expect-error Unknown schema inputs still enforce JSON values.
void unknownSchema.set('raw', new Date());
void assumedNumber;
// @ts-expect-error Schema instances limit reads to declared keys.
void typed.get('unknown');
// @ts-expect-error Schema instances limit writes to declared keys.
void typed.set('unknown', true);
// @ts-expect-error Schema instances limit patches to declared keys.
void typed.update('unknown', { name: 'Sam' });
// @ts-expect-error Schema instances limit existence checks to declared keys.
void typed.has('unknown');
// @ts-expect-error Schema instances limit removals to declared keys.
void typed.remove('unknown');
// @ts-expect-error Schema input determines set values.
void typed.set('count', false);
// @ts-expect-error A scalar schema output cannot be updated with a scalar patch.
void typed.update('count', 3);
// @ts-expect-error Schema output determines patch field types.
void typed.update('profile', { name: 1 });
// @ts-expect-error Patches cannot add undeclared fields.
void typed.update('profile', { extra: true });
// @ts-expect-error Undefined is invalid JSON even inside a typed schema input.
void typed.set('profile', { ...profile, name: undefined });
// @ts-expect-error Dates cannot bypass strict JSON through a schema that accepts them.
void new NexusStorage({ schemas: { date: {} as StandardSchemaV1<Date, string> } }).set('date', new Date());
// @ts-expect-error Relative and absolute deadlines are mutually exclusive.
const conflicting: WriteOptions = { ttl: 100, expiresAt: 100 };
void conflicting;
const cancelled: WriteOptions = { ttl: null };
void typed.update('profile', { name: 'Sam' }, cancelled);
// @ts-expect-error Null TTL still conflicts with an absolute deadline.
const conflictingCancellation: WriteOptions = { ttl: null, expiresAt: 100 };
// @ts-expect-error Null absolute deadlines are not supported.
const nullDeadline: WriteOptions = { expiresAt: null };
void conflictingCancellation; void nullDeadline;
const capabilities: StorageCapabilities = typed.capabilities;
const atomicity: 'instance' | 'database' | 'none' = capabilities.atomicity;
// @ts-expect-error Capability declarations are read-only.
capabilities.transactions = false;
const entry: Promise<StorageEntry<Profile> | undefined> = typed.getEntry('profile');
const convertedEntry: Promise<StorageEntry<number> | undefined> = typed.getEntry('count');
const swapped: Promise<StorageEntry<number>> = typed.compareAndSwap('count', null, '42', cancelled);
const profileSwapped: Promise<StorageEntry<Profile>> = typed.compareAndSwap('profile', 'opaque-revision', profile);
const freeEntry: Promise<StorageEntry<Profile> | undefined> = storage.getEntry<Profile>('profile');
const freeSwap: Promise<StorageEntry<Profile>> = storage.compareAndSwap('profile', null, profile);
const unsubscribe: () => void = typed.on('change', (event: StorageEvent) => {
  const source: 'local' | 'remote' = event.source;
  void source;
  // @ts-expect-error Events contain metadata, never business values.
  void event.value;
});
unsubscribe();
const transferred: Promise<number> = typed.transaction(['profile', 'count'], tx => {
  const current: Profile | undefined = tx.get('profile');
  const count: number | undefined = tx.get('count');
  const saved: number = tx.set('count', '42', { ttl: null });
  const savedProfile: Profile = tx.set('profile', profile);
  const patched: Profile = tx.update('profile', { name: 'Sam' });
  const exists: boolean = tx.has('profile');
  const removed: boolean = tx.remove('count');
  void current; void count; void savedProfile; void patched; void exists; void removed;
  return saved;
});
const freeTransaction: Promise<Profile | undefined> = storage.transaction(['profile'], tx => {
  const saved: Profile = tx.set('profile', profile);
  const patched: Profile = tx.update<Profile>('profile', { name: 'Sam' });
  void saved; void patched;
  return tx.get<Profile>('profile');
});
// @ts-expect-error Schema keys also limit entry reads.
void typed.getEntry('unknown');
// @ts-expect-error Schema keys also limit compare-and-swap.
void typed.compareAndSwap('unknown', null, true);
// @ts-expect-error Schema input determines CAS input, output can differ.
void typed.compareAndSwap('count', null, false);
// @ts-expect-error CAS revisions are strings or null.
void typed.compareAndSwap('count', 1, 42);
// @ts-expect-error CAS cannot accept non-JSON values.
void storage.compareAndSwap('invalid', null, new Date());
// @ts-expect-error CAS cannot accept undefined JSON fields.
void storage.compareAndSwap('invalid', null, { invalid: undefined });
// @ts-expect-error Transaction scope is limited to declared schema keys.
void typed.transaction(['unknown'], () => 1);
// @ts-expect-error Transaction callbacks must not return a Promise.
void typed.transaction(['count'], async tx => tx.set('count', 42));
// @ts-expect-error Transaction callback results must be JSON data or undefined.
void typed.transaction(['count'], () => new Date());
// @ts-expect-error Undefined cannot let Date results bypass the JSON return boundary.
void typed.transaction(['count'], (): Date | undefined => Math.random() ? new Date() : undefined);
// @ts-expect-error Transaction callback results cannot be functions.
void typed.transaction(['count'], () => () => 42);
// @ts-expect-error Even Promise<undefined> is an asynchronous transaction result.
void typed.transaction(['count'], async () => undefined);
const noResult: Promise<undefined> = typed.transaction(['count'], () => undefined);
typed.transaction(['profile', 'count'], tx => {
  // @ts-expect-error Transaction reads use declared schema keys.
  tx.get('unknown');
  // @ts-expect-error Transaction writes use declared schema keys.
  tx.set('unknown', true);
  // @ts-expect-error Transaction input uses the schema input type.
  tx.set('count', false);
  // @ts-expect-error Transaction patches use schema output fields.
  tx.update('profile', { name: 1 });
  // @ts-expect-error Transaction patches cannot add undeclared fields.
  tx.update('profile', { extra: true });
});
storage.transaction(['invalid'], tx => {
  // @ts-expect-error Transaction writes cannot accept Date values.
  tx.set('invalid', new Date());
  // @ts-expect-error Transaction writes cannot accept undefined JSON fields.
  tx.set('invalid', { invalid: undefined });
  // @ts-expect-error Transaction patches must preserve explicitly declared fields.
  tx.update<Profile>('invalid', { name: 1 });
});
void capabilities; void atomicity; void entry; void convertedEntry; void swapped; void profileSwapped;
void freeEntry; void freeSwap; void transferred; void freeTransaction; void noResult;
void typed.clear();
void typed.close();
`;

try {
  // This deliberately skips prepack: check must validate the already built artifacts.
  const packed = JSON.parse(run('npm pack', [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
  assert.equal(packed.length, 1);
  const archive = packed[0];
  const paths = new Set(archive.files.map(file => file.path));
  for (const path of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts']) {
    assert.ok(paths.has(path), `Tarball is missing ${path}; run npm run build first.`);
  }
  for (const path of paths) {
    assert.ok(path === 'package.json' || path === 'README.md' || path === 'LICENSE' || path.startsWith('dist/'), `Unexpected published file: ${path}`);
  }
  assert.equal(Object.keys(project.dependencies ?? {}).length, 0, 'The package must have no runtime dependencies.');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'nexusstorage-isolated-consumer', private: true, type: 'module' }, null, 2));
  run('offline tarball installation', [npmCli, 'install', join(temporary, archive.filename), '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false']);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@nexusmc-cn/nexusstorage/package.json'), 'utf8'));
  assert.equal(installed.name, project.name);
  assert.equal(installed.version, project.version);
  assert.equal(installed.license, project.license);
  assert.equal(readFileSync(join(consumer, 'node_modules/@nexusmc-cn/nexusstorage/LICENSE'), 'utf8'), readFileSync(join(root, 'LICENSE'), 'utf8'));
  assert.equal(Object.keys(installed.dependencies ?? {}).length, 0);
  // Only the browser API fixture comes from tests; the library is installed from its tarball.
  const typescript = require('typescript');
  const cacheFixture = typescript.transpileModule(
    readFileSync(join(root, 'tests/helpers/memory/cache.ts'), 'utf8'),
    { compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.ES2022 } },
  );
  writeFileSync(join(consumer, 'memory-cache-storage.mjs'), cacheFixture.outputText);
  writeFileSync(join(consumer, 'contract.cjs'), contract);
  writeFileSync(join(consumer, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import * as storage from '@nexusmc-cn/nexusstorage';
import verify from './contract.cjs';
assert.equal(import.meta.resolve('@nexusmc-cn/nexusstorage'), new URL('./node_modules/@nexusmc-cn/nexusstorage/dist/index.js', import.meta.url).href);
await verify(storage, 'ESM');
`);
  writeFileSync(join(consumer, 'consumer.cjs'), `
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const storage = require('@nexusmc-cn/nexusstorage');
const verify = require('./contract.cjs');
assert.equal(require.resolve('@nexusmc-cn/nexusstorage'), resolve(__dirname, 'node_modules/@nexusmc-cn/nexusstorage/dist/index.cjs'));
verify(storage, 'CommonJS').catch(error => { console.error(error); process.exitCode = 1; });
`);
  run('ESM installed consumer', [join(consumer, 'consumer.mjs')]);
  run('CommonJS installed consumer', [join(consumer, 'consumer.cjs')]);

  const esmTypes = `import { NexusStorage } from '@nexusmc-cn/nexusstorage';\nimport type { JsonValue } from '@nexusmc-cn/nexusstorage';\n${typeContract}`;
  const cjsTypes = `import library = require('@nexusmc-cn/nexusstorage');\nimport type { JsonValue } from '@nexusmc-cn/nexusstorage';\nconst { NexusStorage } = library;\n${typeContract}`;
  writeFileSync(join(consumer, 'consumer.mts'), esmTypes);
  writeFileSync(join(consumer, 'consumer.cts'), cjsTypes);
  writeFileSync(join(consumer, 'bundler.ts'), esmTypes);
  const commonOptions = {
    target: 'ES2022', lib: ['ES2022', 'DOM'], strict: true, exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true, noEmit: true, types: [], skipLibCheck: false,
  };
  writeFileSync(join(consumer, 'tsconfig.nodenext.json'), JSON.stringify({
    compilerOptions: { ...commonOptions, module: 'NodeNext', moduleResolution: 'NodeNext' },
    files: ['consumer.mts', 'consumer.cts'],
  }, null, 2));
  writeFileSync(join(consumer, 'tsconfig.bundler.json'), JSON.stringify({
    compilerOptions: { ...commonOptions, module: 'Preserve', moduleResolution: 'Bundler' },
    files: ['bundler.ts'],
  }, null, 2));
  run('NodeNext ESM/CommonJS public types', [tsc, '--project', join(consumer, 'tsconfig.nodenext.json')]);
  run('Bundler public types', [tsc, '--project', join(consumer, 'tsconfig.bundler.json')]);
  console.log('Consumer checks passed against the real tarball. Browser APIs use test fixtures; this is not a browser test.');
} finally {
  // Only remove this run's own mkdtemp directory, never the shared .tmp directory.
  rmSync(temporary, { recursive: true, force: true });
}
