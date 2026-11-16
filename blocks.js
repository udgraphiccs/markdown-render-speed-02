// blocks.js — block-level Markdown parser (marked 18.1.3, default options).
// Dependency-free ES module. Part 2 of the markdown-render-speed-02 entry:
// the block parser and link-reference-definition collection. It wires the
// inline renderer in inline.js (parseInline) to a two-phase block parse:
// phase 1 walks the document once, building a token tree and collecting
// every link reference definition (first definition wins); phase 2 renders
// the tokens with the complete definition map, so references resolve even
// when the definition appears after its use.
//
// Rules followed: CommonMark 0.31.2 + GFM as marked 18.1.3 implements
// them, with marked's exact output details (blank-line handling, tight vs
// loose lists, info-string escaping, table cell padding, blockquote
// nesting, HTML-block termination). Written from RULES.txt, the practice
// set and inline.js only.

import {
  parseInline,
  createInlineContext,
  normalizeLabel,
  escapeCode,
  escapeText,
} from "./inline.js";

// --- line helpers ----------------------------------------------------------
// Lines have \n stripped; \r\n / \r are normalised to \n before splitting.

export function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

// Columns of leading whitespace: a tab advances to the next multiple of 4.
export function indentInfo(line) {
  let cols = 0;
  let chars = 0;
  while (chars < line.length) {
    const c = line[chars];
    if (c === " ") { cols += 1; chars += 1; }
    else if (c === "\t") { cols += 4 - (cols % 4); chars += 1; }
    else break;
  }
  return { cols, chars };
}

// Expand a line's leading whitespace (spaces and tabs) to spaces only.
// A tab advances to the next multiple of 4 columns, so a tab that follows
// another tab keeps its original width instead of being re-measured from
// a shifted column. Returns { expanded, rest }.
export function expandLeadingWhitespace(line) {
  let cols = 0;
  let i = 0;
  let out = "";
  while (i < line.length) {
    const c = line[i];
    if (c === " ") { out += " "; cols += 1; i += 1; }
    else if (c === "\t") { const w = 4 - (cols % 4); out += " ".repeat(w); cols += w; i += 1; }
    else break;
  }
  return { expanded: out, rest: line.slice(i) };
}

// Remove up to n columns of leading whitespace from a fenced-code
// content line. A tab at or beyond the fence indent is preserved
// verbatim (doc-13: `  \tindented` in a fence at indent 2 stays a
// tab; doc-02: a leading tab in a fence at indent 0 stays a tab),
// while a tab straddling the indent expands to spaces first
// (doc-05/06/22/39: ` \tindented` in a fence at indent 3 becomes
// ` indented`) — the same rule as indented code.
export function stripFenceIndent(line, n) {
  return stripCodeIndent(line, n);
}

// Strip n columns of leading whitespace, expanding tabs to spaces
// first (the continuation and fence strips; cm-005, doc-05/06/22/39).
// A lazy-continuation marker is not content: drop it before stripping.
export function stripCols(line, n) {
  if (line.startsWith("\u0000")) line = line.slice(1);
  const { expanded, rest } = expandLeadingWhitespace(line);
  if (expanded.length <= n) return rest;
  return expanded.slice(n) + rest;
}

// Strip n columns for indented code: a tab at or beyond the boundary is
// preserved verbatim (doc-02: `    \tindented` minus 4 cols keeps the
// tab), while a tab straddling the boundary expands (cm-005's rule).
export function stripCodeIndent(line, n) {
  if (line.startsWith("\u0000")) line = line.slice(1);
  let cols = 0;
  let i = 0;
  while (i < line.length && cols < n) {
    const c = line[i];
    if (c === " ") { cols += 1; i += 1; }
    else if (c === "\t") {
      const w = 4 - (cols % 4);
      if (cols + w <= n) { cols += w; i += 1; }
      else {
        const { expanded, rest } = expandLeadingWhitespace(line);
        if (expanded.length <= n) return rest;
        return expanded.slice(n) + rest;
      }
    }
    else break;
  }
  return line.slice(i);
}

// Strip 0-3 leading spaces (tabs count as columns) for a block start.
// Returns { rest, indent } or null when the indent is 4+ columns.
export function stripUpTo3(line) {
  const { cols, chars } = indentInfo(line);
  if (cols > 3) return null;
  return { rest: line.slice(chars), indent: cols };
}

// A line's content after removing up to 3 columns of indent, or the line
// itself when the indent is larger (used for paragraph text, where the
// leading spaces are kept verbatim except for the 0-3 block indent). A
// whitespace-only line keeps its spaces: it is paragraph text, not a
// blank line (cm-241).
export function paraLine(line) {
  if (/^[ \t]*$/.test(line)) return line;
  const s = stripUpTo3(line);
  return s ? s.rest : line;
}

// Expand the leading whitespace of `s`, whose first character sits at
// column `startCol`, to spaces (a tab advances to the next multiple of 4).
export function expandLeadingTabsAt(s, startCol) {
  let cols = startCol;
  let i = 0;
  let out = "";
  while (i < s.length) {
    const c = s[i];
    if (c === " ") { out += " "; cols += 1; i += 1; }
    else if (c === "\t") { const w = 4 - (cols % 4); out += " ".repeat(w); cols += w; i += 1; }
    else break;
  }
  return out + s.slice(i);
}

// --- link reference definitions ------------------------------------------
// A definition is parsed from the joined text of a paragraph run (lines
// joined with \n). It may span lines: the label may contain line endings,
// the destination and the title may each sit on a following line, and the
// title itself may span lines. Returns { label, href, title, end } where
// end is the offset just past the definition's last line content (at the
// \n that ends it, or EOF), or null when the text is not a definition.
// The whole definition fails (returns null, consuming nothing) when any
// part is malformed, including junk after a complete title.

const PUNCT_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

export function unescapeText(s) {
  return s.replace(PUNCT_RE, "$1");
}

// Skip spaces/tabs and line endings (with the following line's indent)
// inside a definition, between its parts.
function skipDefSpace(text, i) {
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n") i += 1;
    else break;
  }
  return i;
}

