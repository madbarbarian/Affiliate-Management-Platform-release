/**
 * Source hygiene: every tracked source file has to stay searchable.
 *
 * A raw control byte inside a regex character class — `[<NUL>-<0x1f><DEL>]`
 * written with the bytes themselves instead of `\u0000-\u001f\u007f` — makes
 * `file` report the whole file as `data`, and `grep` and `rg` then treat it as
 * binary and return nothing. The file is not broken; it is invisible. That
 * happened to `src/kernel/exploration.ts`, and it cost a code sweep that
 * silently skipped it and reported the sweep as complete.
 *
 * The escaped form compiles to exactly the same regex, so there is no reason
 * to ever write the bytes bare.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Tab, line feed and carriage return are the only control bytes source may hold. */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]);

const SEARCHED_DIRECTORIES = ["src", "test", "scripts", "prompts"];
const SEARCHED_EXTENSIONS = [".ts", ".md", ".json", ".yaml", ".yml", ".mjs"];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (SEARCHED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      found.push(path);
    }
  }
  return found;
}

function firstControlByte(path: string): { offset: number; byte: number } | undefined {
  const bytes = readFileSync(path);
  for (let offset = 0; offset < bytes.length; offset++) {
    const byte = bytes[offset]!;
    const isControl = byte < 0x20 || byte === 0x7f;
    if (isControl && !ALLOWED_CONTROL_BYTES.has(byte)) return { offset, byte };
  }
  return undefined;
}

test("no source file holds a raw control byte, so grep can read all of them", () => {
  const offenders: string[] = [];
  for (const dir of SEARCHED_DIRECTORIES) {
    for (const path of sourceFiles(dir)) {
      const hit = firstControlByte(path);
      if (hit) {
        const hex = `0x${hit.byte.toString(16).padStart(2, "0")}`;
        offenders.push(`${path} holds ${hex} at byte ${hit.offset}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Write the byte as an escape (\\u0000-\\u001f\\u007f) instead of putting it in the file. ` +
      `A file with a raw control byte is reported as binary and grep skips it silently:\n` +
      offenders.join("\n"),
  );
});

test("the sweep actually looked at files, so an empty pass means something", () => {
  // Without this, a wrong directory name or extension list would make the test
  // above pass by searching nothing at all.
  for (const dir of SEARCHED_DIRECTORIES) {
    assert.ok(sourceFiles(dir).length > 0, `${dir} matched no files — the search is misconfigured`);
  }
});
