import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NexusStorageError } from '../src/errors.js';
import { decodeJson, encodeJson, mergeJson, snapshotJson } from '../src/json.js';
import type { JsonObject } from '../src/types.js';

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof NexusStorageError && error.code === code;
}

// These tests catch serialization that drops fields, changes types, or retains aliases.
test('snapshots nested JSON without retaining input references', () => {
  const shared = { enabled: true };
  const input = { name: 'Alex', settings: shared, duplicate: shared, tags: ['a', null] };
  const snapshot = snapshotJson(input) as JsonObject;
  shared.enabled = false;
  input.tags.push('b');
  assert.deepEqual(snapshot, {
    name: 'Alex', settings: { enabled: true }, duplicate: { enabled: true }, tags: ['a', null],
  });
  assert.notEqual(snapshot.settings, snapshot.duplicate);
});

test('encodes the complete supported JSON value domain', () => {
  assert.equal(encodeJson({ nil: null, text: '中文\n"', yes: true, no: false, n: 1.5, list: [0, {}] }),
    '{"nil":null,"text":"中文\\n\\\"","yes":true,"no":false,"n":1.5,"list":[0,{}]}');
  assert.equal(encodeJson(null), 'null');
  assert.equal(encodeJson('text'), '"text"');
  assert.equal(encodeJson(false), 'false');
  assert.equal(encodeJson(42), '42');
});

test('normalizes negative zero in both snapshots and decoded values', () => {
  assert.equal(Object.is(snapshotJson(-0), -0), false);
  assert.equal(Object.is(decodeJson('-0'), -0), false);
  assert.equal(encodeJson([-0]), '[0]');
});

test('copies null-prototype objects and non-enumerable own data fields', () => {
  const input = Object.create(null) as Record<string, unknown>;
  input.visible = 1;
  Object.defineProperty(input, 'hidden', { value: { a: true }, enumerable: false });
  assert.deepEqual(snapshotJson(input), { visible: 1, hidden: { a: true } });
  assert.equal(encodeJson(input), '{"visible":1,"hidden":{"a":true}}');
});

const invalidValues: Array<[string, () => unknown]> = [
  ['undefined', () => undefined],
  ['function', () => () => 1],
  ['symbol', () => Symbol('value')],
  ['bigint', () => 1n],
  ['NaN', () => Number.NaN],
  ['positive infinity', () => Number.POSITIVE_INFINITY],
  ['negative infinity', () => Number.NEGATIVE_INFINITY],
  ['date', () => new Date(0)],
  ['map', () => new Map([['x', 1]])],
  ['set', () => new Set([1])],
  ['boxed number', () => new Number(1)],
  ['class instance', () => new (class Value { value = 1; })()],
  ['nested undefined', () => ({ a: { b: undefined } })],
  ['array undefined', () => [1, undefined]],
  ['sparse array', () => [1, , 3]],
  ['all-hole array', () => new Array(2)],
  ['object cycle', () => { const value: Record<string, unknown> = {}; value.self = value; return value; }],
  ['array cycle', () => { const value: unknown[] = []; value.push(value); return value; }],
  ['symbol key', () => ({ a: 1, [Symbol('hidden')]: 2 })],
  ['non-enumerable symbol key', () => Object.defineProperty({}, Symbol('hidden'), { value: 1 })],
  ['array symbol key', () => Object.assign([1], { [Symbol('hidden')]: 2 })],
  ['array named property', () => Object.assign([1], { named: 2 })],
  ['array non-index numeric property', () => Object.assign([1], { '01': 2 })],
];

for (const [name, makeValue] of invalidValues) {
  test(`rejects ${name} instead of silently changing the value`, () => {
    assert.throws(() => snapshotJson(makeValue()), errorCode('INVALID_VALUE'));
    assert.throws(() => encodeJson(makeValue()), errorCode('INVALID_VALUE'));
  });
}

test('rejects getters without invoking them', () => {
  let reads = 0;
  const input = Object.defineProperty({}, 'secret', { enumerable: true, get() { reads++; return 1; } });
  assert.throws(() => snapshotJson(input), errorCode('INVALID_VALUE'));
  assert.equal(reads, 0);
});

test('rejects array accessors without invoking them', () => {
  let reads = 0;
  const input = [1];
  Object.defineProperty(input, '0', { get() { reads++; return 1; } });
  assert.throws(() => snapshotJson(input), errorCode('INVALID_VALUE'));
  assert.equal(reads, 0);
});

