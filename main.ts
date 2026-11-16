// Driver for markdown-render-speed-02.
// Reads the case list, renders each markdown string on its own with
// parse() from parse.js, and writes the HTML strings back out in the
// same order. Runs under Node 22, which strips the type annotations
// below (erasable syntax only — no enums or namespaces).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

type Case = { id: string; markdown: string };

const cases = JSON.parse(
  readFileSync(join(inputDir, "cases.json"), "utf8"),
) as Case[];

const out: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  out[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(out));
