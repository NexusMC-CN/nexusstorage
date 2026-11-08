import { NexusStorageError } from './errors.js';
import type { JsonObject, JsonValue } from './types.js';

function invalid(message: string): never {
  throw new NexusStorageError('INVALID_VALUE', message);
}

function copyValue(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('JSON numbers must be finite.');
    return value === 0 ? 0 : value;
  }
  if (typeof value !== 'object') invalid('The value is not supported by JSON.');
  if (ancestors.has(value)) invalid('JSON values cannot contain circular references.');

  const isArray = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    invalid('JSON objects must have an ordinary or null prototype.');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.some((name) => typeof name === 'symbol')) invalid('JSON values cannot have symbol keys.');
  for (const name of names) {
    const descriptor = descriptors[name as string];
    if (!descriptor || !('value' in descriptor)) invalid('JSON values cannot have accessor properties.');
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const length = descriptors.length!.value as number;
      if (names.length !== length + 1) invalid('JSON arrays cannot be sparse or have extra properties.');
      const result: JsonValue[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) invalid('JSON arrays cannot be sparse.');
        result.push(copyValue(descriptor.value, ancestors));
      }
      return result;
    }

    const result: JsonObject = {};
    for (const name of names) {
      const key = name as string;
      Object.defineProperty(result, key, {
        value: copyValue(descriptors[key]!.value, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Validate a JSON value without invoking getters or toJSON, and detach its data. */
export function snapshotJson(value: unknown): JsonValue {
  try {
    return copyValue(value, new Set());
  } catch (error) {
    if (error instanceof NexusStorageError) throw error;
    throw new NexusStorageError('INVALID_VALUE', 'Unable to inspect the JSON value.', { cause: error });
  }
}

function stringifyJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stringifyJson).join(',')}]`;
  return `{${Object.keys(value).map((key) => `${JSON.stringify(key)}:${stringifyJson(value[key]!)}`).join(',')}}`;
}

export function encodeJson(value: unknown): string {
  return stringifyJson(snapshotJson(value));
}

export function decodeJson(raw: string): JsonValue {
  try {
    return snapshotJson(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new NexusStorageError('CORRUPT_DATA', 'Stored data is not valid JSON.', { cause: error });
  }
}

export function mergeJson(raw: string | undefined, patch: JsonObject): string {
  const patchSnapshot = snapshotJson(patch);
  if (patchSnapshot === null || typeof patchSnapshot !== 'object' || Array.isArray(patchSnapshot)) {
    invalid('An update patch must be a JSON object.');
  }
  if (raw === undefined) throw new NexusStorageError('NOT_FOUND', 'The key does not exist.');
  const current = decodeJson(raw);
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw new NexusStorageError('TYPE_MISMATCH', 'Only JSON objects can be updated.');
  }
  for (const key of Object.keys(patchSnapshot)) {
    Object.defineProperty(current, key, {
      value: patchSnapshot[key], enumerable: true, writable: true, configurable: true,
    });
  }
  return stringifyJson(current);
}
