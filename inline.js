// inline.js — inline (span-level) parsing for markdown-render-speed-02.
// A dependency-free ES module implementing marked 18.1.3's inline parsing
// exactly, as the practice reference outputs show.
//
// API (used by the block parser, blocks.js / parse.js):
//   parseInline(text, ctx) -> HTML string
//     Renders one inline span of text (paragraph content, heading text,
//     table cell content, ...). `text` is the raw inline source as marked's
//     block layer provides it: line endings already normalised to "\n" and
//     any single trailing "\n" stripped (parseInline also strips one
//     trailing "\n" defensively). `ctx` is optional; when omitted an empty
//     link-definition map is used.
//   createContext(links) -> ctx
//     Builds the context object from a link-definition map. `links` may be
//     a Map or a plain object whose keys are NORMALISED labels (see
//     normalizeLabel) and whose values are { href, title } (title may be
//     null/undefined). The block layer MUST key its definitions with
//     normalizeLabel(label) and MUST collect every definition in the
//     document (definitions may appear after their use) before rendering.
//   normalizeLabel(label) -> string
//     Normalises a link label for definition lookup: lowercase, collapse
//     every run of whitespace to one space, trim. Used by the block layer
//     when storing link reference definitions and by parseInline when
//     looking them up, so both sides must use this exact function.
//
// Behaviour notes (marked 18.1.3, verified against the practice set):
//   - Hard breaks ("  \n" and "\\\n") render as "<br>" with the newline
//     consumed; a lone trailing space before a soft break is dropped.
//   - Text escapes " < > ' as &quot; &lt; &gt; &#39;; a bare & becomes
//     &amp; unless it starts an entity-like "&word;" (left as-is) or a
//     valid numeric reference "&#...;" / "&#x...;" (decoded to the
//     character, 0 and surrogates -> U+FFFD, out of range -> &amp;).
//   - Code span content is escaped fully (& < > " ' all encoded).
//   - Emphasis/strong use CommonMark flanking rules and the delimiter
//     stack (Appendix A); strikethrough needs 1-2 tildes on both sides
//     with equal length (~~~...~~~ is literal text).
//   - A link cannot contain another "["-link: if a link label's parsed
//     content already holds a link, the outer link does not form (an
//     image's alt text may hold one; the alt is the rendered text with
//     tags stripped). What follows a "]" decides the kind: "(" tries an
//     inline link, "[" a full/collapsed reference, anything else a
//     shortcut; a failed inline/reference attempt does not fall back
//     to a shortcut.

const ASCII_PUNCT = new Uint8Array(128);
for (const c of "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~") ASCII_PUNCT[c.charCodeAt(0)] = 1;

const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const NEED_ESCAPE = /[&<>"']/;
const NEED_ENCODE = /[&<>"']/;

function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13
    || c === 133 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202)
    || c === 8232 || c === 8233 || c === 8239 || c === 8287
    || c === 12288 || c === 65279;
}

function isPunctCode(c) {
  if (c < 128) return ASCII_PUNCT[c] === 1;
  return UNICODE_PUNCT.test(String.fromCodePoint(c));
}

function isAsciiPunctCode(c) {
  return c < 128 && ASCII_PUNCT[c] === 1;
}

function isWordCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90)
    || (c >= 97 && c <= 122) || c === 95;
}

// Escape one decoded character for HTML text output.
function escapeDecodedChar(ch) {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '"') return '&quot;';
  if (ch === "'") return '&#39;';
  return ch;
}

