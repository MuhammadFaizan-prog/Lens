/**
 * Sensitive-text classifiers for OCR'd screen text: the TypeScript port of redact/lens_redact/classify.py
 * (same patterns, same thresholds), so the desktop app needs no Python.
 *
 * Two views of each OCR line are classified: the spaced line text (emails, phones, cards, IPs) and
 * "glued" tokens (neighbouring words OCR split at a tiny gap) for API keys, tokens and JWTs.
 */

export interface Finding {
  type: string;
  start: number;
  end: number;
  text: string;
  confidence: number;
}

export const TYPES = ["email", "phone", "card", "api_key", "token", "jwt", "ip", "notification"] as const;

export function luhnOk(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const c = new Map<string, number>();
  for (const ch of s) c.set(ch, (c.get(ch) ?? 0) + 1);
  let e = 0;
  for (const v of c.values()) e -= (v / s.length) * Math.log2(v / s.length);
  return e;
}

const charClasses = (s: string) => [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(s)).length;

const CARD_IIN = /^(4|5[1-5]|2[2-7]|3[47]|3[0689]|6(?:011|5|4[4-9]|22)|35|62|81)/;

export function cardLike(d: string): boolean {
  return d.length >= 13 && d.length <= 19 && CARD_IIN.test(d) && luhnOk(d) && new Set(d).size > 1;
}

const EMAIL = /(?<![\w.%+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![\w-])/g;
const CARD = /(?<![\d.])\d(?:[ -]?\d){12,18}(?![\d.])/g;
const PHONE = /(?<![\w.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]?\d{3,4}[ .-]?\d{3,4}(?![\w.])|(?<![\w.])\+\d{1,3}(?:[ .-]?\d{2,5}){2,4}(?![\w.])/g;
const IPV4 = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.]|\.\d)/g;
const JWT = /(?<![\w-])eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}/g;
const JWT_PIECE = /(?<![\w-])eyJ[A-Za-z0-9_-]{13,}(?:\.[A-Za-z0-9_-]*)*/g;

const KEY_PREFIXES: RegExp[] = [
  /(?<![\w-])sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /(?<![\w-])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /(?<![\w-])gh[pousr]_[A-Za-z0-9]{30,}/g,
  /(?<![\w-])github_pat_[A-Za-z0-9_]{40,}/g,
  /(?<![A-Z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}(?![A-Z0-9])/g,
  /(?<![\w-])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![\w-])AIza[0-9A-Za-z_-]{35}/g,
  /(?<![\w-])glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![\w-])(?:npm|hf|pypi)_[A-Za-z0-9]{30,}/g,
  /(?<![\w-])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
];

const TOKEN = /[A-Za-z0-9+/_=-]{20,}/g;
const ENTROPY_MIN = 3.5;
const HEX_ONLY = /^[0-9a-fA-F]+$/;

const digitsOf = (s: string) => s.replace(/\D/g, "");

export function isHighEntropyToken(tok: string): boolean {
  const t = tok.replace(/^=+|=+$/g, "");
  if (t.length < 20) return false;
  if (HEX_ONLY.test(t)) return t.length >= 40 && shannonEntropy(t) >= 3.0 && charClasses(t) >= 2;
  if (!(/[0-9]/.test(t) && /[A-Za-z]/.test(t))) return false;
  if (charClasses(t) < 3 && t.length < 32) return false;
  return shannonEntropy(t) >= ENTROPY_MIN;
}

function* matches(rx: RegExp, s: string): Generator<RegExpExecArray> {
  rx.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s))) {
    yield m;
    if (m[0].length === 0) rx.lastIndex++;
  }
}

