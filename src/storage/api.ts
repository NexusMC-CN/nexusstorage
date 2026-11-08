import type { InferSchemaInput, InferSchemaOutput, StandardSchemaV1, StorageSchemas } from '../schema.js';
import type { FreeStorageKey, StorageKey, JsonInput, JsonObject, JsonValue } from '../types.js';
import type { WriteOptions } from '../record/index.js';

export interface StorageEntry<T = JsonValue> {
  value: T;
  revision: string;
  expiresAt?: number;
}

export type SchemaJsonInput<T extends StandardSchemaV1, V> = unknown extends InferSchemaInput<T>
  ? V & JsonInput<V> : InferSchemaInput<T> & JsonInput<InferSchemaInput<T>>;
export type UnknownInputKey<S extends StorageSchemas> = {
  [K in keyof S]: unknown extends InferSchemaInput<S[K]> ? K : never
}[keyof S] & string;
type ObjectPatch<T> = T extends readonly unknown[] ? never
  : T extends object ? Partial<T> & JsonInput<Partial<T>> : never;
export type SchemaPatch<T extends StandardSchemaV1, P extends object> = unknown extends InferSchemaOutput<T>
  ? P & JsonInput<P> & (P extends readonly unknown[] ? never : unknown)
  : ObjectPatch<InferSchemaOutput<T>>;

/** A synchronous view restricted to the transaction's declared keys. */
export interface StorageTransaction<S extends StorageSchemas = Record<never, never>> {
  get<K extends Extract<keyof S, string>>(key: K): InferSchemaOutput<S[K]> | undefined;
  get<T = JsonValue>(key: FreeStorageKey<S>): T | undefined;
  has(key: StorageKey<S>): boolean;
  set<T extends JsonValue, K extends UnknownInputKey<S> = UnknownInputKey<S>>(key: K, value: T, options?: WriteOptions): InferSchemaOutput<S[K]>;
  set<K extends Extract<keyof S, string>, V = InferSchemaInput<S[K]>>(key: K, value: SchemaJsonInput<S[K], V>, options?: WriteOptions): InferSchemaOutput<S[K]>;
  set<T extends JsonValue>(key: FreeStorageKey<S>, value: T, options?: WriteOptions): T;
  set<T>(key: FreeStorageKey<S>, value: T & JsonInput<T>, options?: WriteOptions): T;
  update<K extends Extract<keyof S, string>, P extends object = JsonObject>(key: K, patch: SchemaPatch<S[K], P>, options?: WriteOptions): InferSchemaOutput<S[K]>;
  update<T extends object = JsonObject>(key: FreeStorageKey<S>, patch: Partial<T> & JsonInput<Partial<T>>, options?: WriteOptions): T;
  remove(key: StorageKey<S>): boolean;
}

/** Transactions return a detached JSON result, or no result. */
export type SynchronousResult<T> = T extends PromiseLike<unknown> ? never
  : T extends void ? T : T & JsonInput<T>;
