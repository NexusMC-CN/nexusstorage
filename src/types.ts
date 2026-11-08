import type { StorageSchemas, StoredSchemas } from './schema.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
/** JSON-compatible input, including objects declared with a TypeScript interface. */
export type JsonInput<T> = T extends JsonValue ? T
  : T extends (...args: never[]) => unknown ? never
  : T extends object ? { [K in keyof T]: K extends symbol ? never : JsonInput<T[K]> }
  : never;
export type StorageDriver = 'memory' | 'localStorage' | 'sessionStorage' | 'indexedDB' | 'cacheStorage';

export interface NexusStorageOptions<S extends StorageSchemas = Record<never, never>> {
  driver?: StorageDriver;
  namespace?: string;
  schemas?: S;
  storedSchemas?: NoInfer<StoredSchemas<S>>;
  broadcast?: boolean;
}

export type StorageKey<S extends StorageSchemas> = keyof S extends never ? string : Extract<keyof S, string>;
/** Only unconfigured instances expose the legacy free-key generic overloads. */
export type FreeStorageKey<S extends StorageSchemas> = keyof S extends never ? string : never;
