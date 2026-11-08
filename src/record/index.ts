import { NexusStorageError } from '../errors.js';
import { decodeJson, encodeJson } from '../json.js';
import type { JsonValue } from '../types.js';

export interface StorageRecord {
  value: JsonValue;
  expiresAt?: number;
  revision?: string;
}

export type WriteOptions =
  | { ttl?: number | null; expiresAt?: never }
  | { ttl?: never; expiresAt?: number };

const RECORD_PREFIX = 'NexusStorage/1\n';
const REVISIONED_RECORD_PREFIX = 'NexusStorage/2\n';
let revisionCounter = 0;

function isValidTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function assertValidTime(value: unknown): asserts value is number {
  if (!isValidTime(value)) {
    throw new NexusStorageError('INVALID_OPTIONS',
      'A deadline or TTL must be a finite non-negative number within the safe time range.');
  }
}

/** Keep legacy encoding unchanged unless a deadline or revision is present. */
export function encodeRecord(value: unknown, expiresAt?: number, revision?: string): string {
  if (expiresAt !== undefined) assertValidTime(expiresAt);
  if (revision !== undefined) {
    if (typeof revision !== 'string' || revision.length === 0) {
      throw new NexusStorageError('INVALID_OPTIONS', 'A record revision must be a non-empty string.');
    }
    return REVISIONED_RECORD_PREFIX + encodeJson(expiresAt === undefined
      ? { value, revision } : { value, revision, expiresAt });
  }
  return expiresAt === undefined ? encodeJson(value) : RECORD_PREFIX + encodeJson({ value, expiresAt });
}

/** Decode metadata only after its non-JSON prefix; business fields remain untouched. */
export function decodeRecord(raw: string): StorageRecord {
  const revisioned = raw.startsWith(REVISIONED_RECORD_PREFIX);
  if (!revisioned && !raw.startsWith(RECORD_PREFIX)) return { value: decodeJson(raw) };
  const prefix = revisioned ? REVISIONED_RECORD_PREFIX : RECORD_PREFIX;
  const metadata = decodeJson(raw.slice(prefix.length));
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)
    || !Object.hasOwn(metadata, 'value')) {
    throw new NexusStorageError('CORRUPT_DATA', 'Stored record metadata is invalid.');
  }
  const hasDeadline = Object.hasOwn(metadata, 'expiresAt');
  if (revisioned) {
    if (!Object.hasOwn(metadata, 'revision') || typeof metadata.revision !== 'string'
      || metadata.revision.length === 0 || Object.keys(metadata).length !== (hasDeadline ? 3 : 2)
      || (hasDeadline && !isValidTime(metadata.expiresAt))) {
      throw new NexusStorageError('CORRUPT_DATA', 'Stored record metadata is invalid.');
    }
    return hasDeadline
      ? { value: metadata.value!, revision: metadata.revision, expiresAt: metadata.expiresAt as number }
      : { value: metadata.value!, revision: metadata.revision };
  }
  if (Object.keys(metadata).length !== 2 || !hasDeadline || !isValidTime(metadata.expiresAt)) {
    throw new NexusStorageError('CORRUPT_DATA', 'Stored record metadata is invalid.');
  }
  return { value: metadata.value!, expiresAt: metadata.expiresAt };
}

/** Legacy revisions identify the exact raw snapshot, including its whitespace. */
export function revisionOf(raw: string, record: StorageRecord = decodeRecord(raw)): string {
  return record.revision ?? 'legacy:' + raw;
}

/** Generate each revision at write time without touching browser storage. */
export function createRevision(): string {
  try {
    const crypto = globalThis.crypto;
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Some environments expose crypto but deny access to it or its UUID method.
  }
  return `fallback:${++revisionCounter}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`;
}

export function isExpired(record: StorageRecord, now: number): boolean {
  return record.expiresAt !== undefined && now >= record.expiresAt;
}

/** Capture options before a write is queued without executing property accessors. */
export function snapshotWriteOptions(options?: WriteOptions): WriteOptions {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new NexusStorageError('INVALID_OPTIONS', 'Write options must be an object.');
  }
  try {
    const ttlDescriptor = Object.getOwnPropertyDescriptor(options, 'ttl');
    const deadlineDescriptor = Object.getOwnPropertyDescriptor(options, 'expiresAt');
    if ((ttlDescriptor && !('value' in ttlDescriptor))
      || (deadlineDescriptor && !('value' in deadlineDescriptor))) {
      throw new NexusStorageError('INVALID_OPTIONS', 'Write options cannot contain deadline accessors.');
    }
    const ttl: unknown = ttlDescriptor?.value;
    const expiresAt: unknown = deadlineDescriptor?.value;
    if (ttl !== undefined && expiresAt !== undefined) {
      throw new NexusStorageError('INVALID_OPTIONS', 'TTL and expiresAt are mutually exclusive.');
    }
    const snapshot: WriteOptions = {};
    if (ttl !== undefined) {
      if (ttl !== null) assertValidTime(ttl);
      snapshot.ttl = ttl === 0 ? 0 : ttl;
    }
    if (expiresAt !== undefined) {
      assertValidTime(expiresAt);
      snapshot.expiresAt = expiresAt === 0 ? 0 : expiresAt;
    }
    return snapshot;
  } catch (error) {
    if (error instanceof NexusStorageError && error.code === 'INVALID_OPTIONS') throw error;
    throw new NexusStorageError('INVALID_OPTIONS', 'Unable to inspect write options.', { cause: error });
  }
}

/** Start a relative TTL when the queued write executes. */
export function resolveExpiresAt(options: WriteOptions, now: number): number | undefined {
  const snapshot = snapshotWriteOptions(options);
  if (snapshot.expiresAt !== undefined) return snapshot.expiresAt;
  if (snapshot.ttl === undefined || snapshot.ttl === null) return undefined;
  const expiresAt = now + snapshot.ttl;
  assertValidTime(expiresAt);
  return expiresAt;
}
