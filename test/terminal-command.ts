/**
 * What a licensee cannot be told to do.
 *
 * `docs/1-requirements/requirements.md` §3.1: the licensee has no terminal.
 * Copy that reads "type this" is not merely unhelpful to the only person who
 * sees it - it is a dead end, and it hides whatever the screen, the config
 * file or the dashboard could actually have told them to do.
 *
 * This lives in its own file rather than in either test that uses it because
 * the console and the design canvases are the same promise in two places: the
 * console is the screen a licensee gets, and the canvases are the picture of
 * that screen, and they ship together. Two copies of this pattern would drift,
 * and the drift would show up as a canvas that still says what the console
 * stopped saying. Not a `.test.ts` file: `npm test` globs those, and a file
 * with no tests in it would be run as one.
 */
// `wrangler` and `ssh` get the same treatment as `amp`: a bare word plus a
// lowercase word after it, because both are unambiguous outside a terminal
// (nobody writes "wrangler" or "ssh" as ordinary prose) but appear constantly
// in this codebase's own comments as `wrangler.jsonc`, `wrangler's build`,
// or similar - forms with no whitespace right after the word, so the
// `\s+[a-z]` requirement passes over them without an exception list.
//
// `curl` cannot use that shape: unlike `wrangler`, it is an ordinary English
// word ("a curl of smoke"), and "curl of hair" would otherwise match
// `\bcurl\s+[a-z]`. It is required to be followed by a flag or a URL instead
// - the two forms every real `curl` invocation in this repository's own docs
// actually takes (`docs/4-operations/deploy-checklist.md`).
export const TERMINAL_COMMAND =
  /\bamp\s+[a-z]|\bnode\s+src\/|\bnpm\s+(?:run|test|start)\b|\bgit\s+(?:clone|pull|push)\b|openssl|\bwrangler\s+[a-z]|\bssh\s+[a-z]|\bcurl\s+(?:-|https?:)/;
