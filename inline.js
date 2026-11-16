// inline.js — inline Markdown renderer (marked 18.1.3, default options).
// Dependency-free ES module. Part 1 of the markdown-render-speed-02 entry:
// the inline layer only. The block layer (a later part) owns block structure,
// link-reference-definition parsing, and the final parse.js assembly.
//
// API (for the block layer):
//   parseInline(text, ctx) -> string
//     Renders paragraph / heading / table-cell text to HTML. `text` is the
//     raw inline source of one block; line endings are normalised to \n here
//     and one trailing \n is stripped. `ctx` is optional; pass the object
//     returned by createInlineContext() so reference links resolve.
//   createInlineContext(defs) -> { refs: Map }
//     `defs` is a Map (or plain object, or array of [label, href, title] /
//     {label, href, title} entries) keyed by label. Keys are re-normalised
//     with normalizeLabel(); the FIRST definition for a label wins.
//   normalizeLabel(label) -> string
//     Lowercase (full Unicode case folding via toLowerCase), collapse every
//     run of whitespace (space, tab, newline, ...) to one space, trim.
//   escapeText(s) / escapeHtml(s) -> string
//     Text escaping, marked-style: escape & < > " ' — except that an &
//     which starts a valid entity (&word; &#123; &#x1a;) is left alone.
//   escapeCode(s) -> string
//     Code-span escaping: every & < > " ' is escaped, entities included.
//   cleanUrl(url) -> string | null
//     Returns null for javascript:/vbscript:/data: URLs (checked after
//     stripping whitespace/control chars, case-insensitively); otherwise
//     encodeURI(url) with %25 restored to %, as marked's cleanUrl does.
//
// Notes for the block-layer builder:
//  * parseInline does NOT consume link reference definitions itself; it only
//    looks them up in ctx.refs. Definitions may appear anywhere in the
//    document and must be collected before rendering (first wins).
//  * Hard breaks render as "<br>" (marked 18), soft breaks as a literal \n.
//  * Strikethrough is GFM: ~~text~~ -> <del>text</del>; a single ~ is literal.
//  * Raw inline HTML is passed through verbatim when it is a well-formed
//    tag / comment / processing instruction / declaration / CDATA section;
//    otherwise the "<" is escaped.

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

// --- escaping -------------------------------------------------------------

export function escapeText(s) {
  // Escape & < > " ' ; leave a valid entity reference (&name; &#12; &#x1f;)
  // untouched. Fast path: nothing special in the string.
  if (!/[&<>"']/.test(s)) return s;
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "&") {
      const m = /^&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/.exec(s.slice(i, i + 40));
      if (m) {
        // Numeric references: decode valid ones, escape invalid ones.
        // Named references (defined or not) pass through verbatim.
        if (m[0][1] === "#") {
          const body = m[0].slice(2, -1);
          const cp = body[0] === "x" || body[0] === "X" ? parseInt(body.slice(1), 16) : parseInt(body, 10);
          if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) { out += "\uFFFD"; i += m[0].length; continue; }
          if (cp > 0x10ffff || !Number.isFinite(cp)) { out += "&amp;" + m[0].slice(1); i += m[0].length; continue; }
          const ch = String.fromCodePoint(cp);
          out += ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : ch === "'" ? "&#39;" : ch;
          i += m[0].length; continue;
        }
        out += m[0]; i += m[0].length; continue;
      }
      out += "&amp;"; i++;
    } else if (c === "<") { out += "&lt;"; i++; }
    else if (c === ">") { out += "&gt;"; i++; }
    else if (c === '"') { out += "&quot;"; i++; }
    else if (c === "'") { out += "&#39;"; i++; }
    else { out += c; i++; }
  }
  return out;
}
export const escapeHtml = escapeText;

export function escapeCode(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Attribute escaping for href / title / alt: same no-encode rule as text,
// because marked feeds attribute values through its escape() as well.
export function escapeAttr(s) { return escapeText(s); }

export function normalizeLabel(label) {
  // Full Unicode case folding is approximated by toLowerCase() plus the
  // folds toLowerCase() misses: ß (and ẞ, which lowercases to ß) folds to
  // "ss" (cm-540), the Latin ligatures expand, and final sigma ς folds
  // to σ. Collapse all whitespace runs to a single space and trim.
  return label.toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ﬀ/g, "ff").replace(/ﬁ/g, "fi").replace(/ﬂ/g, "fl")
    .replace(/ﬃ/g, "ffi").replace(/ﬄ/g, "ffl")
    .replace(/ﬅ/g, "st").replace(/ﬆ/g, "st")
    .replace(/ς/g, "σ")
    .replace(/\s+/g, " ").trim();
}

const BAD_PROTO = /^(?:javascript|vbscript|data):/i;
export function cleanUrl(url) {
  if (url == null) return null;
  let u = String(url);
  // Scheme check only (on a decoded copy): decode numeric refs and
  // &colon; that could hide javascript:/vbscript:/data:, plus %-escapes.
  // The returned URL itself keeps its entities verbatim (cf. cm-032).
  let check = u.replace(/&(?:#\d+|#[xX][0-9a-fA-F]+|colon);/gi, (m) => {
    const body = m.slice(1, -1);
    if (body.toLowerCase() === "colon") return ":";
    const cp = body[1] === "x" || body[1] === "X"
      ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) {
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return m;
  });
  try { check = decodeURIComponent(check); } catch { /* keep as-is */ }
  if (BAD_PROTO.test(check.replace(/[\t\n\r ]+/g, ""))) return null;
  try { return encodeURI(u).replace(/%25/g, "%"); }
  catch { return null; }
}

