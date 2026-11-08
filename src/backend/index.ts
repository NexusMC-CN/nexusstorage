export interface RawTransaction {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): boolean;
}

export interface StorageBackend {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  update(key: string, transform: (raw: string | undefined) => string): Promise<string>;
  atomic?<T>(keys: readonly string[], transform: (transaction: RawTransaction) => T): Promise<T>;
  remove(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