// Try to read an entity starting at s[k] == '&'. Returns [totalLength,
// replacementText] or null when the '&' is not part of an entity.
// Numeric references are decoded (0 / surrogates -> U+FFFD); named
// references are passed through unchanged.
function readEntity(s, k, end) {
  if (k + 1 >= end) return null;
  let j = k + 1;
  if (s.charCodeAt(j) === 35) { // '#'
    j++;
    let hex = false;
    if (j < end && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { // x X
      hex = true;
      j++;
    }
    const d0 = j;
    let v = 0;
    const maxDigits = hex ? 6 : 7;
    while (j < end && j - d0 < maxDigits) {
      const c = s.charCodeAt(j);
      let d = -1;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (hex && c >= 97 && c <= 102) d = c - 87;
      else if (hex && c >= 65 && c <= 70) d = c - 55;
      if (d < 0) break;
      v = v * (hex ? 16 : 10) + d;
      j++;
    }
    if (j === d0 || j >= end || s.charCodeAt(j) !== 59) return null; // need ';'
    if (v > 0x10FFFF) return null;
    if (v === 0 || (v >= 0xD800 && v <= 0xDFFF)) v = 0xFFFD;
    return [j + 1 - k, escapeDecodedChar(String.fromCodePoint(v))];
  }
  const w0 = j;
  while (j < end && isWordCode(s.charCodeAt(j))) j++;
  if (j === w0 || j >= end || s.charCodeAt(j) !== 59) return null;
  return [j + 1 - k, s.slice(k, j + 1)];
}

// Escape HTML text: & < > " ' encoded, except '&' starting an entity-like
// sequence "&word;" (kept) or a valid numeric reference (decoded).
export function escapeText(s, a, b) {
  if (a === undefined) { a = 0; b = s.length; }
  const sub = s.slice(a, b);
  if (!NEED_ESCAPE.test(sub)) return sub;
  const out = [];
  let last = a;
  for (let k = a; k < b; k++) {
    const c = s.charCodeAt(k);
    if (c === 38) { // &
      const ent = readEntity(s, k, b);
      if (ent) {
        out.push(s.slice(last, k), ent[1]);
        k += ent[0] - 1;
        last = k + 1;
        continue;
      }
      out.push(s.slice(last, k), '&amp;');
      last = k + 1;
    } else if (c === 60) {
      out.push(s.slice(last, k), '&lt;'); last = k + 1;
    } else if (c === 62) {
      out.push(s.slice(last, k), '&gt;'); last = k + 1;
    } else if (c === 34) {
      out.push(s.slice(last, k), '&quot;'); last = k + 1;
    } else if (c === 39) {
      out.push(s.slice(last, k), '&#39;'); last = k + 1;
    }
  }
  out.push(s.slice(last, b));
  return out.join('');
}

// Escape with every & encoded (code spans, attribute values built from
// already-decoded text). No entity pass-through.
export function escapeEncode(s) {
  if (!NEED_ENCODE.test(s)) return s;
  const out = [];
  let last = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 38) { out.push(s.slice(last, k), '&amp;'); last = k + 1; }
    else if (c === 60) { out.push(s.slice(last, k), '&lt;'); last = k + 1; }
    else if (c === 62) { out.push(s.slice(last, k), '&gt;'); last = k + 1; }
    else if (c === 34) { out.push(s.slice(last, k), '&quot;'); last = k + 1; }
    else if (c === 39) { out.push(s.slice(last, k), '&#39;'); last = k + 1; }
  }
  out.push(s.slice(last));
  return out.join('');
}

// marked's cleanUrl: percent-encode, keep literal '%' (undo %25), null on
// malformed input (lone surrogate).
export function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

export function normalizeLabel(label) {
  const s = label.toLowerCase().replace(/\s+/g, ' ').trim();
  // Full case folding for characters toLowerCase() does not fold
  // (sharp s, final sigma, ligatures), as CommonMark requires.
  return s.replace(/[ßςﬀﬁﬂﬃﬄﬅﬆ]/g, (ch) => CASE_FOLD_EXTRA[ch]);
}

const CASE_FOLD_EXTRA = {
  'ß': 'ss', 'ς': 'σ', 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl',
  'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st',
};

export function parseInline(text, ctx) {
  let src = text;
  if (src.indexOf('\r') !== -1) src = src.replace(/\r\n?/g, '\n');
  if (src.charCodeAt(src.length - 1) === 10) src = src.slice(0, -1);
  const links = ctx && ctx.links ? ctx.links : null;
  const tokens = tokenize(src, links);
  resolveEmphasis(tokens);
  return renderTokens(tokens);
}

function flushText(src, tokens, start, end) {
  if (end > start) tokens.push({ t: 0, s: escapeText(src, start, end) });
}

