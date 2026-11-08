import { NexusStorageError } from './errors.js';
import { snapshotJson } from './json.js';
import type { JsonValue } from './types.js';

/** Structural Standard Schema V1 contract, with no runtime dependency. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
}

export type StorageSchemas = Record<string, StandardSchemaV1>;
export type InferSchemaInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input'];
export type InferSchemaOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output'];
/** Optional validators for the normalized output stored under each configured key. */
export type StoredSchemas<S extends StorageSchemas> = keyof S extends never ? Record<string, never> : {
  readonly [K in keyof S]?: StandardSchemaV1<InferSchemaOutput<S[K]>, InferSchemaOutput<S[K]>>;
};

/** Capture keys and validator functions without reading map accessors or inherited keys. */
export function snapshotSchemas(schemas?: Readonly<Record<string, StandardSchemaV1 | undefined>>): ReadonlyMap<string, StandardSchemaV1> {
  const snapshot = new Map<string, StandardSchemaV1>();
  if (schemas === undefined) return snapshot;

  try {
    if (schemas === null || typeof schemas !== 'object') {
      throw new TypeError('Schemas must be an ordinary object or a null-prototype object.');
    }
    const prototype: unknown = Object.getPrototypeOf(schemas);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Schemas must be an ordinary object or a null-prototype object.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(schemas);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === 'symbol') throw new TypeError('Schema mappings cannot have symbol keys.');
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError('Schema mappings cannot have accessor properties.');
      }
      const candidate: unknown = descriptor.value;
      if (candidate === null || (typeof candidate !== 'object' && typeof candidate !== 'function')) {
        throw new TypeError('Each schema must provide Standard Schema V1 properties.');
      }
      const props = (candidate as StandardSchemaV1)['~standard'];
      if (!props || props.version !== 1) {
        throw new TypeError('Each schema must provide Standard Schema V1 synchronous validation.');
      }
      const validate = props.validate;
      if (typeof validate !== 'function') {
        throw new TypeError('Each schema must provide Standard Schema V1 synchronous validation.');
      }
      const captured = Object.freeze({
        version: 1 as const,
        vendor: props.vendor,
        validate: (value: unknown) => Reflect.apply(validate, props, [value]),
      });
      snapshot.set(key, Object.freeze({ '~standard': captured }));
    }
    return snapshot;
  } catch (error) {
    throw new NexusStorageError('INVALID_OPTIONS', 'Unable to configure schema validators.', { cause: error });
  }
}

function validationFailure(cause: unknown): never {
  throw new NexusStorageError('VALIDATION_ERROR', 'The value failed schema validation.', { cause });
}

/** Run synchronous validation on detached input and detach the JSON-compatible output. */
export function validateSchema(schema: StandardSchemaV1 | undefined, value: unknown): JsonValue {
  const input = snapshotJson(value);
  if (schema === undefined) return input;

  let result: unknown;
  let then: unknown;
  try {
    result = schema['~standard'].validate(input);
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      then = (result as { then?: unknown }).then;
    }
  } catch (error) {
    validationFailure(error);
  }

  if (typeof then === 'function') {
    // Capture the then function once. Observing rejection must not await a transaction.
    void new Promise((resolve, reject) => {
      Reflect.apply(then, result, [resolve, reject]);
    }).catch(() => {});
    throw new NexusStorageError('ASYNC_SCHEMA', 'Only synchronous schema validators are supported.', { cause: result });
  }

  let output: unknown;
  let issues: unknown;
  try {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new TypeError('A schema validator must return a result object.');
    }
    issues = (result as { issues?: unknown }).issues;
    if (issues !== undefined) {
      if (!Array.isArray(issues)) throw new TypeError('Schema validation issues must be an array.');
    } else {
      if (!('value' in result)) throw new TypeError('A successful schema result must include a value.');
      output = (result as { value: unknown }).value;
    }
  } catch (error) {
    validationFailure(error);
  }
  if (issues !== undefined) validationFailure(issues);
  return snapshotJson(output);
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((item, index) => equalJson(item, right[index]!));
  }
  if (Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && equalJson(left[key]!, right[key]!));
}

/** Stored validation must accept the value without converting it a second time. */
export function validateStoredSchema(schema: StandardSchemaV1 | undefined, value: unknown): JsonValue {
  const stored = snapshotJson(value);
  if (schema === undefined) return stored;
  const checked = validateSchema(schema, stored);
  if (!equalJson(stored, checked)) {
    throw new NexusStorageError('VALIDATION_ERROR',
      'Stored validators must preserve the JSON value. Configure storedSchemas separately from input transforms.');
  }
  return stored;
}
