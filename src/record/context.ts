import type { RawTransaction } from '../backend/index.js';
import { NexusStorageError } from '../errors.js';
import { decodeJson, encodeJson, mergeJson, snapshotJson } from '../json.js';
import { createRevision, decodeRecord, encodeRecord, isExpired, resolveExpiresAt, revisionOf, snapshotWriteOptions } from './index.js';
import type { WriteOptions } from './index.js';
import { validateSchema } from '../schema.js';
import type { StandardSchemaV1 } from '../schema.js';
import type { JsonObject } from '../types.js';
import type { StorageEntry } from '../storage/api.js';
import type { StorageOperation } from '../events.js';

/** Shared synchronous JSON/schema/TTL rules for normal calls and atomic workspaces. */
export class RecordCodec {
  constructor(private readonly schemas: ReadonlyMap<string, StandardSchemaV1>, private readonly versioned: boolean) {}

  entry(key: string, raw: string | undefined): StorageEntry | undefined {
    if (raw === undefined) return undefined;
    const record = decodeRecord(raw);
    if (isExpired(record, Date.now())) return undefined;
    const entry: StorageEntry = {
      value: validateSchema(this.schemas.get(key), record.value),
      revision: revisionOf(raw, record),
    };
    if (record.expiresAt !== undefined) entry.expiresAt = record.expiresAt;
    return entry;
  }

  set(key: string, value: unknown, options: WriteOptions | undefined, startedAt: number): string {
    const settings = snapshotWriteOptions(options);
    const checked = validateSchema(this.schemas.get(key), value);
    return encodeRecord(checked, resolveExpiresAt(settings, startedAt), this.versioned ? createRevision() : undefined);
  }

  update(key: string, raw: string | undefined, patch: unknown, options: WriteOptions | undefined, startedAt: number): string {
    const snapshot = snapshotJson(patch);
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new NexusStorageError('TYPE_MISMATCH', 'The update patch must be a JSON object.');
    }
    const settings = snapshotWriteOptions(options);
    const record = raw === undefined ? undefined : decodeRecord(raw);
    if (!record || isExpired(record, Date.now())) throw new NexusStorageError('NOT_FOUND', 'The key does not exist or has expired.');
    const merged = decodeJson(mergeJson(encodeJson(record.value), snapshot as JsonObject));
    const checked = validateSchema(this.schemas.get(key), merged);
    const reset = settings.ttl !== undefined || settings.expiresAt !== undefined;
    const expiresAt = reset ? resolveExpiresAt(settings, startedAt) : record.expiresAt;
    return encodeRecord(checked, expiresAt, this.versioned ? createRevision() : undefined);
  }
}

export class TransactionContext {
  private active = true;
  constructor(
    private readonly raw: RawTransaction,
    private readonly codec: RecordCodec,
    private readonly startedAt: number,
    private readonly changed: (key: string, operation: StorageOperation) => void,
  ) {}

  deactivate(): void { this.active = false; }

  private assertActive(): void {
    if (!this.active) throw new NexusStorageError('TRANSACTION_INACTIVE', 'The transaction callback has already finished.');
  }

  get(key: string): unknown {
    this.assertActive();
    return this.codec.entry(key, this.raw.get(key))?.value;
  }
  has(key: string): boolean {
    this.assertActive();
    const raw = this.raw.get(key);
    return raw !== undefined && !isExpired(decodeRecord(raw), Date.now());
  }
  set(key: string, value: unknown, options?: WriteOptions): unknown {
    this.assertActive();
    // Access the workspace first, so inactive and out-of-scope calls cannot run a validator.
    this.raw.get(key);
    const raw = this.codec.set(key, value, options, this.startedAt);
    this.raw.set(key, raw);
    this.changed(key, 'set');
    return decodeRecord(raw).value;
  }
  update(key: string, patch: unknown, options?: WriteOptions): unknown {
    this.assertActive();
    const raw = this.codec.update(key, this.raw.get(key), patch, options, this.startedAt);
    this.raw.set(key, raw);
    this.changed(key, 'update');
    return decodeRecord(raw).value;
  }
  remove(key: string): boolean {
    this.assertActive();
    const existed = this.raw.remove(key);
    if (existed) this.changed(key, 'remove');
    return existed;
  }
}