export function createInlineContext(defs) {
  const refs = new Map();
  if (!defs) return { refs };
  const put = (label, href, title) => {
    const key = normalizeLabel(String(label));
    if (!key || refs.has(key)) return;
    refs.set(key, { href: href == null ? "" : String(href), title: title == null ? null : String(title) });
  };
  if (defs instanceof Map) {
    for (const [k, v] of defs) {
      if (v && typeof v === "object") put(k, v.href, v.title);
      else put(k, v, null);
    }
  } else if (Array.isArray(defs)) {
    for (const e of defs) {
      if (Array.isArray(e)) put(e[0], e[1], e[2]);
      else if (e && typeof e === "object") put(e.label, e.href, e.title);
    }
  } else if (typeof defs === "object") {
    for (const k of Object.keys(defs)) {
      const v = defs[k];
      if (v && typeof v === "object") put(k, v.href, v.title);
      else put(k, v, null);
    }
  }
  return { refs };
}
export const createContext = createInlineContext;

// Named entities needed by cleanUrl's scheme check and by the entity
// pass-through (escapeText keeps valid references verbatim, so decoding is
// only needed to unmask javascript: etc. in URLs). Common HTML5 names.
const NAMED_ENTITIES = {
  quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: "\u00a0",
  iexcl: "\u00a1", cent: "\u00a2", pound: "\u00a3", curren: "\u00a4",
  yen: "\u00a5", brvbar: "\u00a6", sect: "\u00a7", uml: "\u00a8",
  copy: "\u00a9", ordf: "\u00aa", laquo: "\u00ab", not: "\u00ac",
  shy: "\u00ad", reg: "\u00ae", macr: "\u00af", deg: "\u00b0",
  plusmn: "\u00b1", sup2: "\u00b2", sup3: "\u00b3", acute: "\u00b4",
  micro: "\u00b5", para: "\u00b6", middot: "\u00b7", cedil: "\u00b8",
  sup1: "\u00b9", ordm: "\u00ba", raquo: "\u00bb", frac14: "\u00bc",
  frac12: "\u00bd", frac34: "\u00be", iquest: "\u00bf",
  Agrave: "\u00c0", Aacute: "\u00c1", Acirc: "\u00c2", Atilde: "\u00c3",
  Auml: "\u00c4", Aring: "\u00c5", AElig: "\u00c6", Ccedil: "\u00c7",
  Egrave: "\u00c8", Eacute: "\u00c9", Ecirc: "\u00ca", Euml: "\u00cb",
  Igrave: "\u00cc", Iacute: "\u00cd", Icirc: "\u00ce", Iuml: "\u00cf",
  ETH: "\u00d0", Ntilde: "\u00d1", Ograve: "\u00d2", Oacute: "\u00d3",
  Ocirc: "\u00d4", Otilde: "\u00d5", Ouml: "\u00d6", times: "\u00d7",
  Oslash: "\u00d8", Ugrave: "\u00d9", Uacute: "\u00da", Ucirc: "\u00db",
  Uuml: "\u00dc", Yacute: "\u00dd", THORN: "\u00de", szlig: "\u00df",
  agrave: "\u00e0", aacute: "\u00e1", acirc: "\u00e2", atilde: "\u00e3",
  auml: "\u00e4", aring: "\u00e5", aelig: "\u00e6", ccedil: "\u00e7",
  egrave: "\u00e8", eacute: "\u00e9", ecirc: "\u00ea", euml: "\u00eb",
  igrave: "\u00ec", iacute: "\u00ed", icirc: "\u00ee", iuml: "\u00ef",
  eth: "\u00f0", ntilde: "\u00f1", ograve: "\u00f2", oacute: "\u00f3",
  ocirc: "\u00f4", otilde: "\u00f5", ouml: "\u00f6", divide: "\u00f7",
  oslash: "\u00f8", ugrave: "\u00f9", uacute: "\u00fa", ucirc: "\u00fb",
  uuml: "\u00fc", yacute: "\u00fd", thorn: "\u00fe", yuml: "\u00ff",
  OElig: "\u0152", oelig: "\u0153", Scaron: "\u0160", scaron: "\u0161",
  Yuml: "\u0178", fnof: "\u0192", circ: "\u02c6", tilde: "\u02dc",
  Alpha: "\u0391", Beta: "\u0392", Gamma: "\u0393", Delta: "\u0394",
  Epsilon: "\u0395", Zeta: "\u0396", Eta: "\u0397", Theta: "\u0398",
  Iota: "\u0399", Kappa: "\u039a", Lambda: "\u039b", Mu: "\u039c",
  Nu: "\u039d", Xi: "\u039e", Omicron: "\u039f", Pi: "\u03a0",
  Rho: "\u03a1", Sigma: "\u03a3", Tau: "\u03a4", Upsilon: "\u03a5",
  Phi: "\u03a6", Chi: "\u03a7", Psi: "\u03a8", Omega: "\u03a9",
  alpha: "\u03b1", beta: "\u03b2", gamma: "\u03b3", delta: "\u03b4",
  epsilon: "\u03b5", zeta: "\u03b6", eta: "\u03b7", theta: "\u03b8",
  iota: "\u03b9", kappa: "\u03ba", lambda: "\u03bb", mu: "\u03bc",
  nu: "\u03bd", xi: "\u03be", omicron: "\u03bf", pi: "\u03c0",
  rho: "\u03c1", sigmaf: "\u03c2", sigma: "\u03c3", tau: "\u03c4",
  upsilon: "\u03c5", phi: "\u03c6", chi: "\u03c7", psi: "\u03c8",
  omega: "\u03c9", thetasym: "\u03d1", upsih: "\u03d2", piv: "\u03d6",
  ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", zwnj: "\u200c",
  zwj: "\u200d", lrm: "\u200e", rlm: "\u200f", ndash: "\u2013",
  mdash: "\u2014", lsquo: "\u2018", rsquo: "\u2019", sbquo: "\u201a",
  ldquo: "\u201c", rdquo: "\u201d", bdquo: "\u201e", dagger: "\u2020",
  Dagger: "\u2021", bull: "\u2022", hellip: "\u2026", permil: "\u2030",
  prime: "\u2032", Prime: "\u2033", lsaquo: "\u2039", rsaquo: "\u203a",
  oline: "\u203e", frasl: "\u2044", euro: "\u20ac",
  weierp: "\u2118", image: "\u2111", real: "\u211c", trade: "\u2122",
  alefsym: "\u2135", larr: "\u2190", uarr: "\u2191", rarr: "\u2192",
  darr: "\u2193", harr: "\u2194", crarr: "\u21b5",
  forall: "\u2200", part: "\u2202", exist: "\u2203", empty: "\u2205",
  nabla: "\u2207", isin: "\u2208", notin: "\u2209", ni: "\u220b",
  prod: "\u220f", sum: "\u2211", minus: "\u2212", lowast: "\u2217",
  radic: "\u221a", prop: "\u221d", infin: "\u221e", ang: "\u2220",
  and: "\u2227", or: "\u2228", cap: "\u2229", cup: "\u222a",
  int: "\u222b", there4: "\u2234", sim: "\u223c", cong: "\u2245",
  asymp: "\u2248", ne: "\u2260", equiv: "\u2261", le: "\u2264",
  ge: "\u2265", sub: "\u2282", sup: "\u2283", nsub: "\u2284",
  sube: "\u2286", supe: "\u2287", oplus: "\u2295", otimes: "\u2297",
  perp: "\u22a5", sdot: "\u22c5",
  lceil: "\u2308", rceil: "\u2309", lfloor: "\u230a", rfloor: "\u230b",
  lang: "\u2329", rang: "\u232a", loz: "\u25ca", spades: "\u2660",
  clubs: "\u2663", hearts: "\u2665", diams: "\u2666",
  Dcaron: "\u010e", dcaron: "\u010f", HilbertSpace: "\u210b",
  DifferentialD: "\u2146", ClockwiseContourIntegral: "\u2232", ngE: "\u2267\u0338",
};