// Token kinds: 0 text {s} | 1 code {s} | 2 html {s} | 3 br
// 4 link {href,title,c} | 5 image {href,title,c} | 6 em {c} | 7 strong {c}
// 8 del {c} | 9 delimiter {ch,len,open,close,dead}
function tokenize(src, links) {
  const n = src.length;
  const tokens = [];
  const brackets = []; // {img, tok, bang, src}
  let i = 0;
  let textStart = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) { // backslash
      if (i + 1 < n) {
        const nc = src.charCodeAt(i + 1);
        if (isAsciiPunctCode(nc)) {
          flushText(src, tokens, textStart, i);
          tokens.push({ t: 0, s: escapeDecodedChar(String.fromCharCode(nc)) });
          i += 2; textStart = i; continue;
        }
        if (nc === 10) {
          let k = i + 2;
          while (k < n && isSpaceCode(src.charCodeAt(k))) k++;
          if (k < n) {
            flushText(src, tokens, textStart, i);
            tokens.push({ t: 3 });
            i += 2;
            while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
            textStart = i; continue;
          }
        }
      }
      i++;
    } else if (c === 96) { // backtick: code span
      const end = tryCodeSpan(src, i, tokens);
      if (end >= 0) {
        const tok = tokens.pop();
        flushText(src, tokens, textStart, i);
        tokens.push(tok);
        i = end; textStart = i; continue;
      }
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      i = j;
    } else if (c === 42 || c === 95) { // * _
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const len = j - i;
      const prev = i > 0 ? src.charCodeAt(i - 1) : 32;
      const next = j < n ? src.charCodeAt(j) : 32;
      const prevSpace = isSpaceCode(prev);
      const nextSpace = isSpaceCode(next);
      const prevPunct = isPunctCode(prev);
      const nextPunct = isPunctCode(next);
      const leftFlank = !nextSpace && (!nextPunct || prevSpace || prevPunct);
      const rightFlank = !prevSpace && (!prevPunct || nextSpace || nextPunct);
      let open, close;
      if (c === 42) { open = leftFlank; close = rightFlank; }
      else {
        open = leftFlank && (!rightFlank || prevPunct);
        close = rightFlank && (!leftFlank || nextPunct);
      }
      flushText(src, tokens, textStart, i);
      tokens.push({ t: 9, ch: c === 42 ? '*' : '_', len, open, close, dead: false });
      i = j; textStart = i;
    } else if (c === 91) { // [
      flushText(src, tokens, textStart, i);
      tokens.push({ t: 0, s: '[' });
      brackets.push({ img: false, tok: tokens.length - 1, bang: -1, src: i });
      i++; textStart = i;
    } else if (c === 93) { // ]
      if (brackets.length > 0) {
        flushText(src, tokens, textStart, i);
        textStart = i;
        const end = handleCloseBracket(src, i, tokens, brackets, links);
        if (end >= 0) { i = end; textStart = i; continue; }
      }
      i++;
    } else if (c === 33) { // !
      if (i + 1 < n && src.charCodeAt(i + 1) === 91) {
        flushText(src, tokens, textStart, i);
        tokens.push({ t: 0, s: '!' });
        tokens.push({ t: 0, s: '[' });
        brackets.push({ img: true, tok: tokens.length - 1, bang: tokens.length - 2, src: i + 1 });
        i += 2; textStart = i; continue;
      }
      i++;
    } else if (c === 60) { // <
      const end = tryAutolinkOrHtml(src, i, tokens);
      if (end >= 0) {
        const tok = tokens.pop();
        flushText(src, tokens, textStart, i);
        tokens.push(tok);
        i = end; textStart = i; continue;
      }
      i++;
    } else if (c === 126) { // ~
      let j = i;
      while (j < n && src.charCodeAt(j) === 126) j++;
      const len = j - i;
      const prev = i > 0 ? src.charCodeAt(i - 1) : 32;
      const next = j < n ? src.charCodeAt(j) : 32;
      const leftFlank = !isSpaceCode(next) && (!isPunctCode(next) || isSpaceCode(prev) || isPunctCode(prev));
      const rightFlank = !isSpaceCode(prev) && (!isPunctCode(prev) || isSpaceCode(next) || isPunctCode(next));
      flushText(src, tokens, textStart, i);
      tokens.push({ t: 9, ch: '~', len, open: leftFlank, close: rightFlank, dead: false });
      i = j; textStart = i;
    } else if (c === 10) { // newline: hard / soft break
      let sp = 0;
      for (let k = i - 1; k >= textStart && src.charCodeAt(k) === 32; k--) sp++;
      let k = i + 1;
      while (k < n && isSpaceCode(src.charCodeAt(k))) k++;
      if (k >= n) { i++; continue; }
      if (sp >= 2) {
        flushText(src, tokens, textStart, i - sp);
        tokens.push({ t: 3 });
        i++;
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
      } else {
        flushText(src, tokens, textStart, i);
        tokens.push({ t: 0, s: '\n' });
        i++;
      }
      textStart = i;
    } else if (c === 58) { // : scheme autolink?
      const end = trySchemeAutolink(src, i, textStart, tokens);
      if (end >= 0) { i = end; textStart = i; continue; }
      i++;
    } else if (c === 64) { // @ email autolink?
      const end = tryEmailAutolink(src, i, textStart, tokens);
      if (end >= 0) { i = end; textStart = i; continue; }
      i++;
    } else if (c === 119 || c === 87 || c === 104 || c === 72) { // w W h H
      const end = tryExtUrl(src, i, tokens);
      if (end >= 0) {
        const tok = tokens.pop();
        flushText(src, tokens, textStart, i);
        tokens.push(tok);
        i = end; textStart = i; continue;
      }
      i++;
    } else {
      i++;
    }
  }
  flushText(src, tokens, textStart, n);
  return tokens;
}

export function createContext(links) {
  return { links: links || null };
}