// Parse a title starting at text[i] ('"', "'" or '('). Returns
// { title, end } with end just past the closing quote/paren, or null.
function parseDefTitle(text, i) {
  const n = text.length;
  const open = text[i];
  const close = open === "(" ? ")" : open;
  let j = i + 1;
  while (j < n) {
    const c = text[j];
    // A title may span lines (cm-196); it ends at the closing quote.
    if (c === "\\" && j + 1 < n) { j += 2; continue; }
    if (c === close) {
      return { title: unescapeText(text.slice(i + 1, j)), end: j + 1 };
    }
    if (open === "(" && c === "(") return null;
    j += 1;
  }
  return null;
}

export function parseDefFromText(text, pos) {
  const n = text.length;
  let i = pos;
  // Up to 3 columns of indent before the label.
  let cols = 0;
  while (i < n && cols < 3 && (text[i] === " " || text[i] === "\t")) {
    cols += text[i] === "\t" ? 4 - (cols % 4) : 1;
    i += 1;
  }
  if (i >= n || text[i] !== "[") return null;
  // Label: up to the first unescaped ]. It may span lines, but it may
  // not contain an unescaped [ (cm-547, cm-548, cm-590), and is at most
  // 999 characters.
  const labelStart = i + 1;
  let closed = -1;
  i += 1;
  while (i < n) {
    const c = text[i];
    if (c === "\\" && i + 1 < n) { i += 2; continue; }
    if (c === "[") return null;
    if (c === "]") { closed = i; break; }
    i += 1;
  }
  if (closed < 0) return null;
  const labelRaw = text.slice(labelStart, closed);
  if (labelRaw.length === 0 || labelRaw.length > 999) return null;
  if (normalizeLabel(labelRaw) === "") return null;
  i = closed + 1;
  if (i >= n || text[i] !== ":") return null;
  i += 1;
  // Whitespace (spaces, tabs, line endings + indent) before the destination.
  i = skipDefSpace(text, i);
  if (i >= n) return null;
  // Destination.
  let href;
  if (text[i] === "<") {
    const start = i + 1;
    i += 1;
    let ok = false;
    while (i < n) {
      const c = text[i];
      if (c === "\\" && i + 1 < n) { i += 2; continue; }
      if (c === "\n" || c === "<") return null;
      if (c === ">") { ok = true; break; }
      i += 1;
    }
    if (!ok) return null;
    href = unescapeText(text.slice(start, i));
    i += 1;
  } else {
    const start = i;
    let paren = 0;
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n") break;
      if (c === "\\" && i + 1 < n) { i += 2; continue; }
      if (c === "(") paren += 1;
      else if (c === ")") {
        if (paren === 0) break;
        paren -= 1;
      }
      i += 1;
    }
    if (paren > 0) return null;
    if (i === start) return null; // empty bare destination is not a definition
    href = unescapeText(text.slice(start, i));
  }
  // Optional title: same line, or the following line. A title must be
  // separated from the destination by whitespace (cm-201). When the title
  // starts on the following line and is malformed (or junk follows it),
  // the definition still stands without the title (cm-210); when it
  // starts on the destination's own line, junk after it voids the whole
  // definition (cm-209).
  const destEnd = i;
  let title = null;
  let j = i;
  let sep = 0;
  while (j < n && (text[j] === " " || text[j] === "\t")) { j += 1; sep += 1; }
  let titleOnNextLine = false;
  if (j < n && text[j] === "\n") {
    let k = j + 1;
    while (k < n && (text[k] === " " || text[k] === "\t")) k += 1;
    if (k < n && (text[k] === '"' || text[k] === "'" || text[k] === "(")) { j = k; titleOnNextLine = true; }
  }
  if (j < n && (text[j] === '"' || text[j] === "'" || text[j] === "(")) {
    if (!titleOnNextLine && sep === 0) return null;
    const t = parseDefTitle(text, j);
    if (!t) {
      if (titleOnNextLine) return { label: labelRaw, href, title: null, end: destEnd };
      return null;
    }
    title = t.title;
    j = t.end;
    while (j < n && (text[j] === " " || text[j] === "\t")) j += 1;
    if (j < n && text[j] !== "\n") {
      if (titleOnNextLine) return { label: labelRaw, href, title: null, end: destEnd };
      return null; // junk after the title
    }
    i = j;
  } else {
    if (j < n && text[j] !== "\n") return null; // junk after the destination
    i = j;
  }
  return { label: labelRaw, href, title, end: i };
}

// --- block-start matchers --------------------------------------------------
// Each matcher takes a raw line and returns info, or null. All of them
// allow 0-3 columns of leading indent; a larger indent is not a block
// start (it is indented code, or paragraph text).

// ATX heading: 1-6 #s, then spaces + content, with an optional closing
// sequence of #s preceded by a space. Returns { level, text }.
export function matchAtx(line) {
  const s = stripUpTo3(line);
  if (!s) return null;
  const m = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(s.rest);
  if (!m) return null;
  let text = m[2] == null ? "" : m[2];
  // A closing sequence: trailing #s preceded by a space, nothing else.
  // It is stripped from the raw remainder after the opening hashes,
  // separator space included (cm-079: "### ###" is an empty heading).
  text = (" " + text).replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level: m[1].length, text };
}

// Setext underline: =+ (level 1) or -+ (level 2), 0-3 indent, trailing
// spaces/tabs only. Returns the level, or 0.
export function matchSetext(line) {
  const s = stripUpTo3(line);
  if (!s) return 0;
  if (/^=+[ \t]*$/.test(s.rest)) return 1;
  if (/^-+[ \t]*$/.test(s.rest)) return 2;
  return 0;
}

// Thematic break: 3+ of *, - or _ (one kind), separated only by spaces.
export function matchHr(line) {
  const s = stripUpTo3(line);
  if (!s) return false;
  return /^(?:\*[ \t]*){3,}$|^(?:-[ \t]*){3,}$|^(?:_[ \t]*){3,}$/.test(s.rest);
}

