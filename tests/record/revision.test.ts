import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NexusStorageError } from '../../src/errors.js';
import * as record from '../../src/record/index.js';

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof NexusStorageError && error.code === code;
}

test('writes v2 records with a revision and an optional deadline', () => {
  assert.equal(record.encodeRecord({ answer: 42 }, undefined, 'rev-1'),
    'NexusStorage/2\n{"value":{"answer":42},"revision":"rev-1"}');
  assert.equal(record.encodeRecord(null, 0, 'rev-2'),
    'NexusStorage/2\n{"value":null,"revision":"rev-2","expiresAt":0}');
  assert.deepEqual(record.decodeRecord('NexusStorage/2\n{"value":{"answer":42},"revision":"rev-1"}'), {
    value: { answer: 42 }, revision: 'rev-1',
  });
  assert.deepEqual(record.decodeRecord('NexusStorage/2\n{"value":null,"revision":"rev-2","expiresAt":0}'), {
    value: null, revision: 'rev-2', expiresAt: 0,
  });
});

test('does not interpret revision-like business fields as record metadata', () => {
  const raw = '{"value":1,"revision":"app-revision","expiresAt":5}';
  assert.deepEqual(record.decodeRecord(raw), {
    value: { value: 1, revision: 'app-revision', expiresAt: 5 },
  });
  assert.equal(typeof record.revisionOf, 'function');
  assert.equal(record.revisionOf(raw), 'legacy:' + raw);
});

test('identifies legacy revisions using the exact raw snapshot', () => {
  assert.equal(typeof record.revisionOf, 'function');
  assert.equal(record.revisionOf('{"a":1}'), 'legacy:{"a":1}');
  assert.equal(record.revisionOf('{ "a": 1 }'), 'legacy:{ "a": 1 }');
  assert.notEqual(record.revisionOf('{"a":1}'), record.revisionOf('{ "a": 1 }'));
  const deadlineRaw = 'NexusStorage/1\n{"value":1,"expiresAt":10}';
  assert.equal(record.revisionOf(deadlineRaw), 'legacy:' + deadlineRaw);
});

test('returns a stored v2 revision from a raw or decoded record', () => {
  assert.equal(typeof record.revisionOf, 'function');
  const raw = 'NexusStorage/2\n{"value":1,"revision":"stored-revision","expiresAt":10}';
  assert.equal(record.revisionOf(raw), 'stored-revision');
  assert.equal(record.revisionOf(raw, record.decodeRecord(raw)), 'stored-revision');
});

test('detaches the business values of decoded v2 records', () => {
  const raw = 'NexusStorage/2\n{"value":{"items":[1]},"revision":"r1"}';
  const first = record.decodeRecord(raw);
  const second = record.decodeRecord(raw);
  assert.deepEqual(first, { value: { items: [1] }, revision: 'r1' });
  (first.value as { items: number[] }).items.push(2);
  assert.deepEqual(second, { value: { items: [1] }, revision: 'r1' });
});

test('validates revision-bearing values and deadlines before writing', () => {
  for (const value of [undefined, NaN, { missing: undefined }, new Date(0)]) {
    assert.throws(() => record.encodeRecord(value, undefined, 'r1'), errorCode('INVALID_VALUE'));
  }
  for (const expiresAt of [null, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => record.encodeRecord(1, expiresAt as number, 'r1'), errorCode('INVALID_OPTIONS'));
  }
});

test('rejects empty and invalid revisions when writing', () => {
  for (const revision of ['', null, 1, true, {}]) {
    assert.throws(() => record.encodeRecord(1, undefined, revision as string), errorCode('INVALID_OPTIONS'));
  }
});

const corruptRecords = [
  '', 'null', '[]', '1', '{}', '{broken',
  '{"value":1}', '{"revision":"r1"}', '{"value":1,"revision":""}',
  '{"value":1,"revision":null}', '{"value":1,"revision":1}',
  '{"value":1,"revision":true}', '{"value":1,"revision":{}}',
  '{"value":1,"revision":"r1","extra":1}',
  '{"value":1,"revision":"r1","expiresAt":null}',
  '{"value":1,"revision":"r1","expiresAt":"10"}',
  '{"value":1,"revision":"r1","expiresAt":-1}',
  '{"value":1,"revision":"r1","expiresAt":1e400}',
  '{"value":1,"revision":"r1","expiresAt":9007199254740992}',
  '{"value":1,"revision":"r1","expiresAt":10,"extra":1}',
];

for (const metadata of corruptRecords) {
  test(`rejects corrupt v2 metadata ${JSON.stringify(metadata)}`, () => {
    assert.throws(() => record.decodeRecord('NexusStorage/2\n' + metadata), errorCode('CORRUPT_DATA'));
  });
}

test('creates independent revisions for repeated writes of the same value', () => {
  assert.equal(typeof record.createRevision, 'function');
  const revisions = Array.from({ length: 1000 }, () => record.createRevision());
  assert.ok(revisions.every((revision) => typeof revision === 'string' && revision.length > 0));
  assert.equal(new Set(revisions).size, revisions.length);
  const first = record.encodeRecord(1, undefined, revisions[0]);
  const second = record.encodeRecord(1, undefined, revisions[1]);
  assert.notEqual(first, second);
});

test('creates unique fallback revisions when crypto and random entropy are unavailable', () => {
  assert.equal(typeof record.createRevision, 'function');
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const random = Math.random;
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    Math.random = () => 0;
    const revisions = Array.from({ length: 100 }, () => record.createRevision());
    assert.ok(revisions.every((revision) => revision.length > 0));
    assert.equal(new Set(revisions).size, revisions.length);
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
    Math.random = random;
  }
});

test('uses a native UUID when crypto becomes available at write time', () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
    const fallback = record.createRevision();
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    const native = record.createRevision();
    assert.notEqual(native, fallback);
    assert.match(native, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

test('does not read crypto or browser storage while importing the record module', () => {
  const moduleUrl = new URL('../../src/record/index.ts', import.meta.url).href;
  const script = `
    for (const name of ['crypto', 'localStorage', 'sessionStorage']) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() { throw new Error(name + ' must not be read during import'); },
      });
    }
    await import(${JSON.stringify(moduleUrl)});
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Module import failed.');
});

test('does not read browser storage when creating a revision', () => {
  assert.equal(typeof record.createRevision, 'function');
  const descriptors = ['localStorage', 'sessionStorage'].map((name) => [
    name, Object.getOwnPropertyDescriptor(globalThis, name),
  ] as const);
  try {
    for (const [name] of descriptors) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() { throw new Error('Browser storage must stay untouched.'); },
      });
    }
    assert.ok(record.createRevision().length > 0);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
