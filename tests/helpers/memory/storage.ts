/** A complete Storage-method substitute for Node tests; data stays in this helper. */
export class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(String(key)) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(String(key)); }
  setItem(key: string, value: string): void { this.#values.set(String(key), String(value)); }
}