test('reads array data from descriptors without executing proxy property reads', () => {
  let reads = 0;
  const input = new Proxy([1, { value: 2 }], {
    get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); },
  });
  assert.deepEqual(snapshotJson(input), [1, { value: 2 }]);
  assert.equal(reads, 0);
});

test('rejects toJSON functions without invoking them', () => {
  let calls = 0;
  const input = { toJSON() { calls++; return { replaced: true }; } };
  assert.throws(() => encodeJson(input), errorCode('INVALID_VALUE'));
  assert.equal(calls, 0);
});

// A stringify of a copied ordinary object still calls a hook on Object.prototype.
test('never invokes inherited object toJSON while encoding or updating', () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  let calls = 0;
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    value() { calls++; return { replaced: true }; },
  });
  try {
    assert.equal(encodeJson({ nested: { n: 1 } }), '{"nested":{"n":1}}');
    assert.equal(mergeJson('{"n":1}', { add: { a: 2 } }), '{"n":1,"add":{"a":2}}');
    assert.equal(calls, 0);
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'toJSON', original);
    else Reflect.deleteProperty(Object.prototype, 'toJSON');
  }
});

test('never invokes inherited array toJSON while encoding or updating', () => {
  const original = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let calls = 0;
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    value() { calls++; return 'changed'; },
  });
  try {
    assert.equal(encodeJson({ list: [1, 2] }), '{"list":[1,2]}');
    assert.equal(mergeJson('{}', { list: [3] }), '{"list":[3]}');
    assert.equal(calls, 0);
  } finally {
    if (original) Object.defineProperty(Array.prototype, 'toJSON', original);
    else Reflect.deleteProperty(Array.prototype, 'toJSON');
  }
});

test('treats prototype-like names as ordinary own data', () => {
  const value = decodeJson('{"__proto__":{"polluted":true},"constructor":1,"prototype":2}') as JsonObject;
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.deepEqual(value.__proto__, { polluted: true });
  assert.equal(encodeJson(value), '{"__proto__":{"polluted":true},"constructor":1,"prototype":2}');
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('decodes supported JSON into independent values', () => {
  const first = decodeJson('{"items":[{"value":1}],"nil":null}') as JsonObject;
  const second = decodeJson('{"items":[{"value":1}],"nil":null}') as JsonObject;
  assert.deepEqual(first, { items: [{ value: 1 }], nil: null });
  assert.notEqual(first, second);
  assert.notEqual(first.items, second.items);
});

for (const raw of ['undefined', '{', '', '{"a":1,}', '[1,]', '1e400', '{"n":-1e400}']) {
  test(`reports corrupt stored JSON for ${JSON.stringify(raw)}`, () => {
    assert.throws(() => decodeJson(raw), (error: unknown) => {
      assert.ok(error instanceof NexusStorageError);
      assert.equal(error.code, 'CORRUPT_DATA');
      assert.ok(error.cause instanceof Error);
      return true;
    });
  });
}

test('shallow-merges objects while replacing nested values and retaining null', () => {
  assert.equal(mergeJson('{"name":"Alex","settings":{"theme":"light","language":"zh-CN"},"tags":[1,2]}', {
    settings: { theme: 'dark' }, tags: [3], name: null,
  }), '{"name":null,"settings":{"theme":"dark"},"tags":[3]}');
});

test('merges special names without changing the result prototype', () => {
  const patch = JSON.parse('{"__proto__":{"admin":true},"constructor":"value"}') as JsonObject;
  const raw = mergeJson('{"kept":1}', patch);
  assert.equal(raw, '{"kept":1,"__proto__":{"admin":true},"constructor":"value"}');
  assert.equal(Object.hasOwn(Object.prototype, 'admin'), false);
});

test('rejects update of a missing record', () => {
  assert.throws(() => mergeJson(undefined, {}), errorCode('NOT_FOUND'));
});

for (const raw of ['null', '[]', '1', '"text"', 'true']) {
  test(`rejects update of non-object stored JSON ${raw}`, () => {
    assert.throws(() => mergeJson(raw, {}), errorCode('TYPE_MISMATCH'));
  });
}

test('rejects a non-object or invalid patch', () => {
  for (const patch of [null, [], 1, new Date(0), { field: undefined }]) {
    assert.throws(() => mergeJson('{}', patch as unknown as JsonObject), errorCode('INVALID_VALUE'));
  }
});

test('reports corrupted data during update instead of replacing it', () => {
  assert.throws(() => mergeJson('{broken', { valid: true }), errorCode('CORRUPT_DATA'));
});
