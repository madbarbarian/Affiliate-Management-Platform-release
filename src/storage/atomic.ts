/**
 * Write a whole file so a reader never sees half of it.
 *
 * Temp file beside the target, then rename: on POSIX the rename is atomic, so
 * the daemon reading `paused.json` or `venture-state.json` on its tick sees
 * either the old file or the new one, never a truncated one. One copy of this,
 * because the fix for whichever failure shows up next (an fsync before the
 * rename, a unique suffix) has to land in one place, not four.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let sequence = 0;

export async function writeFileAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // pid plus a counter: two writes from one process in the same tick must not
  // share a temp name, or the second rename moves a file the first already
  // consumed.
  const temp = `${path}.${process.pid}.${(sequence += 1)}.tmp`;
  await writeFile(temp, body, "utf8");
  await rename(temp, path);
}
