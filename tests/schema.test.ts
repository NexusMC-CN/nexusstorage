import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { NexusStorageError } from '../src/errors.js';
import { snapshotSchemas, validateSchema } from '../src/schema.js';
import type { InferSchemaInput, InferSchemaOutput, StandardSchemaV1, StorageSchemas } from '../src/schema.js';
import type { JsonObject } from '../src/types.js';

function schema<Output>(validate: StandardSchemaV1.Props<unknown, Output>['validate']): StandardSchemaV1<unknown, Output> {
  return { '~standard': { version: 1, vendor: 'test', validate } };
}

function errorCode(code: string, cause?: unknown): (error: unknown) => boolean {
  return (error) => error instanceof NexusStorageError && error.code === code
    && (cause === undefined || error.cause === cause);
}

// Skipping either snapshot would expose caller or validator aliases to later mutations.
test('returns an independent strict JSON snapshot without a schema', () => {
  const input = { nested: { value: 1 } };
  const output = validateSchema(undefined, input);
  input.nested.value = 2;
  assert.deepEqual(output, { nested: { value: 1 } });
  assert.notEqual(output, input);
  assert.throws(() => validateSchema(undefined, { value: undefined }), errorCode('INVALID_VALUE'));
});

test('accepts synchronous conversion and copies the validator output', () => {
  const transformed = { age: 42, tags: ['checked'] };
  const output = validateSchema(schema(() => ({ value: transformed })), { age: '42' });
  transformed.age = 99;
  transformed.tags.push('changed');
  assert.deepEqual(output, { age: 42, tags: ['checked'] });
});

test('validator mutations do not modify the supplied input', () => {
  const input = { nested: { count: 1 } };
  const output = validateSchema(schema((value) => {
    const record = value as typeof input;
    record.nested.count++;
    return { value: record };
  }), input);
  assert.deepEqual(input, { nested: { count: 1 } });
  assert.deepEqual(output, { nested: { count: 2 } });
});

test('checks strict JSON before invoking a validator', () => {
  let calls = 0;
  const validator = schema(() => { calls++; return { value: 'accepted' }; });
  for (const input of [undefined, new Date(0), { invalid: undefined }, Number.NaN]) {
    assert.throws(() => validateSchema(validator, input), errorCode('INVALID_VALUE'));
  }
  assert.equal(calls, 0);
});

test('preserves validator property receiver when validating', () => {
  const validator: StandardSchemaV1 = {
    '~standard': {
      version: 1, vendor: 'receiver',
      validate() { return { value: this.vendor }; },
    },
  };
  assert.equal(validateSchema(validator, null), 'receiver');
});

test('preserves validation issues as the failure cause', () => {
  const issues = [{ message: 'Expected a name', path: ['name'] }];
  assert.throws(() => validateSchema(schema(() => ({ issues })), {}), errorCode('VALIDATION_ERROR', issues));
});

test('an empty issues array is a validation failure', () => {
  const issues: StandardSchemaV1.Issue[] = [];
  assert.throws(() => validateSchema(schema(() => ({ issues })), 1), errorCode('VALIDATION_ERROR', issues));
});

test('preserves thrown validator errors as the failure cause', () => {
  const cause = new Error('Validator failed');
  assert.throws(() => validateSchema(schema(() => { throw cause; }), 1), errorCode('VALIDATION_ERROR', cause));
});

test('wraps thrown NexusStorageErrors as validator failures', () => {
  const cause = new NexusStorageError('INVALID_VALUE', 'Thrown by validator');
  assert.throws(() => validateSchema(schema(() => { throw cause; }), 1), errorCode('VALIDATION_ERROR', cause));
});

for (const [name, result] of [
  ['undefined', undefined], ['null', null], ['primitive', 3], ['empty object', {}],
  ['array', []], ['invalid issues', { issues: 'invalid' }],
] as const) {
  test(`rejects malformed schema results: ${name}`, () => {
    assert.throws(() => validateSchema(schema(() => result as never), 1), (error: unknown) => {
      assert.ok(error instanceof NexusStorageError);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.ok(error.cause instanceof Error);
      return true;
    });
  });
}

