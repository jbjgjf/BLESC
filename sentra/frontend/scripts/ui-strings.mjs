// Finds user-facing text in the frontend so it can be checked for language.
//
// The product ships in Japanese (#116). The risk this guards against is not a
// missing translation file but an English string typed straight into a new
// screen, which is invisible in review and only shows up in front of a class.
//
// This is a lint, not a parser. It blanks out the parts of a `.tsx` file that
// are addressed to the machine — comments, imports, class names, style objects,
// URLs, DOM attributes — and reads what is left. Anything it cannot classify is
// reported rather than assumed to be fine: a false positive costs one
// allowlist entry, a false negative ships English to a school.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/** Attributes whose value is written for the machine, not for a reader. */
const MACHINE_ATTRIBUTES = [
  "className",
  "style",
  "href",
  "src",
  "key",
  "role",
  "id",
  "name",
  "type",
  "htmlFor",
  "rel",
  "target",
  "method",
  "action",
  "fill",
  "stroke",
  "viewBox",
  "d",
  "xmlns",
  "charSet",
  "encType",
  "autoComplete",
  "inputMode",
  "accept",
];

/** Supabase query builders: their arguments name tables and columns. */
const DATA_CALLS = ["from", "select", "eq", "neq", "gte", "lte", "gt", "lt", "in", "order", "contains", "match", "like", "ilike"];

const JAPANESE = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;
/** Two or more consecutive Latin letters — enough to be a word, not a unit. */
const LATIN_WORD = /[A-Za-z]{2,}/g;
/** Punctuation that only appears in code, never in a sentence on screen. */
const CODE_FRAGMENT = /;|=>|&&|\?\?|===|!==|\)\s*:|^\s*:\s|^\s*return\s*\(/;

/**
 * Shapes that are always an identifier rather than copy: paths, MIME types,
 * CSS custom properties and utility classes, event and field names, hex and
 * numeric formats. Written as one list so a new exclusion is a visible edit.
 */
const IDENTIFIER_SHAPES = [
  /^[a-z0-9]+([-_.][a-z0-9]+)+$/i, // dot.path, snake_case, kebab-case
  /^[\w.-]+\/[\w./*-]+$/, // paths and MIME types
  /^\//, // an absolute path: a route or an endpoint, never a sentence
  /^--/, // CSS custom properties
  /^[a-z]+\([^)]*\)$/i, // var(--x), rgb(...), translateY(...)
  /^#[0-9a-f]{3,8}$/i,
  /^[\d\s.,%:+-]+$/, // numbers, times, percentages
  /^https?:/,
  /^[a-z][\w]*(,\s*[a-z][\w]*)+$/i, // column lists in a `select(...)`
  /^use (client|server)$/, // React directive prologue
  /^\[[\w.:-]+\]/, // "[supabase-sync] …" — a log tag, never a sentence on screen
  /var\(--/, // any CSS value referring to a design token
  /^[\d.]+(px|rem|em|pt|vh|vw|%)\b/, // CSS lengths: "1px solid", "500 22px Arial"
  /^\d+\s+[\d.]+(px|rem|em|pt)\b/,
];

/** Interpolations carry no copy, and their code would read as words. */
const INTERPOLATION = /\$\{[^}]*\}/g;

/**
 * Modules whose English is addressed to the machine, with the reason. A file
 * belongs here only when *every* string in it is machine-facing; a module that
 * mixes copy and identifiers keeps its entries in the allowlist instead, where
 * each one is visible.
 */
export const MACHINE_MODULES = {
  "src/lib/safety-assessment.ts": "Bilingual detection lexicons — the English is input to match on, never shown.",
  "src/lib/supabase/client.ts": "Supabase wiring.",
  "src/lib/server/api.ts": "Server-side request helpers.",
  "src/lib/motion.ts": "Animation curve names.",
  "src/lib/blesc/petal.ts": "Petal geometry.",
};

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) yield path;
  }
}

const blank = (match) => " ".repeat(match.length);

/**
 * Replaces machine-facing regions with spaces of the same length, so the
 * offsets of what remains still point at the right line.
 */
function blankMachineText(source) {
  let out = source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
    .replace(/^\s*import[\s\S]*?;$/gm, blank)
    .replace(/^\s*export \* from [^\n]*$/gm, blank)
    .replace(/\bdata-[\w-]+=(?:"[^"]*"|'[^']*'|\{[^{}]*\})/g, blank)
    .replace(/\baria-(?:hidden|live|modal|expanded|current|controls|describedby|labelledby)=(?:"[^"]*"|\{[^{}]*\})/g, blank);

  // Console output and database calls are addressed to a developer or to
  // Postgres. Blanked by call rather than by string so a new log line does not
  // need an allowlist entry to be understood as a log line.
  out = out.replace(/\bconsole\.\w+\((?:[^()]|\([^()]*\))*\)/g, blank);
  for (const method of DATA_CALLS) {
    out = out.replace(new RegExp(`\\.${method}\\((?:[^()]|\\([^()]*\\))*\\)`, "g"), blank);
  }

  for (const attribute of MACHINE_ATTRIBUTES) {
    out = out.replace(new RegExp(`\\b${attribute}=(?:"[^"]*"|'[^']*'|\`[^\`]*\`)`, "g"), blank);
    out = blankBracedAttribute(out, attribute);
  }

  return out;
}

/**
 * Blanks `attr={ … }` by counting braces. A `className` can nest a template
 * literal inside an index inside a template literal, so a fixed-depth pattern
 * runs out before the value does.
 */
function blankBracedAttribute(source, attribute) {
  const opener = new RegExp(`\\b${attribute}=\\{`, "g");
  let out = source;
  let match;
  while ((match = opener.exec(out)) !== null) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < out.length; end += 1) {
      if (out[end] === "{") depth += 1;
      else if (out[end] === "}" && --depth === 0) break;
    }
    if (end >= out.length) break;
    out = out.slice(0, match.index) + " ".repeat(end + 1 - match.index) + out.slice(end + 1);
    opener.lastIndex = end + 1;
  }
  return out;
}

