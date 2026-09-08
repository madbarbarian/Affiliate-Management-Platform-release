/**
 * A deliberately small YAML reader.
 *
 * Config is the one thing that must parse before anything else works, including
 * the code that would report a dependency problem. Keeping the reader in-tree
 * means config errors are ours to shape - every failure points at a file, a
 * line, and what was expected there. The config subset is small and fixed, so
 * this stays a few hundred lines rather than growing into a YAML engine.
 *
 * Supported: nested mappings, sequences (block and flow), quoted and plain
 * scalars, numbers, booleans, null, block scalars (`|`, `|-`, `>`, `>-`),
 * comments, and a single leading `---`.
 *
 * Not supported (and rejected loudly rather than mis-parsed): anchors and
 * aliases, tags, multiple documents, complex keys, tab indentation.
 */

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`YAML error on line ${line}: ${message}`);
    this.name = "YamlError";
    this.line = line;
  }
}

type RawLine = {
  readonly indent: number;
  readonly content: string;
  readonly raw: string;
  readonly lineNo: number;
};

type Cursor = { lines: RawLine[]; index: number };

const KEY_RE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^:#]+?))\s*:(?:\s+(.*))?$/;

export function parseYaml(source: string): unknown {
  const lines = tokenize(source);
  const cursor: Cursor = { lines, index: 0 };
  skipBlanks(cursor);
  if (cursor.index >= cursor.lines.length) return {};
  const value = parseBlock(cursor, cursor.lines[cursor.index]!.indent);
  skipBlanks(cursor);
  if (cursor.index < cursor.lines.length) {
    const line = cursor.lines[cursor.index]!;
    throw new YamlError(`unexpected content "${line.content}"`, line.lineNo);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

function tokenize(source: string): RawLine[] {
  const out: RawLine[] = [];
  const rawLines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i] as string;
    const lineNo = i + 1;
    if (raw.includes("\t") && /^\s*\t/.test(raw)) {
      throw new YamlError("tab indentation is not allowed, use spaces", lineNo);
    }
    const stripped = stripComment(raw);
    const trimmed = stripped.trimEnd();
    const indent = trimmed.length === 0 ? 0 : countIndent(trimmed);
    const content = trimmed.trim();
    if (content === "---") continue;
    if (content === "...") continue;
    out.push({ indent, content, raw, lineNo });
  }
  return out;
}

function countIndent(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n += 1;
  return n;
}

/** Removes `#` comments that are outside quotes and preceded by whitespace. */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"' && ch === "\\") {
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function skipBlanks(cursor: Cursor): void {
  while (cursor.index < cursor.lines.length && cursor.lines[cursor.index]!.content === "") {
    cursor.index += 1;
  }
}

function peek(cursor: Cursor): RawLine | undefined {
  let i = cursor.index;
  while (i < cursor.lines.length && cursor.lines[i]!.content === "") i += 1;
  return cursor.lines[i];
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function parseBlock(cursor: Cursor, indent: number): unknown {
  const line = peek(cursor);
  if (!line || line.indent < indent) return null;
  if (line.indent > indent) {
    throw new YamlError(`unexpected indentation (expected ${indent}, got ${line.indent})`, line.lineNo);
  }
  return isSequenceEntry(line.content)
    ? parseSequence(cursor, indent)
    : parseMapping(cursor, indent);
}

function isSequenceEntry(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

function parseMapping(cursor: Cursor, indent: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (;;) {
    skipBlanks(cursor);
    const line = cursor.lines[cursor.index];
    if (!line || line.indent !== indent) break;
    if (isSequenceEntry(line.content)) break;

    const match = KEY_RE.exec(line.content);
    if (!match) throw new YamlError(`expected "key: value", got "${line.content}"`, line.lineNo);
    const key = (match[1] ?? match[2]?.replaceAll("''", "'") ?? match[3] ?? "").trim();
    if (key === "") throw new YamlError("empty mapping key", line.lineNo);
    if (Object.hasOwn(result, key)) throw new YamlError(`duplicate key "${key}"`, line.lineNo);
    const rest = (match[4] ?? "").trim();
    cursor.index += 1;

    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      result[key] = readBlockScalar(cursor, indent, rest);
      continue;
    }
    if (rest !== "") {
      result[key] = parseScalar(rest, line.lineNo);
      continue;
    }
    const child = peek(cursor);
    result[key] = child && child.indent > indent ? parseBlock(cursor, child.indent) : null;
  }
  return result;
}

function parseSequence(cursor: Cursor, indent: number): unknown[] {
  const result: unknown[] = [];
  for (;;) {
    skipBlanks(cursor);
    const line = cursor.lines[cursor.index];
    if (!line || line.indent !== indent || !isSequenceEntry(line.content)) break;

    const rest = line.content === "-" ? "" : line.content.slice(2).trim();
    if (rest === "") {
      cursor.index += 1;
      const child = peek(cursor);
      result.push(child && child.indent > indent ? parseBlock(cursor, child.indent) : null);
      continue;
    }

    // `- key: value` starts a mapping whose remaining keys sit under the dash.
    // A quoted scalar is not that, however much `"one: two"` looks like one -
    // it used to parse as the mapping {'"one': 'two"'}, silently mangling any
    // list entry containing a colon and a space.
    const quoted = rest.startsWith('"') || rest.startsWith("'");
    if (!quoted && KEY_RE.test(rest) && !rest.startsWith("{") && !rest.startsWith("[")) {
      const nestedIndent = indent + (line.content.length - line.content.slice(2).trimStart().length);
      // Rewrite the entry as a plain line at the nested indent, then parse it
      // as a mapping so sibling keys on following lines are picked up too.
      cursor.lines[cursor.index] = {
        indent: nestedIndent,
        content: rest,
        raw: line.raw,
        lineNo: line.lineNo,
      };
      result.push(parseMapping(cursor, nestedIndent));
      continue;
    }

    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      cursor.index += 1;
      result.push(readBlockScalar(cursor, indent, rest));
      continue;
    }

    cursor.index += 1;
    result.push(parseScalar(rest, line.lineNo));
  }
  return result;
}