test('does not read a success value when validation issues exist', () => {
  const issues = [{ message: 'No' }];
  let reads = 0;
  const result = Object.defineProperty({ issues }, 'value', { get() { reads++; return 1; } });
  assert.throws(() => validateSchema(schema(() => result), 1), errorCode('VALIDATION_ERROR', issues));
  assert.equal(reads, 0);
});

test('wraps schema result inspection errors with their original cause', () => {
  const cause = new Error('Cannot inspect result');
  const result = Object.defineProperty({}, 'issues', { get() { throw cause; } });
  assert.throws(() => validateSchema(schema(() => result as never), 1), errorCode('VALIDATION_ERROR', cause));
});

for (const [name, output] of [
  ['undefined', undefined], ['date', new Date(0)], ['non-finite number', Number.POSITIVE_INFINITY],
  ['nested undefined', { value: undefined }],
] as const) {
  test(`keeps non-JSON validator output as INVALID_VALUE: ${name}`, () => {
    assert.throws(() => validateSchema(schema(() => ({ value: output })), null), errorCode('INVALID_VALUE'));
  });
}

test('rejects Promise results synchronously and observes asynchronous rejection', async () => {
  const reason = new Error('Asynchronous failure');
  const rejected = Promise.reject(reason);
  assert.throws(() => validateSchema(schema(() => rejected), 1), errorCode('ASYNC_SCHEMA'));
  await setImmediate();
});

test('rejects resolving Promise results synchronously', () => {
  const result = Promise.resolve({ value: 2 });
  assert.throws(() => validateSchema(schema(() => result), 1), errorCode('ASYNC_SCHEMA'));
});

test('observes foreign thenable rejections without allowing async validation', async () => {
  let observed = false;
  const result = {
    then(_resolve: unknown, reject: (reason: unknown) => void) {
      observed = true;
      reject(new Error('Foreign rejection'));
    },
  };
  assert.throws(() => validateSchema(schema(() => result as never), 1), errorCode('ASYNC_SCHEMA'));
  await setImmediate();
  assert.equal(observed, true);
});

// Reusing the caller's map or reading through its prototype would change configured keys.
test('copies schema mappings without retaining the original mapping', () => {
  const first = schema((value) => ({ value }));
  const replacement = schema(() => ({ value: 'replacement' }));
  const source: StorageSchemas = { profile: first };
  const snapshot = snapshotSchemas(source);
  source.profile = replacement;
  source.later = first;
  assert.equal(validateSchema(snapshot.get('profile'), 'original'), 'original');
  assert.equal(snapshot.has('later'), false);
});

test('captures validator functions and original receivers against later schema replacement', () => {
  const props: StandardSchemaV1.Props = {
    version: 1, vendor: 'captured',
    validate(value) { assert.equal(this, props); return { value: { checked: value } }; },
  };
  const source = { '~standard': props };
  const snapshot = snapshotSchemas({ profile: source });
  Object.defineProperty(props, 'validate', { value: () => ({ value: 'bypassed' }) });
  source['~standard'] = { version: 1, vendor: 'changed', validate: () => ({ value: 'replaced' }) };
  assert.deepEqual(validateSchema(snapshot.get('profile'), 1), { checked: 1 });
});

test('captures a schema validator property exactly once', () => {
  let reads = 0;
  const props = {
    version: 1 as const, vendor: 'getter',
    get validate() {
      reads++;
      return reads === 1 ? (value: unknown) => ({ value }) : () => ({ value: 'bypassed' });
    },
  };
  const snapshot = snapshotSchemas({ profile: { '~standard': props } });
  assert.equal(reads, 1);
  assert.equal(validateSchema(snapshot.get('profile'), 'checked'), 'checked');
});