/** Removes JSX expressions and TypeScript generics from a machine-blanked file. */
function blankExpressions(source) {
  let out = source;

  // `{...}` inside JSX is code, so `{count} 件` should report ` 件` and not the
  // expression. Only brace groups that hold no markup are blanked, and the pass
  // repeats so nested calls collapse from the inside out. A group containing
  // `<` is left alone: `{ready && <p>本文</p>}` still has to be read.
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(/\{[^{}<>]*\}/g, blank);
  }

  // Generic type arguments look exactly like a tag pair with text inside, so
  // `useState<Entry | null>(null)` would otherwise report ` | null` as copy.
  // A generic's `<` follows an identifier; a JSX tag's never does.
  for (let previous = ""; previous !== out; ) {
    previous = out;
    out = out.replace(/(?<=[A-Za-z0-9_$])<[^<>]*>/g, blank);
  }

  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** HTML entities end in `;`, which would otherwise read as a statement. */
const HTML_ENTITY = /&[a-z]+;|&#\d+;/gi;

/** True when the text reads as copy rather than as an identifier. */
function looksLikeCopy(text, kind) {
  if (CODE_FRAGMENT.test(text.replace(HTML_ENTITY, " "))) return false;
  // An id built from a template — `demo-entry-${n}` — is the same shape as one
  // written out, so the shapes are tried against the interpolation-free form as
  // well. Prose is unaffected: "こんにちは、${name}さん" matches none of them.
  const withoutInterpolation = text.replace(INTERPOLATION, "0");
  if (IDENTIFIER_SHAPES.some((shape) => shape.test(text) || shape.test(withoutInterpolation))) return false;

  const words = text.replace(INTERPOLATION, " ").match(LATIN_WORD) ?? [];
  // Text sitting in the markup is copy by position, so one word is enough. A
  // bare literal could be anything the code needs, so it has to read as a
  // phrase before this file will claim it belongs on screen.
  if (kind === "jsx-text") return words.length >= 1 || JAPANESE.test(text);
  return words.length >= 2 && /\s/.test(text);
}

/** Every piece of text in one file that a person could read on screen. */
export function extractStrings(source, file) {
  const found = [];
  const machineBlanked = blankMachineText(source);
  const expressionBlanked = blankExpressions(machineBlanked);
  const push = (text, index, kind) => {
    const value = text.trim();
    if (value && looksLikeCopy(value, kind)) found.push({ file, line: lineOf(source, index), kind, text: value });
  };

  // JSX text nodes: whatever sits between the end of the previous child and the
  // opening `<` of the next tag. The previous child may be an expression, so a
  // closing `}` opens a run of text as surely as a closing `>` does — the label
  // after `{icon}` was invisible while only `>` counted. The lookahead is what
  // separates a tag from a comparison: `a > 0 && b < 1` has a space after its
  // `<`, where `</p>` and `<span` do not.
  for (const match of expressionBlanked.matchAll(/[>}]([^<>{}]+)<(?=[A-Za-z/])/g)) {
    push(match[1], match.index, "jsx-text");
  }

  // Every remaining literal. Labels reach the screen through too many shapes —
  // a prop, a table of nav items, a `setError` call, a template literal — to
  // enumerate, so the sweep is by quote and the exclusions are by shape.
  // Quoted strings cannot hold a newline in JavaScript, so requiring that keeps
  // a run of code between two unrelated quotes from being read as one string.
  for (const match of machineBlanked.matchAll(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    push(match[2], match.index, "literal");
  }
  for (const match of machineBlanked.matchAll(/`((?:\\.|[^\\`])*)`/g)) {
    push(match[1], match.index, "literal");
  }

  return found;
}

/** Text that is Latin-only and therefore not yet Japanese. */
export function untranslated(strings, allowlist) {
  const allowed = new Set(allowlist);
  return strings.filter((entry) => !JAPANESE.test(entry.text) && !allowed.has(entry.text));
}

export async function scan(roots, cwd = process.cwd()) {
  const strings = [];
  for (const root of roots) {
    for await (const path of walk(join(cwd, root))) {
      const file = relative(cwd, path);
      // Route handlers answer other programs, not readers.
      if (path.includes(join("src", "app", "api"))) continue;
      if (file in MACHINE_MODULES) continue;
      strings.push(...extractStrings(await readFile(path, "utf8"), file));
    }
  }
  return strings;
}