// Fenced code start: ``` or ~~~ (3+), info string after. For backtick
// fences the info string must not contain a backtick. Returns
// { marker, len, info } or null.
export function matchFence(line) {
  const s = stripUpTo3(line);
  if (!s) return null;
  const m = /^(`{3,}|~{3,})(.*)$/.exec(s.rest);
  if (!m) return null;
  if (m[1][0] === "`" && m[2].includes("`")) return null;
  return { marker: m[1][0], len: m[1].length, info: m[2], indent: s.indent };
}

// List marker at a line start (0-3 indent). Returns
// { bullet, ordered, num, delim, contentCol, markerLen } where contentCol
// is the column (in the stripped line) where the item content begins, or
// null when the line is not a list item start.
export function matchListMarker(line) {
  const s = stripUpTo3(line);
  if (!s) return null;
  const rest = s.rest;
  let m = /^([*+-])([ \t]+)(.*)$/.exec(rest);
  if (m) {
    // The gap is measured in columns (tabs expand from the marker's
    // column); a gap of 5+ columns puts the content at marker + 1 with
    // the rest of the gap as content (cm-007). A marker with no content
    // is an empty item whose content column is marker + 1 (cm-279).
    const gapCols = expandLeadingTabsAt(m[2], s.indent + 1).length;
    if (m[3] === "") {
      return { bullet: m[1], ordered: false, num: 0, delim: "", contentCol: s.indent + 2, markerLen: 1, content: "", indent: s.indent, empty: true };
    }
    if (gapCols >= 5) {
      return { bullet: m[1], ordered: false, num: 0, delim: "", contentCol: s.indent + 2, markerLen: 1, content: expandLeadingTabsAt(m[2], s.indent + 1).slice(1) + m[3], indent: s.indent };
    }
    return { bullet: m[1], ordered: false, num: 0, delim: "", contentCol: s.indent + 1 + gapCols, markerLen: 1, content: m[3], indent: s.indent };
  }
  m = /^(\d{1,9})([.)])([ \t]+)(.*)$/.exec(rest);
  if (m) {
    const markerLen = m[1].length + 1;
    const gapCols = expandLeadingTabsAt(m[3], s.indent + markerLen).length;
    if (m[4] === "") {
      return { bullet: "", ordered: true, num: parseInt(m[1], 10), delim: m[2], contentCol: s.indent + markerLen + 1, markerLen, content: "", indent: s.indent, empty: true };
    }
    if (gapCols >= 5) {
      return { bullet: "", ordered: true, num: parseInt(m[1], 10), delim: m[2], contentCol: s.indent + markerLen + 1, markerLen, content: expandLeadingTabsAt(m[3], s.indent + markerLen).slice(1) + m[4], indent: s.indent };
    }
    return { bullet: "", ordered: true, num: parseInt(m[1], 10), delim: m[2], contentCol: s.indent + markerLen + gapCols, markerLen, content: m[4], indent: s.indent };
  }
  // A bare marker with nothing after it is an empty list item.
  m = /^([*+-])$/.exec(rest);
  if (m) return { bullet: m[1], ordered: false, num: 0, delim: "", contentCol: s.indent + 2, markerLen: 1, content: "", indent: s.indent, empty: true };
  m = /^(\d{1,9})([.)])$/.exec(rest);
  if (m) return { bullet: "", ordered: true, num: parseInt(m[1], 10), delim: m[2], contentCol: s.indent + m[1].length + 2, markerLen: m[1].length + 1, content: "", indent: s.indent, empty: true };
  return null;
}

// --- HTML blocks -----------------------------------------------------------
// Start conditions 1-7 of CommonMark 0.31.2. Types 1-5 end at the line
// containing the end marker; types 6-7 end at a blank line. Returns
// { type, endRe } (endRe null for types 6-7) or null.

const BLOCK_TAGS = new Set(
  ("address article aside base basefont blockquote body caption center col " +
   "colgroup dd details dialog dir div dl dt fieldset figcaption figure " +
   "footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe " +
   "legend li link main menu menuitem nav noframes ol optgroup option p " +
   "param search section summary table tbody td tfoot th thead title tr " +
   "track ul").split(" ")
);

// Scan a complete HTML tag at the start of `rest` (the CommonMark tag
// grammar: tag name, then attributes each preceded by whitespace, with a
// valid name and an optional = value that is unquoted, single- or
// double-quoted; a closing tag has no attributes). Returns
// { end, name } with end just past the closing >, or null.
export function scanTag(rest) {
  const n = rest.length;
  let i = 0;
  if (rest[i] !== "<") return null;
  i += 1;
  let closing = false;
  if (rest[i] === "/") { closing = true; i += 1; }
  if (i >= n || !/[A-Za-z]/.test(rest[i])) return null;
  const nameStart = i;
  i += 1;
  while (i < n && /[A-Za-z0-9-]/.test(rest[i])) i += 1;
  const name = rest.slice(nameStart, i);
  if (closing) {
    while (i < n && (rest[i] === " " || rest[i] === "\t")) i += 1;
    if (i < n && rest[i] === ">") return { end: i + 1, name };
    return null;
  }
  while (true) {
    let j = i;
    while (j < n && (rest[j] === " " || rest[j] === "\t")) j += 1;
    if (j < n && rest[j] === ">") return { end: j + 1, name };
    if (j < n && rest[j] === "/" && j + 1 < n && rest[j + 1] === ">") return { end: j + 2, name };
    if (j === i) return null; // an attribute must be preceded by whitespace
    i = j;
    if (i >= n || !/[A-Za-z_:]/.test(rest[i])) return null;
    i += 1;
    while (i < n && /[A-Za-z0-9_.:-]/.test(rest[i])) i += 1;
    const afterName = i;
    let k = i;
    while (k < n && (rest[k] === " " || rest[k] === "\t")) k += 1;
    if (k < n && rest[k] === "=") {
      k += 1;
      while (k < n && (rest[k] === " " || rest[k] === "\t")) k += 1;
      if (k < n && (rest[k] === '"' || rest[k] === "'")) {
        const q = rest[k];
        k += 1;
        while (k < n && rest[k] !== q) k += 1;
        if (k >= n) return null;
        k += 1;
      } else {
        const vStart = k;
        while (k < n && !/[ \t"'=<>`]/.test(rest[k])) k += 1;
        if (k === vStart) return null;
      }
      i = k;
    } else {
      i = afterName;
    }
  }
}