// ---- code spans ----
function tryCodeSpan(src, i, tokens) {
  const n = src.length;
  let j = i;
  while (j < n && src.charCodeAt(j) === 96) j++;
  const run = j - i;
  let k = j;
  while (k < n) {
    if (src.charCodeAt(k) === 96) {
      let m = k;
      while (m < n && src.charCodeAt(m) === 96) m++;
      if (m - k === run) {
        let content = src.slice(j, k);
        if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32
          && content.charCodeAt(content.length - 1) === 32) {
          let nonSpace = false;
          for (let q = 1; q < content.length - 1; q++) {
            if (content.charCodeAt(q) !== 32) { nonSpace = true; break; }
          }
          if (nonSpace) content = content.slice(1, -1);
        }
        tokens.push({ t: 1, s: escapeEncode(content) });
        return m;
      }
      k = m;
    } else k++;
  }
  return -1;
}

// Resolve backslash escapes in a link destination / title: \ + ASCII
// punctuation -> the punctuation; anything else stays as-is.
function unescapeLinkText(s) {
  if (s.indexOf('\\') === -1) return s;
  const out = [];
  let last = 0;
  for (let k = 0; k < s.length; k++) {
    if (s.charCodeAt(k) === 92 && k + 1 < s.length
      && isAsciiPunctCode(s.charCodeAt(k + 1))) {
      out.push(s.slice(last, k), s[k + 1]);
      k++;
      last = k + 1;
    }
  }
  out.push(s.slice(last));
  return out.join('');
}