test('accepts an omitted schema mapping', () => {
  assert.equal(snapshotSchemas().size, 0);
});

test('copies null-prototype mappings, hidden data keys and special property names', () => {
  const validator = schema((value) => ({ value }));
  const source = Object.create(null) as StorageSchemas;
  Object.defineProperty(source, 'hidden', { value: validator });
  source.__proto__ = validator;
  Object.defineProperty(source, 'constructor', { value: validator });
  const snapshot = snapshotSchemas(source);
  assert.equal(snapshot.size, 3);
  assert.equal(validateSchema(snapshot.get('hidden'), 1), 1);
  assert.equal(validateSchema(snapshot.get('__proto__'), 2), 2);
  assert.equal(validateSchema(snapshot.get('constructor'), 3), 3);
});

test('never reads inherited schema map keys', () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'inheritedSchema');
  let reads = 0;
  Object.defineProperty(Object.prototype, 'inheritedSchema', {
    configurable: true, get() { reads++; throw new Error('Unexpected inherited access'); },
  });
  try {
    const validator = schema((value) => ({ value }));
    const snapshot = snapshotSchemas({ profile: validator });
    assert.equal(snapshot.size, 1);
    assert.equal(snapshot.has('inheritedSchema'), false);
    assert.equal(reads, 0);
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'inheritedSchema', original);
    else Reflect.deleteProperty(Object.prototype, 'inheritedSchema');
  }
});

test('copies map data from descriptors without executing proxy property reads', () => {
  let reads = 0;
  const validator = schema((value) => ({ value }));
  const source = new Proxy({ profile: validator }, {
    get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); },
  });
  assert.equal(validateSchema(snapshotSchemas(source).get('profile'), 1), 1);
  assert.equal(reads, 0);
});

test('rejects map accessors without invoking their getters', () => {
  let reads = 0;
  const source = Object.defineProperty({}, 'profile', { get() { reads++; return schema(() => ({ value: 1 })); } });
  assert.throws(() => snapshotSchemas(source), errorCode('INVALID_OPTIONS'));
  assert.equal(reads, 0);
});

for (const [name, source] of [
  ['null', null], ['array', []], ['Map', new Map()], ['primitive', 1], ['function', () => 1],
  ['custom prototype', Object.create({ inherited: schema((value) => ({ value })) })],
  ['symbol key', { [Symbol('schema')]: schema((value) => ({ value })) }],
  ['missing schema', { profile: undefined }], ['wrong version', { profile: { '~standard': { version: 2, validate() {} } } }],
  ['missing validator', { profile: { '~standard': { version: 1 } } }],
  ['missing standard props', { profile: {} }],
] as const) {
  test(`rejects invalid schema configuration: ${name}`, () => {
    assert.throws(() => snapshotSchemas(source as never), errorCode('INVALID_OPTIONS'));
  });
}

test('preserves schema inspection errors as invalid option causes', () => {
  const cause = new Error('Cannot inspect schema');
  const invalid = Object.defineProperty({}, '~standard', { get() { throw cause; } });
  assert.throws(() => snapshotSchemas({ profile: invalid as never }), errorCode('INVALID_OPTIONS', cause));
});

// Both schema inference helpers must preserve a transform's distinct input and output.
const typedSchema = null as unknown as StandardSchemaV1<{ age: string }, { age: number }>;
const input: InferSchemaInput<typeof typedSchema> = { age: '42' };
const output: InferSchemaOutput<typeof typedSchema> = { age: 42 };
// @ts-expect-error Input retains the validator's input type.
const invalidInput: InferSchemaInput<typeof typedSchema> = { age: 42 };
// @ts-expect-error Output retains the validator's transformed output type.
const invalidOutput: InferSchemaOutput<typeof typedSchema> = { age: '42' };
void [input, output, invalidInput, invalidOutput];

// Ensure inferred output remains usable as a JSON record in normal consumers.
const jsonOutput: JsonObject = output;
void jsonOutput;