export function matchHtmlBlock(line) {
  const s = stripUpTo3(line);
  if (!s) return null;
  const rest = s.rest;
  let m;
  if ((m = /^<(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(rest))) {
    return { type: 1, endRe: new RegExp("</" + m[1], "i") };
  }
  if (rest.startsWith("<!--")) return { type: 2, endRe: /-->/ };
  if (rest.startsWith("<?")) return { type: 3, endRe: /\?>/ };
  if (rest.startsWith("<![CDATA[")) return { type: 5, endRe: /\]\]>/ };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4, endRe: />/ };
  const tag = scanTag(rest);
  if (tag) {
    if (BLOCK_TAGS.has(tag.name.toLowerCase())) return { type: 6, endRe: null };
    // Type 7 needs the complete tag to fill the line (trailing
    // whitespace aside); a tag followed by more content is not a block.
    if (/^[ \t]*$/.test(rest.slice(tag.end))) return { type: 7, endRe: null };
    return null;
  }
  // A block tag name followed by whitespace, > , /> or end of line starts
  // a type-6 block even when the tag itself spans lines.
  if ((m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|>|$)/.exec(rest))) {
    if (BLOCK_TAGS.has(m[1].toLowerCase())) return { type: 6, endRe: null };
  }
  return null;
}

// --- GFM tables ------------------------------------------------------------
// A delimiter row: cells separated by |, each cell :?-{1,}:? (after trim).
// Returns the alignment list ("left" | "right" | "center" | null) or null.
export function matchTableDelimiter(line) {
  const cells = splitTableRow(line);
  if (!cells) return null;
  const aligns = [];
  for (const c of cells) {
    const t = c.trim();
    if (/^:?-+:?$/.test(t)) {
      aligns.push(t.startsWith(":") ? (t.endsWith(":") ? "center" : "left") : (t.endsWith(":") ? "right" : null));
    } else return null;
  }
  return aligns;
}

// Split a table row on unescaped | outside code spans. Leading/trailing
// pipes produce empty edge cells, which are dropped. Returns the cell
// strings (untrimmed), or null when the row has no pipe at all.
export function splitTableRow(line) {
  if (!line.includes("|")) return null;
  const cells = [];
  let cur = "";
  let i = 0;
  const n = line.length;
  let inCode = 0;
  while (i < n) {
    const c = line[i];
    // An escaped pipe is a cell character, not a separator, and the
    // backslash is dropped (gfm-200: `\|` in a code span renders as |);
    // other escapes are kept for the inline parser.
    if (c === "\\" && i + 1 < n) {
      if (line[i + 1] === "|") { cur += "|"; i += 2; continue; }
      cur += line.slice(i, i + 2); i += 2; continue;
    }
    if (c === "`") {
      let j = i;
      while (j < n && line[j] === "`") j += 1;
      const run = j - i;
      if (inCode === run) inCode = 0;
      else if (inCode === 0) {
        // Only open a code span when a run of the same length closes it
        // later in the line (doc-06/23/27/29: `` ``next` `` has no
        // two-backtick closer, so the `|` after it still separates).
        let k = j;
        let found = false;
        while (k < n) {
          if (line[k] === "`") {
            let m = k;
            while (m < n && line[m] === "`") m += 1;
            if (m - k === run) { found = true; break; }
            k = m;
          } else k += 1;
        }
        if (found) inCode = run;
      }
      cur += line.slice(i, j);
      i = j;
      continue;
    }
    if (c === "|" && inCode === 0) { cells.push(cur); cur = ""; i += 1; continue; }
    cur += c;
    i += 1;
  }
  cells.push(cur);
  // Drop an empty first cell when the row starts with |, and an empty
  // last cell when it ends with |.
  if (cells.length > 0 && cells[0].trim() === "" && line.trimStart().startsWith("|")) cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "" && line.trimEnd().endsWith("|")) cells.pop();
  return cells;
}

// --- paragraph interruption ------------------------------------------------
// A line that can interrupt a paragraph (a new block starting while a
// paragraph is open). A setext-shaped line of -s does NOT interrupt (it is
// a setext underline); a line of *s or _s does. HTML type 7 cannot
// interrupt a paragraph; types 1-6 can. An empty list item cannot
// interrupt; an ordered item can only interrupt when it starts with 1.
export function interruptsParagraph(line, inItem) {
  if (matchAtx(line)) return true;
  if (matchFence(line)) return true;
  if (matchHr(line) && !matchSetext(line)) return true;
  const h = matchHtmlBlock(line);
  if (h && h.type !== 7) return true;
  if (/^ {0,3}>/.test(line)) return true;
  const lm = matchListMarker(line);
  if (lm && !lm.empty) {
    if (!lm.ordered) return true;
    // An ordered list interrupts a paragraph only when it starts with 1
    // (cm-304) — except inside a list item, where any ordered marker
    // starts a nested list (doc-02/04/11: `63480.` after item text).
    if (lm.num === 1 || inItem) return true;
  }
  return false;
}

// A line that starts a new block for lazy-continuation purposes (a line
// without a container marker is a lazy continuation only when it does not
// start one of these). Like interruptsParagraph, but a blockquote start
// and a list marker count here even when they could not interrupt a
// paragraph, and a setext-shaped - line counts as an hr here.
export function startsNewBlock(line) {
  if (matchAtx(line)) return true;
  if (matchFence(line)) return true;
  if (matchHr(line)) return true;
  const h = matchHtmlBlock(line);
  if (h && h.type !== 7) return true;
  if (/^ {0,3}>/.test(line)) return true;
  const lm = matchListMarker(line);
  if (lm && !lm.empty) return true;
  return false;
}