function skipWs(src, i, n) {
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Parse an inline link "(...)" starting at src[i] == '('.
// Returns { href, title, end } (end = index just past ')') or null.
function parseInlineLink(src, i) {
  const n = src.length;
  let p = skipWs(src, i + 1, n);
  let href = '';
  if (p < n && src.charCodeAt(p) === 60) { // <dest>
    let q = p + 1;
    let ok = false;
    while (q < n) {
      const c = src.charCodeAt(q);
      if (c === 92 && q + 1 < n) { q += 2; continue; }
      if (c === 62) { ok = true; break; }
      if (c === 60 || c === 10) return null;
      q++;
    }
    if (!ok) return null;
    href = unescapeLinkText(src.slice(p + 1, q));
    p = q + 1;
  } else {
    let q = p;
    let depth = 0;
    while (q < n) {
      const c = src.charCodeAt(q);
      if (c === 92 && q + 1 < n) { q += 2; continue; }
      if (c === 32 || c === 9 || c === 10) break;
      if (c === 40) { depth++; q++; continue; }
      if (c === 41) { if (depth === 0) break; depth--; q++; continue; }
      q++;
    }
    href = unescapeLinkText(src.slice(p, q));
    p = q;
  }
  p = skipWs(src, p, n);
  let title = null;
  if (p < n) {
    const tc = src.charCodeAt(p);
    if (tc === 34 || tc === 39 || tc === 40) {
      const close = tc === 40 ? 41 : tc;
      let q = p + 1;
      let ok = false;
      while (q < n) {
        const c = src.charCodeAt(q);
        if (c === 92 && q + 1 < n) { q += 2; continue; }
        if (c === close) { ok = true; break; }
        if (tc === 40 && c === 40) return null;
        q++;
      }
      if (!ok) return null;
      title = unescapeLinkText(src.slice(p + 1, q));
      p = q + 1;
    }
  }
  p = skipWs(src, p, n);
  if (p >= n || src.charCodeAt(p) !== 41) return null;
  return { href, title, end: p + 1 };
}

function lookupLink(links, label) {
  if (!links) return null;
  const key = normalizeLabel(label);
  if (links instanceof Map) {
    const v = links.get(key);
    return v || null;
  }
  const v = links[key];
  return v || null;
}

// Parse a reference label "[...]" starting at src[i] == '['. Returns
// { label, end } (end just past ']') or null. The label may not contain
// an unescaped '[' or ']'.
function parseRefLabel(src, i) {
  const n = src.length;
  let q = i + 1;
  while (q < n) {
    const c = src.charCodeAt(q);
    if (c === 92 && q + 1 < n) { q += 2; continue; }
    if (c === 93) return { label: src.slice(i + 1, q), end: q + 1 };
    if (c === 91) return null;
    q++;
  }
  return null;
}

// Handle a ']' at src[i]. Returns the index just past the formed link,
// or -1 when no link forms (the ']' stays literal text and the opener
// is dropped from the bracket stack).
function handleCloseBracket(src, i, tokens, brackets, links) {
  if (brackets.length === 0) return -1;
  const br = brackets[brackets.length - 1];
  const labelRaw = src.slice(br.src + 1, i);
  const content = tokens.slice(br.tok + 1);
  // A link cannot contain another "["-link (an image's alt text may).
  if (!br.img) {
    for (const t of content) {
      if (t.t === 4) { brackets.pop(); return -1; }
    }
  }
  let href = null;
  let title = null;
  let end = -1;
  const next = i + 1 < src.length ? src.charCodeAt(i + 1) : -1;
  if (next === 40) { // inline link: a failed parse falls back to shortcut
    const parsed = parseInlineLink(src, i + 1);
    if (parsed) { href = parsed.href; title = parsed.title; end = parsed.end; }
  } else if (next === 91) { // full / collapsed reference
    const ref = parseRefLabel(src, i + 1);
    if (ref) {
      const def = lookupLink(links, ref.label === '' ? labelRaw : ref.label);
      if (def) { href = def.href; title = def.title || null; end = ref.end; }
      else { brackets.pop(); return -1; }
    }
    // No valid second label: fall through to the shortcut attempt.
  }
  if (end < 0) { // shortcut reference
    const def = lookupLink(links, labelRaw);
    if (def) { href = def.href; title = def.title || null; end = i + 1; }
  }
  if (end < 0) {
    brackets.pop();
    return -1;
  }
  const startTok = br.bang >= 0 ? br.bang : br.tok;
  tokens.splice(startTok, tokens.length - startTok,
    br.img ? { t: 5, href, title, c: content } : { t: 4, href, title, c: content });
  brackets.pop();
  return end;
}

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isLocalChar(c) {
  return isAlnumCode(c) || c === 46 || c === 33 || c === 35 || c === 36
    || c === 37 || c === 38 || c === 39 || c === 42 || c === 43 || c === 47
    || c === 61 || c === 63 || c === 94 || c === 95 || c === 96
    || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

// Match an email domain starting at src[i]. Returns the end index or -1.
// The domain is labels of [A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])? joined
// by '.', never ending in '-' or '.'. If needDot, a '.' is required.
function matchEmailDomain(src, i, needDot) {
  const n = src.length;
  let j = i;
  let seenDot = false;
  for (;;) {
    if (j >= n || !isAlnumCode(src.charCodeAt(j))) return -1;
    j++;
    let lastAlnum = j;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (isAlnumCode(c)) { j++; lastAlnum = j; }
      else if (c === 45) j++;
      else break;
    }
    if (lastAlnum !== j) return -1;
    if (j < n && src.charCodeAt(j) === 46
      && j + 1 < n && isAlnumCode(src.charCodeAt(j + 1))) {
      seenDot = true;
      j++;
      continue;
    }
    break;
  }
  if (needDot && !seenDot) return -1;
  return j;
}

// ---- autolinks and inline HTML ----
function tryAutolinkOrHtml(src, i, tokens) {
  const end = tryAngleAutolink(src, i, tokens);
  if (end >= 0) return end;
  return tryHtmlTag(src, i, tokens);
}

function tryAngleAutolink(src, i, tokens) {
  const n = src.length;
  let j = i + 1;
  if (j < n) {
    const c0 = src.charCodeAt(j);
    if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
      let k = j + 1;
      while (k < n) {
        const c = src.charCodeAt(k);
        if (isAlnumCode(c) || c === 43 || c === 45 || c === 46) k++;
        else break;
      }
      if (k - j >= 2 && k - j <= 32 && k < n && src.charCodeAt(k) === 58) {
        let m = k + 1;
        while (m < n) {
          const c = src.charCodeAt(m);
          if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62) break;
          m++;
        }
        if (m < n && src.charCodeAt(m) === 62) {
          const text = src.slice(i + 1, m);
          tokens.push({ t: 4, href: text, title: null, c: [{ t: 0, s: escapeText(text) }] });
          return m + 1;
        }
      }
    }
  }
  const em = matchAngleEmail(src, i);
  if (em >= 0) {
    const text = src.slice(i + 1, em);
    tokens.push({ t: 4, href: 'mailto:' + text, title: null, c: [{ t: 0, s: escapeText(text) }] });
    return em + 1;
  }
  return -1;
}

function matchAngleEmail(src, i) {
  const n = src.length;
  let j = i + 1;
  const l0 = j;
  while (j < n && isLocalChar(src.charCodeAt(j))) j++;
  if (j === l0 || j >= n || src.charCodeAt(j) !== 64) return -1;
  j++;
  const d = matchEmailDomain(src, j, false);
  if (d < 0) return -1;
  if (d >= n || src.charCodeAt(d) !== 62) return -1;
  return d;
}

