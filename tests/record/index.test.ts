import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NexusStorageError } from '../../src/errors.js';
import {
  decodeRecord, encodeRecord, isExpired, resolveExpiresAt, snapshotWriteOptions,
} from '../../src/record/index.js';
import type { WriteOptions } from '../../src/record/index.js';

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof NexusStorageError && error.code === code;
}

// Unwrapped JSON must never turn ordinary application fields into metadata.
test('keeps metadata-like business fields as ordinary values without a deadline', () => {
  const input = { version: 1, value: 1, expiresAt: 2 };
  assert.equal(encodeRecord(input), '{"version":1,"value":1,"expiresAt":2}');
  assert.deepEqual(decodeRecord(encodeRecord(input)), {
    value: { version: 1, value: 1, expiresAt: 2 },
  });
  assert.deepEqual(decodeRecord('{"value":1,"expiresAt":2}'), {
    value: { value: 1, expiresAt: 2 },
  });
});

test('reads legacy JSON primitives, arrays and objects without adding a deadline', () => {
  for (const [raw, value] of [
    ['null', null], ['true', true], ['42', 42], ['"text"', 'text'],
    ['[1,{"a":2}]', [1, { a: 2 }]], ['{"expiresAt":1e20}', { expiresAt: 1e20 }],
  ] as const) {
    assert.deepEqual(decodeRecord(raw), { value });
  }
});

test('writes a versioned record with an actual newline and round-trips its deadline', () => {
  assert.equal(encodeRecord({ value: 1, expiresAt: 2 }, 100.5),
    'NexusStorage/1\n{"value":{"value":1,"expiresAt":2},"expiresAt":100.5}');
  assert.deepEqual(decodeRecord('NexusStorage/1\n{"value":{"value":1,"expiresAt":2},"expiresAt":100.5}'), {
    value: { value: 1, expiresAt: 2 }, expiresAt: 100.5,
  });
  assert.equal(encodeRecord(null, 0), 'NexusStorage/1\n{"value":null,"expiresAt":0}');
  assert.deepEqual(decodeRecord(encodeRecord(false, Number.MAX_SAFE_INTEGER)), {
    value: false, expiresAt: Number.MAX_SAFE_INTEGER,
  });
});

test('allows prefix text inside legacy JSON strings and business values', () => {
  assert.deepEqual(decodeRecord('"NexusStorage/1\\n"'), { value: 'NexusStorage/1\n' });
  assert.deepEqual(decodeRecord(encodeRecord('NexusStorage/2\n', 5)), {
    value: 'NexusStorage/2\n', expiresAt: 5,
  });
});

test('detaches values decoded from both record formats', () => {
  for (const raw of ['{"items":[1]}', 'NexusStorage/1\n{"value":{"items":[1]},"expiresAt":10}']) {
    const first = decodeRecord(raw);
    const second = decodeRecord(raw);
    assert.deepEqual(first, second);
    assert.notEqual(first.value, second.value);
    (first.value as { items: number[] }).items.push(2);
    assert.deepEqual(second.value, { items: [1] });
  }
});

test('validates business values with and without a deadline', () => {
  for (const value of [undefined, NaN, { missing: undefined }, new Date(0)]) {
    assert.throws(() => encodeRecord(value), errorCode('INVALID_VALUE'));
    assert.throws(() => encodeRecord(value, 10), errorCode('INVALID_VALUE'));
  }
});

const corruptRecords = [
  '', '{broken', '1e400', 'NexusStorage/1', 'NexusStorage/1\\n{"value":1,"expiresAt":10}',
  'NexusStorage/2\n{"value":1,"expiresAt":10}', 'NexusStorage/01\n{"value":1,"expiresAt":10}',
  'NexusStorage/1\n', 'NexusStorage/1\n{broken', 'NexusStorage/1\nnull',
  'NexusStorage/1\n[]', 'NexusStorage/1\n1', 'NexusStorage/1\n{}',
  'NexusStorage/1\n{"value":1}', 'NexusStorage/1\n{"expiresAt":10}',
  'NexusStorage/1\n{"value":1,"expiresAt":null}',
  'NexusStorage/1\n{"value":1,"expiresAt":"10"}',
  'NexusStorage/1\n{"value":1,"expiresAt":-1}',
  'NexusStorage/1\n{"value":1,"expiresAt":1e400}',
  'NexusStorage/1\n{"value":1,"expiresAt":9007199254740992}',
  'NexusStorage/1\n{"value":1,"expiresAt":10,"version":2}',
];

for (const raw of corruptRecords) {
  test(`reports corrupt record ${JSON.stringify(raw)}`, () => {
    assert.throws(() => decodeRecord(raw), errorCode('CORRUPT_DATA'));
  });
}

test('expires a record at its deadline and leaves unbounded records alive', () => {
  assert.equal(isExpired({ value: null }, Number.MAX_SAFE_INTEGER), false);
  assert.equal(isExpired({ value: null, expiresAt: 10 }, 9.5), false);
  assert.equal(isExpired({ value: null, expiresAt: 10 }, 10), true);
  assert.equal(isExpired({ value: null, expiresAt: 10 }, 11), true);
  assert.equal(isExpired({ value: null, expiresAt: 0 }, 0), true);
});