// --- node model -----------------------------------------------------------
// Nodes: {t:'text',s} {t:'code',s} {t:'br'} {t:'soft'} {t:'html',s}
//        {t:'delim',ch,len,canOpen,canClose}
//        {t:'em'|'strong'|'del',children} {t:'link',href,title,children}
//        {t:'image',src,title,alt}
function isSpace(ch) { return ch === undefined || /\s/.test(ch); }
function isPunct(ch) {
  return ch !== undefined && (PUNCT.includes(ch) || (/[^\p{L}\p{N}\s]/u.test(ch)));
}
function isAlnum(ch) { return ch !== undefined && /[\p{L}\p{N}]/u.test(ch); }

// Flanking info for a delimiter run starting at i with length len in s.
function flank(s, i, len) {
  const before = i > 0 ? s[i - 1] : undefined;
  const after = i + len < s.length ? s[i + len] : undefined;
  const beforeSpace = before === undefined || isSpace(before);
  const afterSpace = after === undefined || isSpace(after);
  const beforePunct = before !== undefined && isPunct(before);
  const afterPunct = after !== undefined && isPunct(after);
  const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return { leftFlanking, rightFlanking };
}

function parseNodes(src, ctx, inLink) {
  const s = src;
  const n = s.length;
  const nodes = [];
  let text = "";
  const flush = () => { if (text) { nodes.push({ t: "text", s: text }); text = ""; } };
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "\\") {
      const nx = s[i + 1];
      if (nx === "\n") {
        flush(); nodes.push({ t: "br" });
        i += 2;
        while (i < n && (s[i] === " " || s[i] === "\t")) i++; // spaces after a hard break are dropped (cm-636/637)
        continue;
      }
      if (nx !== undefined && PUNCT.includes(nx)) {
        // An escaped & must not start an entity when rendered: store it
        // pre-escaped so escapeText leaves it as &amp;.
        if (nx === "&") { text += "&amp;"; i += 2; continue; }
        text += nx; i += 2; continue;
      }
      text += "\\"; i++; continue;
    }
    if (c === "&") {
      const dm = decodeNumericRef(s, i);
      if (dm) { text += dm.text; i += dm.len; continue; }
      text += "&"; i++; continue;
    }
    if (c === "\n") {
      // Hard break if the line ends with two or more spaces (or a
      // backslash, handled above); otherwise a soft break. Trailing
      // spaces are kept before a soft break (cm-649) and consumed by a
      // hard break; leading spaces of the next line are dropped after
      // a hard break only (cm-636 vs cm-049).
      let spaces = 0;
      let j = text.length - 1;
      while (j >= 0 && text[j] === " ") { spaces++; j--; }
      if (spaces >= 2) {
        text = text.slice(0, text.length - spaces);
        flush(); nodes.push({ t: "br" });
        i++;
        while (i < n && (s[i] === " " || s[i] === "\t")) i++;
      } else {
        flush(); nodes.push({ t: "soft" });
        i++;
      }
      continue;
    }
    if (c === "`") {
      let k = i;
      while (k < n && s[k] === "`") k++;
      const run = k - i;
      const close = findCodeClose(s, k, run);
      if (close >= 0) {
        let content = s.slice(k, close);
        content = content.replace(/\n/g, " ");
        if (content.length >= 2 && content[0] === " " && content[content.length - 1] === " " && content.trim() !== "") {
          content = content.slice(1, -1);
        }
        flush(); nodes.push({ t: "code", s: content });
        i = close + run; continue;
      }
      text += s.slice(i, k); i = k; continue;
    }
    if (c === "<") {
      const r = tryAutolinkOrHtml(s, i, ctx);
      if (r) { flush(); nodes.push(r.node); i = r.end; continue; }
      text += "<"; i++; continue;
    }
    if (c === "[" || (c === "!" && s[i + 1] === "[")) {
      const r = tryLink(s, i, ctx, inLink);
      if (r) { flush(); nodes.push(r.node); i = r.end; continue; }
      text += c; i++; continue;
    }
    if (c === "*" || c === "_" || c === "~") {
      let k = i;
      while (k < n && s[k] === c) k++;
      const len = k - i;
      // A tilde run of 3+ is literal text, never a delimiter (gfm-493).
      if (c === "~" && len >= 3) { text += s.slice(i, k); i = k; continue; }
      const { leftFlanking, rightFlanking } = flank(s, i, len);
      let canOpen, canClose;
      if (c === "_") {
        canOpen = leftFlanking && (!rightFlanking || isPunct(s[i - 1]));
        canClose = rightFlanking && (!leftFlanking || isPunct(s[i + len]));
      } else {
        canOpen = leftFlanking; canClose = rightFlanking;
      }
      flush(); nodes.push({ t: "delim", ch: c, len, canOpen, canClose });
      i = k; continue;
    }
    if (c === "h" || c === "f" || c === "w" || isAlnum(c)) {
      const r = tryBareLink(s, i, ctx, inLink);
      if (r) { flush(); nodes.push(r.node); i = r.end; continue; }
    }
    text += c; i++;
  }
  flush();
  return resolveEmphasis(nodes);
}

