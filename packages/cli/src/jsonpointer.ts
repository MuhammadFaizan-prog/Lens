/** RFC 6901 JSON pointers plus a small structural diff (what a command changed). */
import { invalid } from "./errors.js";

export function parsePointer(ptr: string): string[] {
  if (ptr === "" || ptr === "/") return [];
  if (!ptr.startsWith("/")) throw invalid(`JSON pointer must start with "/": ${ptr}`);
  return ptr.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function formatPointer(parts: Array<string | number>): string {
  return parts.length ? "/" + parts.map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1")).join("/") : "";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function getAt(doc: unknown, parts: string[]): { found: boolean; value?: unknown } {
  let cur: unknown = doc;
  for (const k of parts) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(k) || Number(k) >= cur.length) return { found: false };
      cur = cur[Number(k)];
    } else if (isObj(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, k)) return { found: false };
      cur = cur[k];
    } else return { found: false };
  }
  return { found: true, value: cur };
}

/**
 * Set a value (returns a new document; the input is not modified). Objects: the key must exist
 * unless `create`; arrays: an index < length replaces, `-` or index == length appends.
 */
export function setAt<T>(doc: T, parts: string[], value: unknown, create = false): T {
  if (!parts.length) return value as T;
  const root = structuredClone(doc) as unknown;
  let cur: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = getAt(cur, [k]);
    if (!next.found || typeof next.value !== "object" || next.value === null) throw invalid(`no object or array at ${formatPointer(parts.slice(0, i + 1))}`);
    cur = next.value;
  }
  const last = parts[parts.length - 1]!;
  if (Array.isArray(cur)) {
    if (last === "-" || last === String(cur.length)) cur.push(value);
    else if (/^(0|[1-9]\d*)$/.test(last) && Number(last) < cur.length) cur[Number(last)] = value;
    else throw invalid(`array index ${last} out of range at ${formatPointer(parts)}`);
  } else if (isObj(cur)) {
    if (!create && !Object.prototype.hasOwnProperty.call(cur, last)) throw invalid(`unknown field ${formatPointer(parts)} (use --create to add a new key)`);
    cur[last] = value;
  } else throw invalid(`cannot set inside a ${typeof cur} at ${formatPointer(parts.slice(0, -1))}`);
  return root as T;
}

export interface Change {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
  old?: unknown;
}

/** Structural diff, deepest paths first-level granularity for arrays of different lengths. */
export function diffJson(a: unknown, b: unknown, at: Array<string | number> = [], out: Change[] = []): Change[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) {
      if (!(k in b)) out.push({ op: "remove", path: formatPointer([...at, k]), old: a[k] });
      else diffJson(a[k], b[k], [...at, k], out);
    }
    for (const k of Object.keys(b)) if (!(k in a)) out.push({ op: "add", path: formatPointer([...at, k]), value: b[k] });
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) diffJson(a[i], b[i], [...at, i], out);
    return out;
  }
  out.push({ op: "replace", path: formatPointer(at), value: b, old: a });
  return out;
}

/** CLI values: JSON when it parses (numbers, booleans, null, objects, quoted strings), else the raw string. */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