export function findLine(text: string): Finding[] {
  const out: Finding[] = [];
  const taken: Array<[number, number]> = [];
  const free = (a: number, b: number) => taken.every(([x, y]) => b <= x || a >= y);
  const add = (type: string, m: RegExpExecArray, conf = 1) => {
    out.push({ type, start: m.index, end: m.index + m[0].length, text: m[0], confidence: conf });
    taken.push([m.index, m.index + m[0].length]);
  };
  for (const m of matches(EMAIL, text)) add("email", m);
  for (const m of matches(IPV4, text)) {
    if (free(m.index, m.index + m[0].length) && text.slice(Math.max(0, m.index - 1), m.index).toLowerCase() !== "v") add("ip", m);
  }
  for (const m of matches(CARD, text)) {
    if (free(m.index, m.index + m[0].length) && cardLike(digitsOf(m[0]))) add("card", m);
  }
  for (const m of matches(PHONE, text)) {
    const g = m[0];
    const d = digitsOf(g);
    if (!free(m.index, m.index + g.length) || !(d.length >= 10 && d.length <= 15) || new Set(d).size < 3) continue;
    if (!(g.startsWith("+") || /[ ().-]/.test(g))) continue;
    if (/^\d{4}([ -]\d{4})+$/.test(g) || /^\d{4}-\d{2}-\d{2}$/.test(g)) continue;
    add("phone", m);
  }
  return out;
}

export function findToken(tok: string): Finding[] {
  const out: Finding[] = [];
  const taken: Array<[number, number]> = [];
  const freeOf = (a: number, b: number) => taken.every(([x, y]) => b <= x || a >= y);
  for (const m of matches(JWT, tok)) {
    out.push({ type: "jwt", start: m.index, end: m.index + m[0].length, text: m[0], confidence: 1 });
    taken.push([m.index, m.index + m[0].length]);
  }
  for (const m of matches(JWT_PIECE, tok)) {
    if (freeOf(m.index, m.index + m[0].length)) {
      out.push({ type: "jwt", start: m.index, end: m.index + m[0].length, text: m[0], confidence: 0.8 });
      taken.push([m.index, m.index + m[0].length]);
    }
  }
  for (const rx of KEY_PREFIXES) {
    for (const m of matches(rx, tok)) {
      if (freeOf(m.index, m.index + m[0].length)) {
        out.push({ type: "api_key", start: m.index, end: m.index + m[0].length, text: m[0], confidence: 1 });
        taken.push([m.index, m.index + m[0].length]);
      }
    }
  }
  for (const m of matches(TOKEN, tok)) {
    const a = m.index;
    const b = a + m[0].length;
    if (!freeOf(a, b)) continue;
    if (tok.slice(Math.max(0, a - 1), b + 1).includes("@")) continue;
    if (isHighEntropyToken(m[0])) {
      out.push({ type: "token", start: a, end: b, text: m[0], confidence: 0.7 });
      taken.push([a, b]);
    }
  }
  return out;
}

export function classifyText(text: string): Finding[] {
  const out = findLine(text);
  let pos = 0;
  for (const tok of text.split(" ")) {
    for (const f of findToken(tok)) out.push({ ...f, start: f.start + pos, end: f.end + pos });
    pos += tok.length + 1;
  }
  return out;
}

/** A redacted label for the review list; the full secret is never stored. */
export function maskPreview(raw: string, t: string): string {
  const s = raw.trim();
  if (t === "email" && s.includes("@")) {
    const i = s.indexOf("@");
    const user = s.slice(0, i);
    const dom = s.slice(i + 1);
    const tld = dom.includes(".") ? dom.slice(dom.lastIndexOf(".") + 1) : "";
    return `${user.slice(0, 1)}•••@${dom.slice(0, 1)}•••.${tld}`;
  }
  if (t === "card" || t === "phone") {
    const d = digitsOf(s);
    return t === "card" ? `•••• ${d.slice(-4)}` : `••• ${d.slice(-4)}`;
  }
  if (t === "ip") {
    const parts = s.split(".");
    return parts.length === 4 ? [...parts.slice(0, 2), "•", "•"].join(".") : "•.•.•.•";
  }
  if (s.length <= 8) return s.slice(0, 2) + "•••";
  const head = /^(sk-(?:proj-|ant-|live-|test-)?|(?:sk|rk|pk)_(?:live|test)_|gh[pousr]_|github_pat_|AKIA|ASIA|xox[abprs]-|AIza|glpat-|eyJ)/.exec(s);
  const h = head ? head[0] : s.slice(0, 3);
  return `${h}•••${s.slice(-4)}`;
}