function findCodeClose(s, from, run) {
  // Find the next run of exactly `run` backticks.
  const n = s.length;
  let i = from;
  while (i < n) {
    if (s[i] === "`") {
      let k = i;
      while (k < n && s[k] === "`") k++;
      if (k - i === run) return i;
      i = k;
    } else i++;
  }
  return -1;
}

// --- autolinks and raw HTML ----------------------------------------------
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/;

function tryAutolinkOrHtml(s, i, ctx) {
  const rest = s.slice(i);
  // Autolink <scheme:...> or <email>
  if (rest[1] !== "!" && rest[1] !== "?" && rest[1] !== "/") {
    const gt = rest.indexOf(">");
    if (gt > 0) {
      const inner = rest.slice(1, gt);
      if (inner && !/[\s<>]/.test(inner)) {
        if (SCHEME_RE.test(inner)) {
          const href = cleanUrl(inner);
          if (href !== null) {
            return { node: { t: "link", href, title: null, children: [{ t: "text", s: inner }] }, end: i + gt + 1 };
          }
        } else if (EMAIL_RE.test(inner) && inner.indexOf("@") > 0) {
          const href = "mailto:" + inner;
          return { node: { t: "link", href, title: null, children: [{ t: "text", s: inner }] }, end: i + gt + 1 };
        }
      }
    }
  }
  // Raw HTML: comment, processing instruction, declaration, CDATA, tag.
  if (rest.startsWith("<!--")) {
    const end = rest.indexOf("-->");
    if (end >= 0) return { node: { t: "html", s: rest.slice(0, end + 3) }, end: i + end + 3 };
    return null;
  }
  if (rest.startsWith("<?")) {
    const end = rest.indexOf("?>");
    if (end >= 0) return { node: { t: "html", s: rest.slice(0, end + 2) }, end: i + end + 2 };
    return null;
  }
  if (rest.startsWith("<!")) {
    if (rest.startsWith("<![CDATA[")) {
      const end = rest.indexOf("]]>");
      if (end >= 0) return { node: { t: "html", s: rest.slice(0, end + 3) }, end: i + end + 3 };
      return null;
    }
    const m = /^<![A-Z][^>]*>/.exec(rest);
    if (m) return { node: { t: "html", s: m[0] }, end: i + m[0].length };
    return null;
  }
  // A closing tag carries no attributes: </name> only.
  const tagRe = rest.startsWith("</")
    ? /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/
    : /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/;
  const m = tagRe.exec(rest);
  if (m) return { node: { t: "html", s: m[0] }, end: i + m[0].length };
  return null;
}