// Whether a paragraph is open after an inner line L of a container, given
// whether one was open before it and the previous inner line. Used to
// decide lazy continuation lines in blockquotes and list items.
export function innerParaAfter(line, paraOpen, prevLine) {
  if (isBlank(line)) return false;
  if (matchSetext(line)) return false;
  if (matchAtx(line) || matchFence(line)) return false;
  if (matchHr(line) && !matchSetext(line)) return false;
  const h = matchHtmlBlock(line);
  if (h && h.type !== 7) return false;
  if (h && h.type === 7) return paraOpen;
  if (/^ {0,3}>/.test(line)) return true;
  const lm = matchListMarker(line);
  if (lm) return !lm.empty;
  if (!paraOpen && indentInfo(line).cols >= 4) return false;
  // A delimiter row right after a header line closes the paragraph: the
  // two lines form a table instead. On its own it is paragraph text.
  const d = matchTableDelimiter(line);
  if (d) {
    if (paraOpen && prevLine != null && !isBlank(prevLine)) {
      const hdr = splitTableRow(prevLine);
      if (hdr && hdr.length === d.length && (prevLine.includes("|") || line.includes("|"))) return false;
    }
    return true;
  }
  return true;
}

// --- the block parser ------------------------------------------------------
// Parses lines[i0..i1) into tokens. `state` is { defs: Map } shared across
// the whole document (definitions are collected during this pass; the
// first definition for a label wins). Rendering happens afterwards, so
// references resolve even when defined after their use.

