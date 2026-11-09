"""Sensitive-text classifiers for OCR'd screen text (Lens's own rules, clean-room).

Two views of each OCR line are classified:
  * the spaced line text ("Support line: +1 (415) 555-0132"), for emails, phones, card numbers, IPs;
  * "glued" tokens: neighbouring words joined when OCR split one token at a tiny gap
    ("eyJhb...NiJ9.eyJz...0 .dBj ft JeZ4..."), for API keys, tokens and JWTs.

Each finding is (type, start, end, text) with character offsets into the string it was found in.
Types: email, phone, card, api_key, token, jwt, ip.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

TYPES = ("email", "phone", "card", "api_key", "token", "jwt", "ip", "notification")


@dataclass(frozen=True)
class Finding:
    type: str
    start: int
    end: int
    text: str
    confidence: float = 1.0


# ------------------------------------------------------------------ helpers

def luhn_ok(digits: str) -> bool:
    """Luhn (mod 10) check over a string of digits."""
    if not digits.isdigit() or len(digits) < 2:
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def shannon_entropy(s: str) -> float:
    """Shannon entropy in bits per character."""
    if not s:
        return 0.0
    n = len(s)
    return -sum(c / n * math.log2(c / n) for c in Counter(s).values())


def _char_classes(s: str) -> int:
    return sum(bool(re.search(p, s)) for p in (r"[a-z]", r"[A-Z]", r"[0-9]"))


# Issuer prefixes of payment cards (IIN ranges), checked before Luhn so a random 16-digit reference
# number that happens to pass Luhn (1 in 10) is still unlikely to be flagged.
_CARD_IIN = re.compile(r"^(4|5[1-5]|2[2-7]|3[47]|3[0689]|6(?:011|5|4[4-9]|22)|35|62|81)")


def card_like(digits: str) -> bool:
    return 13 <= len(digits) <= 19 and bool(_CARD_IIN.match(digits)) and luhn_ok(digits) and len(set(digits)) > 1


# ------------------------------------------------------------------ patterns

EMAIL = re.compile(r"(?<![\w.%+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![\w-])")
# digit runs separated by single spaces or dashes (a card is written 4-4-4-4, 4-6-5, ...)
CARD = re.compile(r"(?<![\d.])\d(?:[ -]?\d){12,18}(?![\d.])")
PHONE = re.compile(
    r"(?<![\w.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]?\d{3,4}[ .-]?\d{3,4}(?![\w.])"
    r"|(?<![\w.])\+\d{1,3}(?:[ .-]?\d{2,5}){2,4}(?![\w.])"
)
IPV4 = re.compile(r"(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.]|\.\d)")
JWT = re.compile(r"(?<![\w-])eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}")

# Known key / token prefixes: (regex, min length of the body after the prefix).
KEY_PREFIXES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?<![\w-])sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}"), "openai/anthropic-style sk-"),
    (re.compile(r"(?<![\w-])(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}"), "stripe-style key"),
    (re.compile(r"(?<![\w-])gh[pousr]_[A-Za-z0-9]{30,}"), "github token"),
    (re.compile(r"(?<![\w-])github_pat_[A-Za-z0-9_]{40,}"), "github fine-grained token"),
    (re.compile(r"(?<![A-Z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}(?![A-Z0-9])"), "aws access key id"),
    (re.compile(r"(?<![\w-])xox[abprs]-[A-Za-z0-9-]{10,}"), "slack token"),
    (re.compile(r"(?<![\w-])AIza[0-9A-Za-z_-]{35}"), "google api key"),
    (re.compile(r"(?<![\w-])glpat-[A-Za-z0-9_-]{20,}"), "gitlab token"),
    (re.compile(r"(?<![\w-])(?:npm|hf|pypi)_[A-Za-z0-9]{30,}"), "registry token"),
    (re.compile(r"(?<![\w-])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}"), "sendgrid key"),
]

# Generic high-entropy tokens.
TOKEN = re.compile(r"[A-Za-z0-9+/_=-]{20,}")
ENTROPY_MIN = 3.5  # bits/char; random base62 of length 20-40 measures ~3.9-4.8
HEX_ONLY = re.compile(r"^[0-9a-fA-F]+$")


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s)


def is_high_entropy_token(tok: str) -> bool:
    """A generic secret-looking token: long, mixed letters and digits, high entropy, not a word or a path."""
    t = tok.strip("=")
    if len(t) < 20:
        return False
    if HEX_ONLY.match(t):
        # hex digests (git shas, checksums) are common in normal screens; only long hex counts
        return len(t) >= 40 and shannon_entropy(t) >= 3.0 and _char_classes(t) >= 2
    if not (re.search(r"[0-9]", t) and re.search(r"[A-Za-z]", t)):
        return False
    if _char_classes(t) < 3 and len(t) < 32:
        return False
    return shannon_entropy(t) >= ENTROPY_MIN


def find_line(text: str) -> list[Finding]:
    """Emails, phones, cards and IPs in a spaced OCR line."""
    out: list[Finding] = []
    taken: list[tuple[int, int]] = []

    def free(a: int, b: int) -> bool:
        return all(b <= x or a >= y for x, y in taken)

    for m in EMAIL.finditer(text):
        out.append(Finding("email", m.start(), m.end(), m.group()))
        taken.append(m.span())
    for m in IPV4.finditer(text):
        if free(*m.span()) and not text[max(0, m.start() - 1):m.start()].lower() == "v":
            out.append(Finding("ip", m.start(), m.end(), m.group()))
            taken.append(m.span())
    for m in CARD.finditer(text):
        d = _digits(m.group())
        if free(*m.span()) and card_like(d):
            out.append(Finding("card", m.start(), m.end(), m.group()))
            taken.append(m.span())
    for m in PHONE.finditer(text):
        g = m.group()
        d = _digits(g)
        if not free(*m.span()) or not (10 <= len(d) <= 15) or len(set(d)) < 3:
            continue
        # a phone number has separators or a leading +; a bare 10-15 digit run is an id, not a phone
        if not (g.startswith("+") or re.search(r"[ ().-]", g)):
            continue
        # dates and plain digit groups of 4 ("1234 5678 9012") are not phones
        if re.fullmatch(r"\d{4}([ -]\d{4})+", g) or re.fullmatch(r"\d{4}-\d{2}-\d{2}", g):
            continue
        out.append(Finding("phone", m.start(), m.end(), g))
        taken.append(m.span())
    return out


def find_token(tok: str) -> list[Finding]:
    """API keys, JWTs and high-entropy tokens inside one glued token (no spaces)."""
    out: list[Finding] = []
    taken: list[tuple[int, int]] = []
    for m in JWT.finditer(tok):
        out.append(Finding("jwt", m.start(), m.end(), m.group()))
        taken.append(m.span())
    # a piece of a JWT: base64url of '{"' always starts eyJ; OCR often splits the token at its dots
    for m in re.finditer(r"(?<![\w-])eyJ[A-Za-z0-9_-]{13,}(?:\.[A-Za-z0-9_-]*)*", tok):
        if all(m.end() <= a or m.start() >= b for a, b in taken):
            out.append(Finding("jwt", m.start(), m.end(), m.group(), 0.8))
            taken.append(m.span())
    for rx, _name in KEY_PREFIXES:
        for m in rx.finditer(tok):
            if all(m.end() <= a or m.start() >= b for a, b in taken):
                out.append(Finding("api_key", m.start(), m.end(), m.group()))
                taken.append(m.span())
    for m in TOKEN.finditer(tok):
        if any(not (m.end() <= a or m.start() >= b) for a, b in taken):
            continue
        if "@" in tok[max(0, m.start() - 1):m.end() + 1]:
            continue
        if is_high_entropy_token(m.group()):
            out.append(Finding("token", m.start(), m.end(), m.group(), 0.7))
            taken.append(m.span())
    return out


def classify_text(text: str) -> list[Finding]:
    """Convenience for tests: line findings plus token findings of each space-separated token."""
    out = find_line(text)
    pos = 0
    for tok in text.split(" "):
        for f in find_token(tok):
            out.append(Finding(f.type, f.start + pos, f.end + pos, f.text, f.confidence))
        pos += len(tok) + 1
    return out


def mask_preview(s: str, t: str) -> str:
    """A redacted label for the review list; the full secret is never stored."""
    s = s.strip()
    if t == "email" and "@" in s:
        user, dom = s.split("@", 1)
        tld = dom.rsplit(".", 1)[-1] if "." in dom else ""
        return f"{user[:1]}•••@{dom[:1]}•••.{tld}"
    if t in ("card", "phone"):
        d = _digits(s)
        return f"•••• {d[-4:]}" if t == "card" else f"••• {d[-4:]}"
    if t == "ip":
        parts = s.split(".")
        return ".".join(parts[:2] + ["•", "•"]) if len(parts) == 4 else "•.•.•.•"
    if len(s) <= 8:
        return s[:2] + "•••"
    head = re.match(r"^(sk-(?:proj-|ant-|live-|test-)?|(?:sk|rk|pk)_(?:live|test)_|gh[pousr]_|github_pat_|AKIA|ASIA|xox[abprs]-|AIza|glpat-|eyJ)", s)
    h = head.group() if head else s[:3]
    return f"{h}•••{s[-4:]}"