test('captures independent write options while preserving zero and fractional milliseconds', () => {
  assert.deepEqual(snapshotWriteOptions(), {});
  assert.deepEqual(snapshotWriteOptions({}), {});
  assert.deepEqual(snapshotWriteOptions({ ttl: undefined } as unknown as WriteOptions), {});
  assert.deepEqual(snapshotWriteOptions({ expiresAt: undefined } as unknown as WriteOptions), {});
  assert.deepEqual(snapshotWriteOptions({ ttl: 0 }), { ttl: 0 });
  assert.deepEqual(snapshotWriteOptions({ expiresAt: 0 }), { expiresAt: 0 });
  assert.deepEqual(snapshotWriteOptions({ ttl: 0.5 }), { ttl: 0.5 });
  const options = { ttl: 20 };
  const snapshot = snapshotWriteOptions(options);
  options.ttl = 99;
  assert.deepEqual(snapshot, { ttl: 20 });
  assert.notEqual(snapshot, options);
});

test('preserves ttl null as an explicit request to clear a deadline', () => {
  assert.deepEqual(snapshotWriteOptions({ ttl: null }), { ttl: null });
  assert.equal(resolveExpiresAt({ ttl: null }, 100), undefined);
});

test('ignores inherited deadlines and unrelated option fields', () => {
  const inherited = Object.create({ ttl: 5 }) as WriteOptions;
  assert.deepEqual(snapshotWriteOptions(inherited), {});
  assert.deepEqual(snapshotWriteOptions({ expiresAt: 10, extra: true } as WriteOptions), { expiresAt: 10 });
});

test('does not invoke option accessors', () => {
  let reads = 0;
  const options = Object.defineProperty({}, 'ttl', { get() { reads++; return 10; } });
  assert.throws(() => snapshotWriteOptions(options), errorCode('INVALID_OPTIONS'));
  assert.equal(reads, 0);
});

test('wraps inspection failures as invalid write options', () => {
  const cause = new Error('unavailable options');
  const options = new Proxy({}, { getOwnPropertyDescriptor() { throw cause; } });
  assert.throws(() => snapshotWriteOptions(options), (error: unknown) => {
    assert.ok(error instanceof NexusStorageError);
    assert.equal(error.code, 'INVALID_OPTIONS');
    assert.equal(error.cause, cause);
    return true;
  });
});

test('rejects invalid write option containers', () => {
  for (const value of [null, false, 1, 'ttl', [], () => 1]) {
    assert.throws(() => snapshotWriteOptions(value as WriteOptions), errorCode('INVALID_OPTIONS'));
  }
});

test('rejects simultaneous relative and absolute deadlines even when both are zero', () => {
  assert.throws(() => snapshotWriteOptions({ ttl: 0, expiresAt: 0 } as never), errorCode('INVALID_OPTIONS'));
  assert.throws(() => resolveExpiresAt({ ttl: 10, expiresAt: 20 } as never, 100), errorCode('INVALID_OPTIONS'));
  assert.throws(() => snapshotWriteOptions({ ttl: null, expiresAt: 0 } as never), errorCode('INVALID_OPTIONS'));
});

for (const value of [-1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '10', true]) {
  test(`rejects invalid deadline input ${String(value)}`, () => {
    assert.throws(() => snapshotWriteOptions({ ttl: value } as WriteOptions), errorCode('INVALID_OPTIONS'));
    assert.throws(() => snapshotWriteOptions({ expiresAt: value } as WriteOptions), errorCode('INVALID_OPTIONS'));
    assert.throws(() => resolveExpiresAt({ ttl: value } as WriteOptions, 100), errorCode('INVALID_OPTIONS'));
    assert.throws(() => resolveExpiresAt({ expiresAt: value } as WriteOptions, 100), errorCode('INVALID_OPTIONS'));
    assert.throws(() => encodeRecord(1, value as number), errorCode('INVALID_OPTIONS'));
  });
}

test('continues to reject null absolute deadlines', () => {
  assert.throws(() => snapshotWriteOptions({ expiresAt: null } as unknown as WriteOptions), errorCode('INVALID_OPTIONS'));
  assert.throws(() => resolveExpiresAt({ expiresAt: null } as unknown as WriteOptions, 100), errorCode('INVALID_OPTIONS'));
  assert.throws(() => encodeRecord(1, null as unknown as number), errorCode('INVALID_OPTIONS'));
});

test('resolves relative deadlines against write time and preserves absolute deadlines', () => {
  assert.equal(resolveExpiresAt({}, 100), undefined);
  assert.equal(resolveExpiresAt({ ttl: 0 }, 100), 100);
  assert.equal(resolveExpiresAt({ ttl: 0.5 }, 100), 100.5);
  assert.equal(resolveExpiresAt({ ttl: 20 }, 100), 120);
  assert.equal(resolveExpiresAt({ ttl: 20 }, 200), 220);
  assert.equal(resolveExpiresAt({ expiresAt: 5 }, 100), 5);
  assert.equal(resolveExpiresAt({ expiresAt: 0 }, 100), 0);
  assert.equal(resolveExpiresAt({ ttl: 0 }, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('rejects computed deadlines outside the finite safe time range', () => {
  assert.throws(() => resolveExpiresAt({ ttl: 1 }, Number.MAX_SAFE_INTEGER), errorCode('INVALID_OPTIONS'));
  assert.throws(() => resolveExpiresAt({ ttl: Number.MAX_VALUE }, Number.MAX_VALUE), errorCode('INVALID_OPTIONS'));
  for (const now of [NaN, Infinity, -Infinity, -10]) {
    assert.throws(() => resolveExpiresAt({ ttl: 0 }, now), errorCode('INVALID_OPTIONS'));
  }
});
