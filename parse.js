// parse.js — entry point for the markdown-render-speed-02 entry.
// Dependency-free ES module. parse(markdown) returns exactly the HTML
// that marked 18.1.3's marked.parse(markdown) returns with marked's
// default options (gfm true, breaks false, pedantic false, async false).
//
// Two phases: the block parser (blocks.js) walks the document once,
// building a token tree and collecting every link reference definition
// (first definition wins, wherever it appears); the renderer then renders
// the tokens with the complete definition map, so a reference resolves
// even when its definition comes after its use. Inline rendering is
// inline.js (parseInline).

import { parseBlocks, renderBlocks } from "./blocks.js";
import { createInlineContext } from "./inline.js";

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const state = { defs: new Map() };
  const tokens = parseBlocks(lines, 0, lines.length, state);
  const ctx = createInlineContext(state.defs);
  return renderBlocks(tokens, ctx);
}

export default parse;