// Inline HTML (CommonMark 6.8): comment, processing instruction,
// declaration, CDATA, open tag, closing tag. Returns the end index or -1.
function tryHtmlTag(src, i, tokens) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    if (src.charCodeAt(i + 4) === 62) { // <!-->
      tokens.push({ t: 2, s: src.slice(i, i + 5) });
      return i + 5;
    }
    if (src.startsWith('<!--->', i)) {
      tokens.push({ t: 2, s: src.slice(i, i + 6) });
      return i + 6;
    }
    const j = src.indexOf('-->', i + 4);
    const end = j === -1 ? n : j + 3;
    tokens.push({ t: 2, s: src.slice(i, end) });
    return end;
  }
  if (src.startsWith('<?', i)) {
    const j = src.indexOf('?>', i + 2);
    const end = j === -1 ? n : j + 2;
    tokens.push({ t: 2, s: src.slice(i, end) });
    return end;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const j = src.indexOf(']]>', i + 9);
    const end = j === -1 ? n : j + 3;
    tokens.push({ t: 2, s: src.slice(i, end) });
    return end;
  }
  if (src.startsWith('<!', i) && i + 2 < n) {
    const c = src.charCodeAt(i + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      let j = i + 2;
      while (j < n && src.charCodeAt(j) !== 62) j++;
      const end = j < n ? j + 1 : n;
      tokens.push({ t: 2, s: src.slice(i, end) });
      return end;
    }
  }
  let j = i + 1;
  let closing = false;
  if (j < n && src.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n) return -1;
  let c = src.charCodeAt(j);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return -1;
  j++;
  while (j < n) {
    c = src.charCodeAt(j);
    if (isAlnumCode(c) || c === 45) j++;
    else break;
  }
  if (!closing) {
    for (;;) {
      let k = j;
      while (k < n && isTagWs(src.charCodeAt(k))) k++;
      const hadWs = k > j;
      if (k >= n) return -1;
      const d = src.charCodeAt(k);
      if (d === 62) { j = k; break; }
      if (d === 47) {
        if (k + 1 < n && src.charCodeAt(k + 1) === 62) { j = k + 1; break; }
        return -1;
      }
      if (!hadWs) return -1;
      if (!((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95 || d === 58)) return -1;
      k++;
      while (k < n) {
        const e = src.charCodeAt(k);
        if (isAlnumCode(e) || e === 95 || e === 58 || e === 46 || e === 45) k++;
        else break;
      }
      let m = k;
      while (m < n && isTagWs(src.charCodeAt(m))) m++;
      if (m < n && src.charCodeAt(m) === 61) {
        m++;
        while (m < n && isTagWs(src.charCodeAt(m))) m++;
        if (m >= n) return -1;
        const q = src.charCodeAt(m);
        if (q === 34 || q === 39) {
          m++;
          while (m < n && src.charCodeAt(m) !== q) m++;
          if (m >= n) return -1;
          m++;
        } else {
          const u = src.charCodeAt(m);
          if (u === 34 || u === 39 || u === 61 || u === 60 || u === 62 || u === 96) return -1;
          while (m < n) {
            const e = src.charCodeAt(m);
            if (isTagWs(e) || e === 34 || e === 39 || e === 61 || e === 60 || e === 62 || e === 96) break;
            m++;
          }
        }
        k = m;
      }
      j = k;
    }
  } else {
    while (j < n && isTagWs(src.charCodeAt(j))) j++;
    if (j >= n || src.charCodeAt(j) !== 62) return -1;
  }
  const end = j + 1;
  tokens.push({ t: 2, s: src.slice(i, end) });
  return end;
}

function isTagWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

// ---- extended autolinks (GFM) ----
const TRAIL_PUNCT = new Set([63, 33, 46, 44, 58, 42, 95, 126, 39, 34]);

function trimExtUrl(s) {
  let end = s.length;
  for (;;) {
    const before = end;
    if (end > 0 && s.charCodeAt(end - 1) === 59) {
      let a = end - 2;
      let w = 0;
      while (a >= 0 && isWordCode(s.charCodeAt(a))) { a--; w++; }
      if (w > 0) {
        if (a >= 0 && s.charCodeAt(a) === 35) a--;
        if (a >= 0 && s.charCodeAt(a) === 38) end = a;
      }
    }
    while (end > 0 && TRAIL_PUNCT.has(s.charCodeAt(end - 1))) end--;
    let open = 0;
    let close = 0;
    for (let k = 0; k < end; k++) {
      if (s.charCodeAt(k) === 40) open++;
      else if (s.charCodeAt(k) === 41) close++;
    }
    while (end > 0 && s.charCodeAt(end - 1) === 41 && close > open) { end--; close--; }
    if (end === before) break;
  }
  return s.slice(0, end);
}

function validWwwDomain(text) {
  let end = text.length;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (c === 47 || c === 63 || c === 35 || c === 58) { end = k; break; }
  }
  const dom = text.slice(0, end);
  if (dom.indexOf('.', 4) === -1) return false;
  return matchEmailDomain(dom, 0, true) === dom.length;
}

