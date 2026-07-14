/**
 * Small, portable persistent key/value storage. Hosts install the private
 * bridge before evaluating an app; applications only use this module.
 */

export interface PocketStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  /** Commit buffered mutations. False means callers may retry later. */
  flush(): boolean;
}

interface StorageBridge {
  load(): string | null | undefined;
  loadBackup?(): string | null | undefined;
  commit(snapshot: string, preserveBackup: boolean): boolean;
}

interface StoredDocument {
  v: 1;
  c: number;
  d: [string, string][];
}

const LIMIT = 64 * 1024;
let values: Map<string, string> | null = null;
let dirty = false;
let preserveBackup = false;

function bridge(): StorageBridge {
  const value = (globalThis as { __pocketStorage?: unknown }).__pocketStorage;
  if (!value || typeof value !== "object") throw new Error("PocketJS: storage is not supported by this host");
  const candidate = value as Partial<StorageBridge>;
  if (typeof candidate.load !== "function" || typeof candidate.commit !== "function") {
    throw new Error("PocketJS: storage host bridge is invalid");
  }
  return candidate as StorageBridge;
}

function checksum(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// QuickJS lacks TextEncoder. This matches UTF-8 byte length, replacing lone
// surrogate halves as U+FFFD like JSON/string bridges do.
function utf8Length(input: string): number {
  let bytes = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c < 0x80) bytes++;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length && (input.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function encode(map: Map<string, string>): string {
  const d = [...map.entries()];
  const payload = JSON.stringify(d);
  return JSON.stringify({ v: 1, c: checksum(payload), d } satisfies StoredDocument);
}

function decode(snapshot: string | null | undefined): Map<string, string> | null {
  if (snapshot == null || utf8Length(snapshot) > LIMIT) return null;
  try {
    const parsed = JSON.parse(snapshot) as Partial<StoredDocument>;
    if (parsed.v !== 1 || !Array.isArray(parsed.d)) return null;
    const payload = JSON.stringify(parsed.d);
    if (parsed.c !== checksum(payload)) return null;
    const result = new Map<string, string>();
    for (const pair of parsed.d) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") return null;
      result.set(pair[0], pair[1]);
    }
    return result;
  } catch {
    return null;
  }
}

function state(): Map<string, string> {
  if (values === null) {
    const host = bridge();
    const primary = host.load();
    values = decode(primary);
    if (values === null) {
      const recovered = decode(host.loadBackup?.() ?? null);
      values = recovered ?? new Map();
      preserveBackup = primary != null || recovered !== null;
    }
  }
  return values;
}

function replace(next: Map<string, string>): void {
  const snapshot = encode(next);
  if (utf8Length(snapshot) > LIMIT) throw new Error("PocketJS: storage quota exceeded (64 KiB)");
  values = next;
  dirty = true;
}

export const storage: PocketStorage = Object.freeze({
  get length(): number { return state().size; },
  key(index: number): string | null { return Number.isInteger(index) && index >= 0 ? [...state().keys()][index] ?? null : null; },
  getItem(key: string): string | null { return state().get(String(key)) ?? null; },
  setItem(key: string, value: string): void {
    const next = new Map(state());
    next.set(String(key), String(value));
    replace(next);
  },
  removeItem(key: string): void {
    const next = new Map(state());
    if (!next.delete(String(key))) return;
    replace(next);
  },
  clear(): void {
    if (state().size) replace(new Map());
  },
  flush(): boolean {
    if (!dirty) return true;
    if (!bridge().commit(encode(state()), preserveBackup)) return false;
    dirty = false;
    preserveBackup = false;
    return true;
  },
});