function readBlockScalar(cursor: Cursor, parentIndent: number, marker: string): string {
  const literal = marker.startsWith("|");
  const chomp = marker.endsWith("-");
  const collected: string[] = [];
  let blockIndent = -1;

  while (cursor.index < cursor.lines.length) {
    const line = cursor.lines[cursor.index]!;
    const isBlank = line.raw.trim() === "";
    if (!isBlank) {
      const actualIndent = countIndent(line.raw);
      if (actualIndent <= parentIndent) break;
      if (blockIndent === -1) blockIndent = actualIndent;
      collected.push(line.raw.slice(blockIndent));
    } else {
      collected.push("");
    }
    cursor.index += 1;
  }

  while (collected.length > 0 && collected.at(-1) === "") collected.pop();

  let text: string;
  if (literal) {
    text = collected.join("\n");
  } else {
    // Folded: single newlines become spaces, blank lines become newlines.
    const parts: string[] = [];
    let buffer = "";
    for (const entry of collected) {
      if (entry === "") {
        parts.push(buffer);
        buffer = "";
      } else {
        buffer = buffer === "" ? entry : `${buffer} ${entry}`;
      }
    }
    parts.push(buffer);
    text = parts.join("\n");
  }
  return chomp ? text : `${text}\n`;
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

function parseScalar(raw: string, lineNo: number): unknown {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE" || text === "yes") return true;
  if (text === "false" || text === "False" || text === "FALSE" || text === "no") return false;

  if (text.startsWith('"')) return unquoteDouble(text, lineNo);
  if (text.startsWith("'")) return unquoteSingle(text, lineNo);
  if (text.startsWith("[")) return parseFlowSequence(text, lineNo);
  if (text.startsWith("{")) return parseFlowMapping(text, lineNo);
  if (text.startsWith("&") || text.startsWith("*") || text.startsWith("!")) {
    throw new YamlError("anchors, aliases and tags are not supported", lineNo);
  }

  if (/^[+-]?(\d[\d_]*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
    const numeric = Number(text.replaceAll("_", ""));
    if (!Number.isNaN(numeric)) return numeric;
  }
  return text;
}

function unquoteDouble(text: string, lineNo: number): string {
  if (text.length < 2 || !text.endsWith('"')) {
    throw new YamlError(`unterminated double-quoted string ${text}`, lineNo);
  }
  const inner = text.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    i += 1;
    const escaped = inner[i];
    switch (escaped) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "0": out += "\0"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "/": out += "/"; break;
      default:
        throw new YamlError(`unsupported escape "\\${escaped ?? ""}"`, lineNo);
    }
  }
  return out;
}

function unquoteSingle(text: string, lineNo: number): string {
  if (text.length < 2 || !text.endsWith("'")) {
    throw new YamlError(`unterminated single-quoted string ${text}`, lineNo);
  }
  return text.slice(1, -1).replaceAll("''", "'");
}

/** Splits a flow collection body on top-level commas. */
function splitFlow(body: string, lineNo: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (quote === '"' && ch === "\\") {
      current += ch + (body[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote) throw new YamlError("unterminated string in flow collection", lineNo);
  if (depth !== 0) throw new YamlError("unbalanced brackets in flow collection", lineNo);
  if (current.trim() !== "") parts.push(current);
  return parts;
}

function parseFlowSequence(text: string, lineNo: number): unknown[] {
  if (!text.endsWith("]")) throw new YamlError(`unterminated flow sequence ${text}`, lineNo);
  const body = text.slice(1, -1).trim();
  if (body === "") return [];
  return splitFlow(body, lineNo).map((part) => parseScalar(part, lineNo));
}

function parseFlowMapping(text: string, lineNo: number): Record<string, unknown> {
  if (!text.endsWith("}")) throw new YamlError(`unterminated flow mapping ${text}`, lineNo);
  const body = text.slice(1, -1).trim();
  const result: Record<string, unknown> = {};
  if (body === "") return result;
  for (const part of splitFlow(body, lineNo)) {
    const separator = findFlowColon(part);
    if (separator === -1) throw new YamlError(`expected "key: value" in flow mapping, got "${part}"`, lineNo);
    const key = part.slice(0, separator).trim().replace(/^["']|["']$/g, "");
    result[key] = parseScalar(part.slice(separator + 1), lineNo);
  }
  return result;
}

function findFlowColon(part: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < part.length; i += 1) {
    const ch = part[i];
    if (quote === '"' && ch === "\\") {
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ":") return i;
  }
  return -1;
}