function tryExtUrl(src, i, tokens) {
  const n = src.length;
  if (i > 0) {
    const prev = src.charCodeAt(i - 1);
    if (isAlnumCode(prev) || prev === 95) return -1;
  }
  let isWww = false;
  let schemeLen = 0;
  if ((src.charCodeAt(i) === 119 || src.charCodeAt(i) === 87)
    && i + 3 < n
    && (src.charCodeAt(i + 1) === 119 || src.charCodeAt(i + 1) === 87)
    && (src.charCodeAt(i + 2) === 119 || src.charCodeAt(i + 2) === 87)
    && src.charCodeAt(i + 3) === 46) {
    isWww = true;
  } else if (src.charCodeAt(i) === 104 || src.charCodeAt(i) === 72) {
    const lc = (k) => src.charCodeAt(k) | 32;
    if (lc(i + 1) !== 116 || lc(i + 2) !== 116 || lc(i + 3) !== 112) return -1;
    let k = i + 4;
    if (lc(k) === 115) k++;
    if (src.charCodeAt(k) !== 58 || src.charCodeAt(k + 1) !== 47
      || src.charCodeAt(k + 2) !== 47) return -1;
    schemeLen = k + 3 - i;
  } else {
    return -1;
  }
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60) break;
    j++;
  }
  const text = trimExtUrl(src.slice(i, j));
  if (text.length === 0) return -1;
  if (isWww) {
    if (!validWwwDomain(text)) return -1;
    tokens.push({ t: 4, href: 'http://' + text, title: null, c: [{ t: 0, s: escapeText(text) }] });
  } else {
    if (text.length <= schemeLen) return -1;
    tokens.push({ t: 4, href: text, title: null, c: [{ t: 0, s: escapeText(text) }] });
  }
  return i + text.length;
}

function tryEmailAutolink(src, i, textStart, tokens) {
  let L = i;
  while (L > textStart && isLocalChar(src.charCodeAt(L - 1))) L--;
  if (L === i) return -1;
  if (L === textStart && textStart > 0 && isLocalChar(src.charCodeAt(textStart - 1))) return -1;
  const d = matchEmailDomain(src, i + 1, true);
  if (d < 0) return -1;
  if (d < src.length) {
    const c = src.charCodeAt(d);
    if (isAlnumCode(c) || c === 45 || c === 95) return -1;
  }
  const email = src.slice(L, d);
  flushText(src, tokens, textStart, L);
  tokens.push({ t: 4, href: 'mailto:' + email, title: null, c: [{ t: 0, s: escapeText(email) }] });
  return d;
}

function trySchemeAutolink(src, i, textStart, tokens) {
  const n = src.length;
  let S = i;
  while (S > textStart) {
    const c = src.charCodeAt(S - 1);
    if (isAlnumCode(c) || c === 43 || c === 45 || c === 46) S--;
    else break;
  }
  if (S === textStart && textStart > 0) {
    const c = src.charCodeAt(textStart - 1);
    if (isAlnumCode(c) || c === 43 || c === 45 || c === 46) return -1;
  }
  const len = i - S;
  if (len < 2 || len > 32) return -1;
  const c0 = src.charCodeAt(S);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  if (S > 0) {
    const prev = src.charCodeAt(S - 1);
    if (isAlnumCode(prev) || prev === 95) return -1;
  }
  let j = i + 1;
  const l0 = j;
  while (j < n && isLocalChar(src.charCodeAt(j))) j++;
  if (j === l0 || j >= n || src.charCodeAt(j) !== 64) return -1;
  j++;
  const d = matchEmailDomain(src, j, true);
  if (d < 0) return -1;
  let end = d;
  if (d < n && src.charCodeAt(d) === 47) {
    let m = d + 1;
    while (m < n) {
      const c = src.charCodeAt(m);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 60 || c === 62 || c === 47) break;
      m++;
    }
    if (m > d + 1) end = m;
  } else if (d < n) {
    const c = src.charCodeAt(d);
    if (isAlnumCode(c) || c === 45 || c === 95) return -1;
  }
  const text = src.slice(S, end);
  flushText(src, tokens, textStart, S);
  tokens.push({ t: 4, href: text, title: null, c: [{ t: 0, s: escapeText(text) }] });
  return end;
}

// ---- emphasis / strikethrough resolution (CommonMark Appendix A) ----
function resolveEmphasis(tokens) {
  for (const tok of tokens) {
    if ((tok.t === 4 || tok.t === 5) && tok.c) resolveEmphasis(tok.c);
  }
  const delims = [];
  for (const tok of tokens) {
    if (tok.t === 9 && tok.len > 0 && !tok.dead) delims.push(tok);
  }
  if (delims.length === 0) return;
  for (const closer of delims) {
    if (closer.len === 0 || closer.dead || !closer.close) continue;
    while (closer.len > 0 && !closer.dead && closer.close) {
      const opener = findOpener(delims, closer);
      if (!opener) break;
      const use = opener.ch === '~' ? opener.len
        : (opener.len >= 2 && closer.len >= 2 ? 2 : 1);
      const oi = tokens.indexOf(opener);
      const ci = tokens.indexOf(closer);
      if (oi < 0 || ci < 0 || ci <= oi) break;
      const children = tokens.slice(oi + 1, ci);
      for (const d of children) if (d.t === 9) d.dead = true;
      const node = { t: opener.ch === '~' ? 8 : (use === 2 ? 7 : 6), c: children };
      opener.len -= use;
      closer.len -= use;
      const rep = [];
      if (opener.len > 0) rep.push(opener);
      rep.push(node);
      if (closer.len > 0) rep.push(closer);
      tokens.splice(oi, ci - oi + 1, ...rep);
    }
  }
}