export function parseBlocks(lines, i0, i1, state, inItem) {
  const tokens = [];
  let i = i0;
  // Whether a blank line was skipped immediately before the current
  // block (used by lists to decide loose vs tight: a blank line inside a
  // nested list or blockquote must not make the outer list loose).
  let blankBefore = false;
  const push = (tok) => { tok.blankBefore = blankBefore; tokens.push(tok); blankBefore = false; };
  while (i < i1) {
    const line = lines[i];
    if (isBlank(line)) { blankBefore = true; i += 1; continue; }
    const ind = indentInfo(line);
    // Indented code block: indent 4+, plus blank lines followed by one.
    if (ind.cols >= 4) {
      const code = [];
      let j = i;
      while (j < i1) {
        const l = lines[j];
        if (isBlank(l)) {
          // Blank lines are included only when a later indented line
          // follows. A whitespace-only line indented 4+ keeps its
          // excess spaces instead of becoming empty (cm-112); leading
          // and trailing ones are dropped (cm-117).
          let k = j + 1;
          while (k < i1 && isBlank(lines[k])) k += 1;
          if (k < i1 && indentInfo(lines[k]).cols >= 4) {
            while (j < k) { code.push(indentInfo(lines[j]).cols >= 4 ? stripCodeIndent(lines[j], 4) : ""); j += 1; }
            continue;
          }
          break;
        }
        if (indentInfo(l).cols >= 4) { code.push(stripCodeIndent(l, 4)); j += 1; continue; }
        break;
      }
      push({ type: "code", lang: null, text: code.join("\n") + "\n" });
      i = j;
      continue;
    }
    const atx = matchAtx(line);
    if (atx) {
      push({ type: "heading", level: atx.level, text: atx.text });
      i += 1;
      continue;
    }
    const fence = matchFence(line);
    if (fence) {
      const code = [];
      let j = i + 1;
      while (j < i1) {
        const l = lines[j];
        // The final "" of a source ending in \n is a split artifact,
        // not a real content line: an unclosed fence running to EOF
        // must not swallow it (it would otherwise read as a blank
        // content line).
        if (j === i1 - 1 && l === "" && i1 > 1) break;
        const s = stripUpTo3(l);
        if (s) {
          const m = /^(`{3,}|~{3,})[ \t]*$/.exec(s.rest);
          if (m && m[1][0] === fence.marker && m[1].length >= fence.len) break;
        }
        code.push(stripFenceIndent(l, fence.indent));
        j += 1;
      }
      const info = fence.info.trim();
      const lang = info ? unescapeText(info.split(/\s+/)[0]) : "";
      // The code text is the content lines joined with \n, with one
      // trailing newline removed (the newline that precedes the closing
      // fence, or the document's final newline for an unclosed fence),
      // and a single trailing newline added back when non-empty.
      let text = code.join("\n");
      // The trailing newline is added back whenever the joined
      // content is non-empty — even when every content line is blank
      // (doc-12: a fence holding two blank lines renders as a single
      // newline). A fence holding a single blank line joins to "" and
      // stays empty (doc-05, doc-21).
      const hadContent = text !== "";
      if (text.endsWith("\n")) text = text.slice(0, -1);
      if (hadContent) text += "\n";
      push({ type: "code", lang, text });
      i = j + (j < i1 ? 1 : 0);
      continue;
    }
    if (matchHr(line)) {
      push({ type: "hr" });
      i += 1;
      continue;
    }
    const html = matchHtmlBlock(line);
    if (html) {
      const block = [line];
      let j = i + 1;
      if (html.type <= 5) {
        if (html.endRe.test(line)) { /* ends on its own start line */ }
        else {
          while (j < i1) {
            // The final "" of a source ending in \n is a split artifact,
            // not a real line: a block running to EOF must not swallow it.
            if (j === i1 - 1 && lines[j] === "" && i1 > 1) break;
            block.push(lines[j]);
            if (html.endRe.test(lines[j])) { j += 1; break; }
            j += 1;
          }
        }
      } else {
        while (j < i1 && !isBlank(lines[j])) { block.push(lines[j]); j += 1; }
      }
      // The block's text ends with a newline when the block's last line
      // is followed by one in the source: either another line follows, or
      // the source ends with \n (the trailing "" split artifact proves
      // it). It does not when the block was cut off by a blank line, or
      // when the lines end here with no newline after them (an inner
      // block's lines, or a source without a trailing newline). Only a
      // truly empty line cuts the newline: a whitespace-only line
      // after the block does not (doc-15: a `\t` line after a comment
      // keeps the `\n`; doc-24: a `   ` line after `</pre>` keeps it).
      const cutByBlank = j < i1 && lines[j] === "" && !(j === i1 - 1 && lines[j] === "");
      const followedByNewline = j < i1 || (i1 > 1 && lines[i1 - 1] === "");
      push({ type: "html", text: block.join("\n") + (!cutByBlank && followedByNewline ? "\n" : "") });
      i = j;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const q = collectQuote(lines, i, i1);
      push({ type: "blockquote", children: parseBlocks(q.inner, 0, q.inner.length, state, inItem) });
      i = q.next;
      continue;
    }
    const lm = matchListMarker(line);
    if (lm) {
      const lst = parseList(lines, i, i1, state);
      push(lst.token);
      if (lst.trailingBlank) blankBefore = true;
      i = lst.next;
      continue;
    }
    if (i + 1 < i1) {
      const aligns = matchTableDelimiter(lines[i + 1]);
      if (aligns) {
        const header = splitTableRow(line);
        if (header && header.length === aligns.length && (line.includes("|") || lines[i + 1].includes("|"))) {
          const tbl = parseTable(lines, i, i1, aligns, header);
          push(tbl.token);
          i = tbl.next;
          continue;
        }
      }
    }
    const base = tokens.length;
    i = parseParagraph(lines, i, i1, state, tokens, inItem);
    if (tokens.length > base) { tokens[base].blankBefore = blankBefore; blankBefore = false; }
  }
  // A blank was skipped and no block followed it (only definitions or
  // nothing): the blank separates this content from whatever follows.
  tokens.trailingBlank = blankBefore;
  return tokens;
}

// --- paragraphs ------------------------------------------------------------
// A paragraph: a run of non-blank lines that do not interrupt it. Leading
// link reference definitions are extracted first (they contribute no
// output); the rest becomes a paragraph token, or a setext heading when a
// setext underline follows the text lines. Returns the next line index.
export function parseParagraph(lines, i, i1, state, tokens, inItem) {
  // A paragraph run: non-empty lines that do not interrupt it. A
  // whitespace-only line joins the paragraph only when it is the last
  // line (cm-241: the " " line at the end of a quote is paragraph text;
  // cm-227: one followed by a blank line is not). A lazy continuation
  // line (marked \u0000 by the container collector) is paragraph text,
  // never a new block.
  let j = i;
  while (j < i1 && lines[j] !== "") {
    if (j > i && !lines[j].startsWith("\u0000") && interruptsParagraph(lines[j], inItem)) break;
    if (j > i && /^[ \t]+$/.test(lines[j]) && j !== i1 - 1) break;
    j += 1;
  }
  const clean = (l) => (l.startsWith("\u0000") ? l.slice(1) : l);
  const runText = lines.slice(i, j).map(clean).join("\n");
  let pos = 0;
  let consumedLines = 0;
  while (true) {
    const d = parseDefFromText(runText, pos);
    if (!d) break;
    const key = normalizeLabel(d.label);
    if (!state.defs.has(key)) state.defs.set(key, { href: d.href, title: d.title });
    consumedLines += 1 + (runText.slice(pos, d.end).match(/\n/g) || []).length;
    pos = d.end;
    if (runText[pos] === "\n") pos += 1;
    else break;
  }
  let k = i + consumedLines;
  // A setext-shaped line with no text before it is a thematic break, not
  // a setext underline — but only when definitions were actually consumed
  // above (k > i); with no definitions the line is the paragraph's own
  // first line of text, and returning k here would loop forever.
  if (k > i && k < j && matchSetext(clean(lines[k])) === 2) return k;
  if (k >= j) return k;
  // Setext heading: the first underline after the text lines.
  let m = k + 1;
  while (m < j) {
    const lv = matchSetext(clean(lines[m]));
    if (lv) {
      const text = lines.slice(k, m).map(clean).join("\n").replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
      tokens.push({ type: "heading", level: lv, text });
      return m + 1;
    }
    m += 1;
  }
  tokens.push({ type: "paragraph", text: lines.slice(k, j).map(clean).join("\n") });
  return j;
}

// --- blockquotes -----------------------------------------------------------
// Collects the lines of a blockquote starting at i: lines with a > marker
// (marker + one optional space stripped), blank lines, and lazy
// continuation lines (a paragraph is open inside and the line starts no
// new block). The inner lines are returned verbatim otherwise.
// Strip a blockquote marker from a line: 0-3 columns of indent, ">",
// and one optional space or tab. The content is placed at the column it
// occupies relative to the quote's content column (marker + one space),
// with tabs expanded from their real columns (cm-006). Returns the inner
// line, or null when the line has no marker.
export function stripQuoteMarker(line) {
  let i = 0;
  let cols = 0;
  while (i < line.length && cols < 3 && (line[i] === " " || line[i] === "\t")) {
    cols += line[i] === "\t" ? 4 - (cols % 4) : 1;
    i += 1;
  }
  if (line[i] !== ">") return null;
  const indent = cols;
  i += 1;
  let colAfter = indent + 1;
  let rest = line.slice(i);
  if (rest.startsWith(" ")) { rest = rest.slice(1); colAfter += 1; }
  else if (rest.startsWith("\t")) { rest = rest.slice(1); colAfter += 4 - ((indent + 1) % 4); }
  const pad = Math.max(0, colAfter - (indent + 2));
  return " ".repeat(pad) + expandLeadingTabsAt(rest, colAfter);
}

export function collectQuote(lines, i, i1) {
  const inner = [];
  let j = i;
  let paraOpen = false;
  let prevInner = null;
  // A fenced code block open inside the quote: a lazy (unmarked) line
  // does not continue it — it ends the quote (doc-05/01/14/21/34/36/40).
  // (Inside a list item a lazy line does continue a fence; that is
  // collectItem, which does not track fences.)
  let inFence = null;
  const isFenceClose = (text) => {
    if (!inFence) return false;
    const s = stripUpTo3(text);
    if (!s) return false;
    const m = /^(`{3,}|~{3,})[ \t]*$/.exec(s.rest);
    return !!m && m[1][0] === inFence.marker && m[1].length >= inFence.len;
  };
  while (j < i1) {
    const line = lines[j];
    if (line.startsWith("\u0000")) {
      // Already a lazy continuation line from an outer container: it is
      // paragraph text at every level, so pass it through unchanged
      // (cm-250, cm-251, cm-292, cm-293).
      inner.push(line);
      prevInner = line.slice(1);
      paraOpen = true;
      j += 1;
      continue;
    }
    const stripped = stripQuoteMarker(line);
    if (stripped !== null) {
      inner.push(stripped);
      if (isFenceClose(stripped)) inFence = null;
      else if (!inFence) {
        const f = matchFence(stripped);
        if (f) inFence = { marker: f.marker, len: f.len };
      }
      paraOpen = innerParaAfter(stripped, paraOpen, prevInner);
      prevInner = stripped;
      j += 1;
      continue;
    }
    if (isBlank(line)) break; // an unmarked blank line ends the quote (cm-242)
    if (inFence) {
      // A lazy closing fence still closes it; any other unmarked line
      // ends the quote (and the unclosed fence with it).
      if (isFenceClose(line)) { inner.push(line); inFence = null; j += 1; continue; }
      break;
    }
    if (paraOpen && !startsNewBlock(line) && !matchListMarker(line)) {
      // A lazy continuation line: paragraph text, never a new block. It
      // is dedented by 4 columns and marked (\u0000) so the inner parse
      // keeps it as paragraph text; a setext-shaped line is indented by
      // 4 so it cannot become a setext underline (cm-093, cm-238).
      let t = stripCols(line, 4);
      if (matchSetext(t)) t = "    " + t;
      inner.push("\u0000" + t);
      prevInner = t;
      j += 1;
      continue;
    }
    break;
  }
  while (inner.length > 0 && inner[inner.length - 1] === "") inner.pop();
  return { inner, next: j };
}

// --- lists -----------------------------------------------------------------
// Collects one list item's lines starting at the marker line j. Lines
// indented to the item's content column are stripped to it; blank lines
// are included provisionally; other lines are lazy continuations (dedented
// by the content column, per the list-item rule) while a paragraph is open
// inside. An item that is still empty when a blank line arrives ends there.
export function collectItem(lines, j, i1, marker) {
  const contentCol = marker.contentCol;
  const inner = [marker.content];
  let paraOpen = marker.content.trim() !== "";
  let prevInner = marker.content;
  let k = j + 1;
  let sawContent = paraOpen;
  while (k < i1) {
    const line = lines[k];
    if (line.startsWith("\u0000")) {
      // Already a lazy continuation line from an outer container: it is
      // paragraph text at every level, so pass it through unchanged.
      inner.push(line);
      prevInner = line.slice(1);
      paraOpen = true;
      sawContent = true;
      k += 1;
      continue;
    }
    if (isBlank(line)) {
      if (!sawContent) break; // an empty item ends at the first blank line
      inner.push("");
      paraOpen = false;
      prevInner = "";
      k += 1;
      continue;
    }
    const ind = indentInfo(line);
    if (ind.cols >= contentCol) {
      const stripped = stripCols(line, contentCol);
      inner.push(stripped);
      paraOpen = innerParaAfter(stripped, paraOpen, prevInner);
      prevInner = stripped;
      sawContent = true;
      k += 1;
      continue;
    }
    if (paraOpen && !startsNewBlock(line) && !matchListMarker(line)) {
      // A lazy continuation line: paragraph text, never a new block
      // (cm-312). Marked (\u0000) so the inner parse keeps it as
      // paragraph text, and a setext-shaped line is indented so it
      // cannot become a setext underline. (An empty list marker is
      // never lazy: it starts a new, empty item — cm-281, cm-283.)
      // A lazy line indented 4+ is dedented by the content column
      // (cm-291, cm-312: `    with...` / `    - e` lose their
      // spaces); a lazy line indented under 4 keeps its leading
      // spaces verbatim (doc-06/22/26/38: `   Naïve...` stays
      // indented).
      let stripped;
      if (indentInfo(line).cols >= 4) {
        stripped = stripCols(line, contentCol);
      } else {
        stripped = line;
      }
      if (matchSetext(stripped)) stripped = "    " + stripped;
      inner.push("\u0000" + stripped);
      prevInner = stripped;
      k += 1;
      continue;
    }
    break;
  }
  let hadTrailingBlank = false;
  // Only empty lines are popped: a whitespace-only line can be paragraph
  // text (cm-241), and an empty item's own content line is not a trailing
  // blank (cm-282).
  while (inner.length > 1 && inner[inner.length - 1] === "") { inner.pop(); hadTrailingBlank = true; }
  return { inner, next: k, hadTrailingBlank };
}

// Parses a list starting at i. Items are markers of the same kind (same
// bullet character, or ordered with the same delimiter) at any indent
// 0-3; a marker indented to an item's content column belongs to that
// item instead (nested list). Returns { token, next }.
export function parseList(lines, i, i1, state) {
  const first = matchListMarker(lines[i]);
  const ordered = first.ordered;
  const items = [];
  let loose = false;
  let j = i;
  let prevHadTrailingBlank = false;
  while (j < i1) {
    // A line that is both a list marker and a thematic break is an hr
    // (cm-060: "* Foo\n* * *\n* Bar" is list, hr, list).
    if (matchHr(lines[j])) break;
    const lm = matchListMarker(lines[j]);
    if (!lm) break;
    if (lm.ordered !== ordered) break;
    if (ordered && lm.delim !== first.delim) break;
    if (!ordered && lm.bullet !== first.bullet) break;
    if (prevHadTrailingBlank) loose = true;
    const it = collectItem(lines, j, i1, lm);
    prevHadTrailingBlank = it.hadTrailingBlank;
    items.push({ marker: lm, lines: it.inner });
    j = it.next;
    // Skip blank lines between items (they still separate, hence loose,
    // but the next marker may continue the list).
    let b = j;
    while (b < i1 && isBlank(lines[b])) b += 1;
    if (b > j) {
      const nm = b < i1 ? matchListMarker(lines[b]) : null;
      if (nm && nm.ordered === ordered && (!ordered ? nm.bullet === first.bullet : nm.delim === first.delim)) {
        loose = true;
        j = b;
      } else {
        j = b;
      }
    }
  }
  // An item is loose when any of its direct children after the first is
  // preceded by a blank line at this level; a blank line inside a nested
  // list or blockquote does not count (cm-262, cm-307, cm-319).
  const parsedItems = items.map((it, idx) => {
    const children = parseBlocks(it.lines, 0, it.lines.length, state, true);
    if (children.slice(1).some((c) => c.blankBefore)) loose = true;
    // A blank at the end of an item (before only a definition or nothing)
    // separates it from the next item (cm-317); an empty item has no
    // children, so its own content line is not a separator (cm-281/282).
    if (children.trailingBlank && idx < items.length - 1 && children.length > 0) loose = true;
    return { children };
  });
  const token = {
    type: "list", ordered, start: first.num, delim: first.delim, loose,
    items: parsedItems,
  };
  // A trailing blank inside the last item was consumed by the item and
  // separates this list from whatever follows at the outer level.
  return { token, next: j, trailingBlank: prevHadTrailingBlank };
}

// --- tables ----------------------------------------------------------------
// Body rows run until a blank line or a line that starts a new block. A
// row without pipes is a single-cell row. Extra cells are dropped and
// missing cells padded when rendering.
export function parseTable(lines, i, i1, aligns, header) {
  const rows = [];
  let j = i + 2;
  // A row line is any line that is not empty and not spaces-only: a
  // whitespace-only line holding a tab is an empty row (doc-02), while
  // a spaces-only line ends the table (doc-05).
  while (j < i1 && lines[j] !== "" && !/^[ ]+$/.test(lines[j]) && !startsNewBlock(lines[j])) {
    const cells = splitTableRow(lines[j]);
    rows.push(cells || [lines[j]]);
    j += 1;
  }
  return { token: { type: "table", aligns, header, rows }, next: j };
}

// --- rendering -------------------------------------------------------------
// Renders a token tree to HTML. `ctx` is the inline context built from
// the complete definition map (see parse.js).

export function renderBlocks(tokens, ctx) {
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "paragraph":
        out += "<p>" + parseInline(t.text, ctx) + "</p>\n";
        break;
      case "heading":
        out += "<h" + t.level + ">" + parseInline(t.text, ctx) + "</h" + t.level + ">\n";
        break;
      case "code": {
        const langAttr = t.lang ? ' class="language-' + escapeText(t.lang) + '"' : "";
        out += "<pre><code" + langAttr + ">" + escapeCode(t.text) + "</code></pre>\n";
        break;
      }
      case "html":
        out += t.text;
        break;
      case "hr":
        out += "<hr>\n";
        break;
      case "blockquote":
        out += "<blockquote>\n" + renderBlocks(t.children, ctx) + "</blockquote>\n";
        break;
      case "list":
        out += renderList(t, ctx);
        break;
      case "table":
        out += renderTable(t, ctx);
        break;
    }
  }
  return out;
}

function alignAttr(a) {
  return a ? ' align="' + a + '"' : "";
}

export function renderTable(t, ctx) {
  let out = "<table>\n<thead>\n<tr>\n";
  for (let c = 0; c < t.header.length; c += 1) {
    out += "<th" + alignAttr(t.aligns[c]) + ">" + parseInline(t.header[c].trim(), ctx) + "</th>\n";
  }
  out += "</tr>\n</thead>\n";
  if (t.rows.length > 0) {
    out += "<tbody>";
    for (const row of t.rows) {
      out += "<tr>\n";
      for (let c = 0; c < t.header.length; c += 1) {
        const cell = c < row.length ? row[c] : "";
        out += "<td" + alignAttr(t.aligns[c]) + ">" + parseInline(cell.trim(), ctx) + "</td>\n";
      }
      out += "</tr>\n";
    }
    out += "</tbody>";
  }
  out += "</table>\n";
  return out;
}

// --- lists (rendering) -----------------------------------------------------
// Tight lists render paragraph children without <p> wrappers; loose lists
// wrap them. A task item is one whose first paragraph starts with
// "[ ] " / "[x] " / "[X] ": the checkbox is rendered before the rest of
// that paragraph's text (inside the <p> for loose lists, directly in the
// <li> for tight ones).
export function renderList(t, ctx) {
  const tag = t.ordered ? "ol" : "ul";
  const startAttr = t.ordered && t.start !== 1 ? ' start="' + t.start + '"' : "";
  let out = "<" + tag + startAttr + ">\n";
  for (const item of t.items) {
    let children = item.children;
    let checkbox = "";
    if (children.length > 0 && children[0].type === "paragraph") {
      const m = /^\[([ xX])\] /.exec(children[0].text);
      if (m) {
        checkbox = m[1] === " "
          ? '<input disabled="" type="checkbox">'
          : '<input checked="" disabled="" type="checkbox">';
        children = [{ type: "paragraph", text: children[0].text.slice(4) }].concat(children.slice(1));
      }
    }
    out += "<li>";
    for (let c = 0; c < children.length; c += 1) {
      const child = children[c];
      if (c === 0 && checkbox) {
        if (child.type === "paragraph" && !t.loose) {
          out += checkbox + " " + parseInline(child.text, ctx);
        } else if (child.type === "paragraph") {
          out += "<p>" + checkbox + " " + parseInline(child.text, ctx) + "</p>\n";
        } else {
          out += checkbox + " " + renderBlocks([child], ctx);
        }
        continue;
      }
      if (child.type === "paragraph" && !t.loose) {
        out += parseInline(child.text, ctx);
      } else {
        out += renderBlocks([child], ctx);
      }
    }
    out += "</li>\n";
  }
  out += "</" + tag + ">\n";
  return out;
}