// Extended (GFM) autolinks: bare http(s)/ftp URLs, www. URLs, scheme
// autolinks (scheme + email + at most one /segment, gfm-633..635), and
// bare emails. Only attempted at a word boundary (previous char is start
// / space / punctuation that is not part of a word).
const EMAIL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~@-";
const EMAIL_FULL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const TRAIL_PUNCT = /[?!.,:;*_~'"]+$/;

// Scan the maximal run of email characters starting at i. A '/' after
// the '@' ends the run: it starts a path (scheme autolinks), not the
// domain, so `foo@bar.baz/txt` still links as an email (gfm-634/635).
function scanEmailRun(s, i) {
  let j = i;
  let sawAt = false;
  while (j < s.length) {
    const ch = s[j];
    if (ch === "@") sawAt = true;
    if (ch === "/" && sawAt) break;
    if (!EMAIL_CHARS.includes(ch)) break;
    j++;
  }
  return s.slice(i, j);
}

// Validate a candidate email: trim trailing punctuation, then require a
// full match. The maximal-run scan is what rejects `hello@mail+xyz` and
// `a.b-c_d@a.b-` outright instead of linking a prefix (gfm-631/632).
// A trailing `_` is NOT trimmed when it ends the text: it invalidates
// the whole match (gfm-632). But when more text follows it, the `_` is
// an emphasis closer, not part of the email, so it is trimmed and the
// email links (doc-31/37/38/04: `_warning when@atlas.example.com_`).
function matchEmail(s, i) {
  const run = scanEmailRun(s, i);
  if (!run.includes("@")) return null;
  const email = run.replace(/[?!.,:;*~'"]+$/, "");
  if (email && EMAIL_FULL_RE.test(email)) return email;
  if (run.endsWith("_") && i + run.length < s.length) {
    const trimmed = run.replace(/_+$/, "").replace(/[?!.,:;*~'"]+$/, "");
    if (trimmed && EMAIL_FULL_RE.test(trimmed)) return trimmed;
  }
  return null;
}

function tryBareLink(s, i, ctx, inLink) {
  // No autolinks of any kind inside link text (doc-12/16/20/39: a bare
  // URL or email inside a link's text stays plain text).
  if (inLink) return null;
  if (i > 0) {
    const prev = s[i - 1];
    if (isAlnum(prev) || prev === "_" || prev === "-" || prev === "." || prev === "/") return null;
  }
  const rest = s.slice(i);
  // The scheme is case-insensitive (doc-06/09/10/26/39: `Https://` and
  // `Http://` autolink) but `www.` is lowercase-only (doc-09: `Www.`
  // does not link); the href keeps the original case.
  let m = /^(?:https?:\/\/|ftp:\/\/)[^\s<]+/i.exec(rest) || /^www\.[^\s<]+/.exec(rest);
  if (m) {
    const url = trimBareUrl(m[0]);
    if (url.length > 0) {
      const href = cleanUrl(/^www\./i.test(url) ? "http://" + url : url);
      if (href !== null) {
        return { node: { t: "link", href, title: null, children: [{ t: "text", s: url }] }, end: i + url.length };
      }
    }
    return null;
  }
  // Scheme autolink: scheme:email[/segment] — at most one slash, and the
  // segment after it holds no slash (gfm-635: /txt links, /bin does not).
  const sm = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(rest);
  if (sm) {
    const after = i + sm[0].length;
    const email = matchEmail(s, after);
    if (email) {
      let end = after + email.length;
      let url = sm[0] + email;
      if (s[end] === "/") {
        let k = end + 1;
        while (k < s.length && !/[\s<>/]/.test(s[k])) k++;
        // A trailing slash with no segment after it is not part of the
        // link (gfm-633: `mailto:a.b-c_d@a.b/` ends before the slash).
        if (k > end + 1) { url += s.slice(end, k); end = k; }
      }
      url = trimBareUrl(url);
      const href = cleanUrl(url);
      if (href !== null) {
        return { node: { t: "link", href, title: null, children: [{ t: "text", s: url }] }, end: i + url.length };
      }
    }
    return null;
  }
  const email = matchEmail(s, i);
  if (email) {
    return { node: { t: "link", href: "mailto:" + email, title: null, children: [{ t: "text", s: email }] }, end: i + email.length };
  }
  return null;
}

function trimBareUrl(url) {
  // Strip trailing punctuation: ? ! . , : ; * _ ~ ' " and unbalanced ).
  // The punctuation and paren steps repeat until stable: stripping a
  // `)` can expose a `.` that must also go (doc-10: `...nova).`).
  let end = url.length;
  for (;;) {
    const before = end;
    while (end > 0 && "?!.,:;*_~'\"".includes(url[end - 1])) end--;
    // Balance parens: drop trailing ) while there are more ) than (.
    while (end > 0 && url[end - 1] === ")") {
      const sub = url.slice(0, end);
      const open = (sub.match(/\(/g) || []).length;
      const close = (sub.match(/\)/g) || []).length;
      if (close > open) end--; else break;
    }
    if (end === before) break;
  }
  // A trailing `;` that closes an entity-like `&name` sequence means the
  // whole `&name;` is not part of the link (gfm-627: `&hl;` is excluded).
  if (url[end] === ";") {
    const m = /&[A-Za-z0-9]+$/.exec(url.slice(0, end));
    if (m) end -= m[0].length;
  }
  return url.slice(0, end);
}

// --- links and images -----------------------------------------------------
// Parse the bracketed label starting at s[i] === '['. Returns
// { text, end } where end is the index just past the closing ']', or null.
// Scan a raw HTML construct starting at s[i] === '<' (comment, PI,
// declaration, CDATA, or tag). Returns the index just past it, or -1.
function scanRawHtml(s, i) {
  const rest = s.slice(i);
  if (rest.startsWith("<!--")) {
    const end = rest.indexOf("-->");
    return end >= 0 ? i + end + 3 : -1;
  }
  if (rest.startsWith("<?")) {
    const end = rest.indexOf("?>");
    return end >= 0 ? i + end + 2 : -1;
  }
  if (rest.startsWith("<![CDATA[")) {
    const end = rest.indexOf("]]>");
    return end >= 0 ? i + end + 3 : -1;
  }
  if (rest.startsWith("<!")) {
    const m = /^<![A-Z][^>]*>/.exec(rest);
    return m ? i + m[0].length : -1;
  }
  // A closing tag carries no attributes: </name> only.
  if (rest.startsWith("</")) {
    const m = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(rest);
    return m ? i + m[0].length : -1;
  }
  const m = /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/.exec(rest);
  return m ? i + m[0].length : -1;
}

// Scan an autolink <scheme:...> or <email> starting at s[i] === '<'.
// Returns the index just past the closing '>', or -1.
function scanAutolink(s, i) {
  const rest = s.slice(i);
  if (rest[1] === "!" || rest[1] === "?" || rest[1] === "/") return -1;
  const gt = rest.indexOf(">");
  if (gt <= 0) return -1;
  const inner = rest.slice(1, gt);
  if (!inner || /[\s<>]/.test(inner)) return -1;
  if (SCHEME_RE.test(inner)) return i + gt + 1;
  if (EMAIL_RE.test(inner) && inner.indexOf("@") > 0) return i + gt + 1;
  return -1;
}

function parseLinkLabel(s, i) {
  const n = s.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = s[j];
    if (c === "\\" && j + 1 < n && PUNCT.includes(s[j + 1])) { j += 2; continue; }
    if (c === "`") {
      let k = j;
      while (k < n && s[k] === "`") k++;
      const run = k - j;
      const close = findCodeClose(s, k, run);
      if (close >= 0) { j = close + run; continue; }
      j = k; continue;
    }
    if (c === "<") {
      // A ] inside a tag's quoted attribute, or inside an autolink URL,
      // does not close the label (cf. cm-524, cm-526).
      const end = scanAutolink(s, j);
      if (end > 0) { j = end; continue; }
      const hend = scanRawHtml(s, j);
      if (hend > 0) { j = hend; continue; }
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return { text: s.slice(i + 1, j), end: j + 1 };
      if (depth < 0) return null;
    }
    j++;
  }
  return null;
}

function skipSpaces(s, i) {
  while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\n")) i++;
  return i;
}

// Parse a link destination at s[i]: <...> or bare with balanced parens.
// Returns { dest, end } or null. `end` is just past the destination.
function parseDestination(s, i) {
  const n = s.length;
  if (s[i] === "<") {
    let j = i + 1;
    let dest = "";
    while (j < n) {
      const c = s[j];
      if (c === ">") return { dest, end: j + 1 };
      if (c === "\n" || c === "<") return null;
      if (c === "&") {
        const dm = decodeNumericRef(s, j, false);
        if (dm) { dest += dm.text; j += dm.len; continue; }
      }
      if (c === "\\" && j + 1 < n && PUNCT.includes(s[j + 1])) { dest += s[j + 1]; j += 2; continue; }
      dest += c; j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  let dest = "";
  while (j < n) {
    const c = s[j];
    if (c === " " || c === "\t" || c === "\n") break;
    if (c === "&") {
      const dm = decodeNumericRef(s, j, false);
      if (dm) { dest += dm.text; j += dm.len; continue; }
    }
    if (c === "\\" && j + 1 < n && PUNCT.includes(s[j + 1])) { dest += s[j + 1]; j += 2; continue; }
    if (c === "(") { depth++; dest += c; j++; continue; }
    if (c === ")") {
      if (depth === 0) break;
      depth--; dest += c; j++; continue;
    }
    // A control character ends the destination.
    if (c.charCodeAt(0) < 0x20) break;
    dest += c; j++;
  }
  if (j === i) return null;
  return { dest, end: j };
}

function parseTitle(s, i) {
  const n = s.length;
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== "(") return null;
  const close = q === "(" ? ")" : q;
  let j = i + 1;
  let title = "";
  while (j < n) {
    const c = s[j];
    if (c === close) return { title, end: j + 1 };
    if (c === "\n") return null;
    if (c === "&") {
      const dm = decodeNumericRef(s, j);
      if (dm) { title += dm.text; j += dm.len; continue; }
    }
    if (c === "\\" && j + 1 < n && PUNCT.includes(s[j + 1])) {
      title += s[j + 1] === "&" ? "&amp;" : s[j + 1]; j += 2; continue;
    }
    title += c; j++;
  }
  return null;
}

// Decode a numeric character reference at s[i] (&...;). Returns
// { text, len } or null. `ampAsEntity` makes a decoded & come back as
// "&amp;" (for text/title contexts, where a raw & could re-form an
// entity at render time); URL destinations pass false.
function decodeNumericRef(s, i, ampAsEntity) {
  const m = /^&#[0-9]+;|^&#[xX][0-9a-fA-F]+;/.exec(s.slice(i, i + 12));
  if (!m) return null;
  const body = m[0].slice(2, -1);
  const cp = body[0] === "x" || body[0] === "X" ? parseInt(body.slice(1), 16) : parseInt(body, 10);
  if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return { text: "\uFFFD", len: m[0].length };
  if (cp > 0x10ffff || !Number.isFinite(cp)) return { text: "&amp;" + m[0].slice(1), len: m[0].length };
  if (cp === 0x26) return { text: ampAsEntity === false ? "&" : "&amp;", len: m[0].length };
  return { text: String.fromCodePoint(cp), len: m[0].length };
}

function tryLink(s, i, ctx, inLink) {
  const isImage = s[i] === "!";
  const start = isImage ? i + 1 : i;
  if (s[start] !== "[") return null;
  const label = parseLinkLabel(s, start);
  if (!label) return null;
  // A link cannot contain a link: if the label's inline content holds a
  // link, the outer link is not formed and the inner link wins (cm-518).
  // Images are exempt: their description may contain a link (cm-520).
  if (!isImage && label.text.includes("[") && labelContainsLink(label.text, ctx)) return null;
  // A link label may not contain an unescaped '[' (nested link text is
  // allowed only via balanced brackets, which parseLinkLabel enforces by
  // depth; a raw '[' inside at depth 1 is fine for marked, so no check).
  let j = label.end;
  const refs = ctx && ctx.refs;
  const lookup = (key) => {
    if (!refs) return null;
    const r = refs.get(normalizeLabel(key));
    return r || null;
  };
  const makeNode = (href, title) => {
    const clean = cleanUrl(href);
    if (clean === null) return null;
    if (isImage) {
      return { node: { t: "image", src: clean, title, alt: renderAlt(label.text, ctx) }, end: j };
    }
    if (inLink) return null;
    return { node: { t: "link", href: clean, title, children: parseNodes(label.text, ctx, true) }, end: j };
  };
  // Inline link: [text](dest "title"). When the (...) is not a valid
  // inline link, fall through and try the reference forms for [text]
  // instead (cm-568): a failed inline link does not void the shortcut.
  if (s[j] === "(") {
    let k = skipSpaces(s, j + 1);
    if (s[k] === ")") { j = k + 1; return makeNode("", null); }
    const dest = parseDestination(s, k);
    if (dest) {
      k = skipSpaces(s, dest.end);
      let title = null;
      let bad = false;
      if (s[k] === '"' || s[k] === "'" || s[k] === "(") {
        const t = parseTitle(s, k);
        if (!t) bad = true;
        else { title = t.title; k = skipSpaces(s, t.end); }
      }
      if (!bad && s[k] === ")") { j = k + 1; return makeNode(dest.dest, title); }
    }
  }
  // Reference link: [text][label] / [text][] / [text]
  if (s[j] === "[") {
    const ref = parseLinkLabel(s, j);
    if (ref) {
      const key = ref.text === "" ? label.text : ref.text;
      const r = lookup(key);
      if (r) { j = ref.end; return makeNode(r.href, r.title); }
      return null;
    }
    return null;
  }
  // Shortcut reference link: [text]
  const r = lookup(label.text);
  if (r) return makeNode(r.href, r.title);
  return null;
}

// True when parsing `text` as inline content produces a link node
// anywhere (used to enforce "a link cannot contain a link").
function labelContainsLink(text, ctx) {
  const nodes = parseNodes(text, ctx, false);
  const walk = (ns) => {
    for (const nd of ns) {
      if (nd.t === "link") return true;
      if (nd.children && walk(nd.children)) return true;
    }
    return false;
  };
  return walk(nodes);
}
// entities / escapes resolved the way marked does: strip formatting by
// rendering the label's inline nodes to text, then escaping for the
// attribute. Delimiter runs stay literal.
function renderAlt(labelText, ctx) {
  // Links inside the description contribute their text to the alt
  // (cm-520, cm-575), so parse with links allowed.
  const nodes = parseNodes(labelText, ctx, false);
  let out = "";
  const walk = (ns) => {
    for (const nd of ns) {
      if (nd.t === "text") out += nd.s;
      else if (nd.t === "code") out += nd.s;
      else if (nd.t === "br" || nd.t === "soft") out += " ";
      else if (nd.t === "html") out += nd.s;
      else if (nd.t === "delim") out += nd.ch.repeat(nd.len);
      else if (nd.t === "link" || nd.t === "image") { if (nd.children) walk(nd.children); else if (nd.alt) out += nd.alt; }
      else if (nd.children) walk(nd.children);
    }
  };
  walk(nodes);
  return out;
}

// --- emphasis / strikethrough --------------------------------------------
// CommonMark delimiter-stack algorithm, run over the node list after the
// first scan. Delimiter nodes that survive become literal text.
function resolveEmphasis(nodes) {
  const delims = [];
  for (const nd of nodes) if (nd.t === "delim") delims.push(nd);
  if (delims.length === 0) return nodes;
  const openers = { "*": [], "_": [], "~": [] };
  for (const closer of delims) {
    if (!closer.canClose || closer.len === 0) {
      if (closer.canOpen && closer.len > 0) openers[closer.ch].push(closer);
      continue;
    }
    const stack = openers[closer.ch];
    // A closer with delimiters left keeps looking for openers (e.g.
    // ***a***: the closer first makes <strong>, then the leftovers
    // make <em> around it).
    while (closer.len > 0) {
      let opener = null;
      let oi = stack.length - 1;
      while (oi >= 0) {
        const cand = stack[oi];
        if (cand.len === 0) { stack.splice(oi, 1); oi--; continue; }
        if ((cand.canClose || closer.canOpen) && (cand.len + closer.len) % 3 === 0 && !(cand.len % 3 === 0 && closer.len % 3 === 0)) { oi--; continue; }
        opener = cand; break;
      }
      if (!opener) break;
      // Single- and double-tilde runs both strike (gfm-491); a run of
      // 3+ never becomes a delimiter (handled in parseNodes, gfm-493).
      const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
      if (use === 0) break;
      const oi2 = nodes.indexOf(opener);
      const ci2 = nodes.indexOf(closer);
      if (oi2 < 0 || ci2 < 0) break;
      if (ci2 - oi2 < 2) {
        // Nothing between opener and closer: drop this opener and look
        // for an earlier one.
        const p = stack.indexOf(opener); if (p >= 0) stack.splice(p, 1);
        continue;
      }
      const children = nodes.slice(oi2 + 1, ci2);
      const kind = closer.ch === "~" ? "del" : (use === 2 ? "strong" : "em");
      const emNode = { t: kind, children };
      // Delimiters swallowed into the new emphasis node are no longer
      // available as openers at this level (cf. cm-470).
      purgeDelims(children, openers);
      opener.len -= use;
      closer.len -= use;
      const replacement = [];
      if (opener.len > 0) replacement.push(opener);
      replacement.push(emNode);
      if (closer.len > 0) replacement.push(closer);
      nodes.splice(oi2, ci2 - oi2 + 1, ...replacement);
      if (opener.len === 0) { const p = stack.indexOf(opener); if (p >= 0) stack.splice(p, 1); }
    }
    if (closer.len > 0 && closer.canOpen) stack.push(closer);
  }
  return nodes;
}

// Remove every delimiter node contained (recursively) in `children` from
// the opener stacks, so it can no longer pair with a later closer.
function purgeDelims(children, openers) {
  for (const nd of children) {
    if (nd.t === "delim") {
      const st = openers[nd.ch];
      const p = st.indexOf(nd);
      if (p >= 0) st.splice(p, 1);
    } else if (nd.children) {
      purgeDelims(nd.children, openers);
    }
  }
}

// --- rendering ------------------------------------------------------------
function renderNodes(nodes) {
  let out = "";
  for (const nd of nodes) {
    switch (nd.t) {
      case "text": out += escapeText(nd.s); break;
      case "code": out += "<code>" + escapeCode(nd.s) + "</code>"; break;
      case "br": out += "<br>"; break;
      case "soft": out += "\n"; break;
      case "html": out += nd.s; break;
      case "delim": out += escapeText(nd.ch.repeat(nd.len)); break;
      case "em": out += "<em>" + renderNodes(nd.children) + "</em>"; break;
      case "strong": out += "<strong>" + renderNodes(nd.children) + "</strong>"; break;
      case "del": out += "<del>" + renderNodes(nd.children) + "</del>"; break;
      case "link": {
        out += '<a href="' + escapeAttr(nd.href) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeAttr(nd.title) + '"';
        out += ">" + renderNodes(nd.children) + "</a>";
        break;
      }
      case "image": {
        out += '<img src="' + escapeAttr(nd.src) + '" alt="' + escapeAttr(nd.alt) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeAttr(nd.title) + '"';
        out += ">";
        break;
      }
    }
  }
  return out;
}

export function parseInline(text, ctx) {
  if (text == null) return "";
  let s = String(text).replace(/\r\n?/g, "\n");
  if (s.endsWith("\n")) s = s.slice(0, -1);
  if (s.startsWith("\n")) s = s.slice(1); // a leading blank line is the block layer's, not inline content
  return renderNodes(parseNodes(s, ctx || null, false));
}
export const renderInline = parseInline;
export const inlineToHtml = parseInline;