function findOpener(delims, closer) {
  const ci = delims.indexOf(closer);
  for (let k = ci - 1; k >= 0; k--) {
    const o = delims[k];
    if (o.ch !== closer.ch || o.len === 0 || o.dead || !o.open) continue;
    if (o.ch === '~') {
      if (o.len !== closer.len || o.len > 2) continue;
      return o;
    }
    if ((o.open && o.close) || (closer.open && closer.close)) {
      const sum = o.len + closer.len;
      if (sum % 3 === 0 && !(o.len % 3 === 0 && closer.len % 3 === 0)) continue;
    }
    return o;
  }
  return null;
}

// Escape & < > " ' for an attribute / URL, with entity-like "&word;"
// passed through but WITHOUT decoding numeric references.
function escapeNoDecode(s) {
  if (!NEED_ESCAPE.test(s)) return s;
  const out = [];
  let last = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c === 38) {
      let j = k + 1;
      if (j < s.length && s.charCodeAt(j) === 35) j++;
      const w0 = j;
      while (j < s.length && isWordCode(s.charCodeAt(j))) j++;
      if (j > w0 && j < s.length && s.charCodeAt(j) === 59) continue;
      out.push(s.slice(last, k), '&amp;');
      last = k + 1;
    } else if (c === 60) { out.push(s.slice(last, k), '&lt;'); last = k + 1; }
    else if (c === 62) { out.push(s.slice(last, k), '&gt;'); last = k + 1; }
    else if (c === 34) { out.push(s.slice(last, k), '&quot;'); last = k + 1; }
    else if (c === 39) { out.push(s.slice(last, k), '&#39;'); last = k + 1; }
  }
  out.push(s.slice(last));
  return out.join('');
}

// Plain-text rendering of inline tokens, for image alt text: links and
// emphasis contribute their text, images contribute their own alt text,
// raw HTML tags contribute nothing. Text/code are already HTML-escaped,
// so the result is safe to use as an attribute value.
function renderPlainText(tokens) {
  const out = [];
  renderPlain(tokens, out);
  return out.join('');
}

function renderPlain(tokens, out) {
  for (const tok of tokens) {
    switch (tok.t) {
      case 0: case 1: out.push(tok.s); break;
      case 2: break;
      case 3: out.push('\n'); break;
      case 4: case 5: case 6: case 7: case 8: renderPlain(tok.c, out); break;
      case 9: out.push(tok.ch.repeat(tok.len)); break;
    }
  }
}

function renderTokens(tokens) {
  const out = [];
  renderInto(tokens, out);
  return out.join('');
}

function renderInto(tokens, out) {
  for (const tok of tokens) {
    switch (tok.t) {
      case 0: out.push(tok.s); break;
      case 1: out.push('<code>', tok.s, '</code>'); break;
      case 2: out.push(tok.s); break;
      case 3: out.push('<br>'); break;
      case 4: {
        const href = cleanUrl(tok.href);
        if (href === null) { renderInto(tok.c, out); break; }
        out.push('<a href="', escapeNoDecode(href), '"');
        if (tok.title !== null && tok.title !== undefined) {
          out.push(' title="', escapeNoDecode(tok.title), '"');
        }
        out.push('>');
        renderInto(tok.c, out);
        out.push('</a>');
        break;
      }
      case 5: {
        const href = cleanUrl(tok.href);
        const alt = renderPlainText(tok.c);
        if (href === null) { out.push(escapeNoDecode(alt)); break; }
        out.push('<img src="', escapeNoDecode(href), '" alt="', escapeNoDecode(alt), '"');
        if (tok.title !== null && tok.title !== undefined) {
          out.push(' title="', escapeNoDecode(tok.title), '"');
        }
        out.push('>');
        break;
      }
      case 6: out.push('<em>'); renderInto(tok.c, out); out.push('</em>'); break;
      case 7: out.push('<strong>'); renderInto(tok.c, out); out.push('</strong>'); break;
      case 8: out.push('<del>'); renderInto(tok.c, out); out.push('</del>'); break;
      case 9: out.push(tok.ch.repeat(tok.len)); break;
    }
  }
}

