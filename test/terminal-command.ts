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
export const TERMINAL_COMMAND =
  /\bamp\s+[a-z]|\bnode\s+src\/|\bnpm\s+(?:run|test|start)\b|\bgit\s+(?:clone|pull|push)\b|openssl/;
