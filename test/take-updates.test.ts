/**
 * The updater a licensee runs: `scripts/take-updates.ts`.
 *
 * It is the one piece of this repository that rewrites a licensee's copy, and
 * it does so with `rsync --delete` and a push. The shell that starts it is
 * pinned in `test/release.test.ts`; this file is about what the script does
 * once started - the pure decisions first, then real runs against real git
 * repositories and a real rsync, with only `gh` replaced.
 *
 * The real runs import the script the way the shell would find it: the copy
 * inside the checked-out repository, which the sync then replaces while it is
 * running. Upstream's copy is different and announces itself if it ever runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BRANCH,
  ISSUE_TITLE,
  PULL_REQUEST_TITLE,
  UPDATER_COPY,
  UPSTREAM,
  issueBody,
  pullRequestBody,
  readRunner,
  rootProblem,
  rsyncArgs,
  stateSaysOpen,
  updaterChanged,
  type Runner,
} from "../scripts/take-updates.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/take-updates.ts", import.meta.url));
const SCRIPT_SOURCE = readFileSync(SCRIPT, "utf8");

const JAPANESE = /[぀-ヿ一-鿿]/;
const ENGLISH = /[A-Za-z]{4,} [A-Za-z]{4,}/;

// ---------------------------------------------------------------------------
// The decisions
// ---------------------------------------------------------------------------

test("the update leaves alone every file that belongs to the copy", () => {
  // Found by taking an update for real, into a copy the Deploy button had
  // made: wrangler.jsonc carries that copy's Worker name and the id of the
  // database the button created, and replacing it with ours took the deploy
  // down with "binding DB of type d1 must have a valid database_id". Each of
  // these exists in a licensee's repository with their values in it.
  const args = rsyncArgs("/tmp/upstream", "/work");
  const theirs: readonly (readonly [string, string])[] = [
    [".git", "the upstream clone has its own history, and copying it over would replace the copy's repository with ours"],
    [".github", "a push that writes under .github/workflows/ is refused whole, taking every other fix with it"],
    ["platform.config.yaml", "an update would overwrite their own operation"],
    ["wrangler.jsonc", "their Worker's name and database id; ours takes the deploy down"],
  ];
  for (const [path, why] of theirs) {
    assert.ok(args.includes(`--exclude=${path}`), `${path} must never be replaced from upstream: ${why}`);
  }
});

test("a same-length change is still a change, and what upstream dropped goes", () => {
  // Content decides, not size and mtime. Taking v0.6.0 into a real copy
  // delivered 26 files and skipped package.json, whose version string had
  // gone from "0.5.1" to "0.6.0" - the same length, in a checkout made seconds
  // after the other. The copy ran the new code and reported the old version.
  const args = rsyncArgs("/tmp/upstream", "/work");
  assert.ok(args.includes("--checksum"), "a same-length change is still a change");
  assert.ok(args.includes("-a"), "permissions and links come across as they are");
  assert.ok(args.includes("--delete"), "a file the platform removed has to leave the copy too");
});

test("the copy takes what is inside the clone, into the repository itself", () => {
  // Without the slash on the source, rsync copies the directory rather than
  // its contents, and the whole platform lands in a subdirectory.
  const args = rsyncArgs("/tmp/upstream", "/work");
  assert.deepEqual(args.slice(-2), ["/tmp/upstream/", "/work/"]);
  assert.deepEqual(rsyncArgs("/tmp/upstream/", "/work/").slice(-2), ["/tmp/upstream/", "/work/"], "and never two slashes");
});

test("the copy refuses a root that is not the checkout, before touching anything", () => {
  // The copy deletes whatever upstream does not have. An earlier plan ran the
  // script from a copy in /tmp, where a root worked out from the script's own
  // location is `/` - and rsync --delete would have gone to work on that.
  assert.match(
    rootProblem("/home/runner/work/copy/copy", "/tmp/upstream", false) ?? "",
    /no \.git/,
    "a directory with no .git is not the repository actions/checkout made",
  );
  assert.match(rootProblem("copy", "/tmp/upstream", true) ?? "", /not an absolute path/, "a relative root is a guess");
  assert.match(rootProblem("/tmp", "/tmp/upstream", true) ?? "", /overlap/, "the clone inside the repository");
  assert.match(rootProblem("/tmp/upstream/x", "/tmp/upstream", true) ?? "", /overlap/, "the repository inside the clone");
  assert.equal(rootProblem("/home/runner/work/copy/copy", "/tmp/upstream", true), undefined, "and a real checkout is fine");
});

test("the runner's environment is read all at once, and none of it is guessed", () => {
  const read = readRunner({});
  assert.equal(read.ok, false);
  assert.deepEqual(
    read.ok ? [] : [...read.missing].sort(),
    ["GITHUB_REF_NAME", "GITHUB_REPOSITORY", "GITHUB_SERVER_URL", "GITHUB_STEP_SUMMARY", "GITHUB_WORKSPACE"],
    "every missing name in one run, so one fix covers all of them",
  );
});

test("only the shell's own path counts as the shell changing", () => {
  // Read the way `grep -qx` read `git diff --name-only`: one whole line.
  assert.equal(updaterChanged(`README.md\n${UPDATER_COPY}\nsrc/cli.ts\n`), true);
  assert.equal(updaterChanged(`docs/${UPDATER_COPY}\n`), false, "a file elsewhere with the same name is not the shell");
  assert.equal(updaterChanged(""), false);
});

test("an open pull request is recognised the way the pipe into grep recognised it", () => {
  assert.equal(stateSaysOpen("OPEN\n"), true);
  assert.equal(stateSaysOpen("MERGED\n"), false, "a merged one does not stop a new one being opened");
  assert.equal(stateSaysOpen(""), false, "no pull request at all prints nothing");
});

/** Paragraphs, so "first" means the first thing a reader meets. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "---");
}

function assertJapaneseFirst(text: string, what: string): void {
  const parts = paragraphs(text);
  const japanese = parts.findIndex((part) => JAPANESE.test(part));
  const english = parts.findIndex((part) => !JAPANESE.test(part) && ENGLISH.test(part));
  assert.ok(japanese >= 0, `${what} has no Japanese - a Japanese licensee reads it as not written`);
  assert.ok(english >= 0, `${what} lost its English`);
  assert.ok(japanese < english, `${what} has to open in Japanese: it is what a licensee reads first`);
}

test("the pull request is Japanese first, English too, and says their config is not in it", () => {
  // The pull request is the one place a licensee decides whether to merge an
  // update, and it was the only thing they read in English: the setup screen,
  // the console and the CHANGELOG are all Japanese by default. The owner read
  // the updater section and said it did not look written - it was there, and
  // was not read.
  const body = pullRequestBody(false);
  assertJapaneseFirst(body, "the pull request");
  const [japanese = "", english = ""] = body.split("\n---\n");
  assert.ok(japanese.includes("`platform.config.yaml`"), "the Japanese part has to say their config is not touched");
  assert.ok(english.includes("`platform.config.yaml`"), "and so does the English part");
});

test("a changed shell is named in the pull request, with the one step left to a person", () => {
  // The update cannot write the shell, so its new text arrives beside it. The
  // step that remains has to be told, not attempted and lost.
  const plain = pullRequestBody(false);
  const withShell = pullRequestBody(true);
  assert.ok(withShell.startsWith(plain), "the section is added to the body, not a different body");
  const section = withShell.slice(plain.length);
  assertJapaneseFirst(section, "the section about the shell");
  assert.ok(section.includes(`\`${UPDATER_COPY}\``), "it has to name the file to copy");
  assert.ok(section.includes("`.github/workflows/take-updates.yml`"), "and where to paste it");
});

test("a refused pull request still says where the update is", () => {
  // A repository created today does not let Actions open a pull request, and
  // the push has already succeeded by then: the update is on the branch, and
  // ending red would say nothing arrived.
  const body = issueBody(runnerFor("/work", "/tmp/summary"));
  assert.ok(body.includes(`https://github.com/licensee/their-copy/compare/main...${BRANCH}`), "a link to the update itself");
  assert.ok(body.includes("Allow GitHub Actions to create and"), "and the checkbox that opens the normal path next time");
});

test("the script loads nothing but node's own modules, and nothing lazily", () => {
  // The sync replaces this script while it runs. That is safe because
  // everything it runs was loaded before it started - static imports are
  // read in full before the first line executes. A dynamic import or a
  // require is loaded on demand, after the sync, from the new version.
  //
  // By allowance, not by a list of what is forbidden: a new name has to be
  // added here on purpose. None of the fs names allowed here reads a file's
  // contents.
  const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    "node:child_process": ["execFileSync", "spawnSync"],
    "node:fs": ["appendFileSync", "existsSync", "realpathSync", "rmSync"],
    "node:path": ["isAbsolute", "join", "relative"],
    "node:url": ["fileURLToPath"],
  };
  const importLines = SCRIPT_SOURCE.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.ok(importLines.length > 0, "the sweep found no imports at all, so passing would mean nothing");
  for (const line of importLines) {
    const match = /^import \{ ([^}]+) \} from "([^"]+)";$/.exec(line);
    assert.ok(match, `${line} - keep each import to one line of named imports, so this test can read it`);
    const [, names = "", from = ""] = match;
    const allowed = ALLOWED[from];
    assert.ok(allowed, `${from}: the script may import only ${Object.keys(ALLOWED).join(", ")}`);
    for (const name of names.split(",").map((part) => part.trim())) {
      assert.ok(allowed.includes(name), `${name} from ${from} is not allowed here; see the comment above ALLOWED`);
    }
  }
  assert.equal(/\bimport\s*\(/.test(SCRIPT_SOURCE), false, "a dynamic import loads the new version's code after the sync");
  assert.equal(/\brequire\s*\(/.test(SCRIPT_SOURCE), false, "so does a require");
});

// ---------------------------------------------------------------------------
// Real runs
// ---------------------------------------------------------------------------

/** git with nothing of the person running the tests in it: no signing, no hooks, no default branch. */
const CLEAN_ENV: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("GIT_")),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const SEED_ENV: Readonly<Record<string, string>> = {
  ...CLEAN_ENV,
  GIT_AUTHOR_NAME: "Licensee",
  GIT_AUTHOR_EMAIL: "licensee@example.com",
  GIT_COMMITTER_NAME: "Licensee",
  GIT_COMMITTER_EMAIL: "licensee@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: SEED_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, "utf8");
  }
}

const UPSTREAM_MARKER = "UPSTREAM COPY OF THE SCRIPT RAN";

/** The copy as a licensee has it, script included. */
const COPY: Readonly<Record<string, string>> = {
  "package.json": '{ "type": "module", "version": "0.5.1" }\n',
  "README.md": "the copy as it was made\n",
  "stale.txt": "a file the platform has since removed\n",
  "platform.config.yaml": "niche: the licensee's own\n",
  "wrangler.jsonc": '{ "name": "their-worker", "database_id": "their-database" }\n',
  ".github/workflows/take-updates.yml": "the shell they pasted\n",
  [UPDATER_COPY]: "shell, first version\n",
  "scripts/take-updates.ts": SCRIPT_SOURCE,
};

/** The platform as published now. Its script is different, and says so if it ever runs. */
const PLATFORM: Readonly<Record<string, string>> = {
  "package.json": '{ "type": "module", "version": "0.6.0" }\n',
  "README.md": "the platform now\n",
  "platform.config.yaml": "niche: ours\n",
  "wrangler.jsonc": '{ "name": "our-worker", "database_id": "placeholder-replaced-on-first-deploy" }\n',
  ".github/workflows/sync-to-release.yml": "our own publishing workflow\n",
  [UPDATER_COPY]: "shell, first version\n",
  "scripts/take-updates.ts": `${SCRIPT_SOURCE}\nprocess.stdout.write(${JSON.stringify(`${UPSTREAM_MARKER}\n`)});\n`,
};

type Sandbox = {
  readonly dir: string;
  readonly seed: string;
  readonly origin: string;
  readonly work: string;
  readonly upstream: string;
  readonly clone: string;
  readonly summary: string;
};

/**
 * A licensee's repository as actions/checkout leaves it - a full clone of its
 * origin, every branch known - and a platform to take an update from.
 */
function sandbox(platform: Readonly<Record<string, string>>, options: { openBranch?: boolean } = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "amp-take-updates-"));
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeTree(seed, COPY);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "the copy the Deploy button made");
  if (options.openBranch) {
    git(seed, "checkout", "-q", "-b", BRANCH);
    git(seed, "commit", "-q", "--allow-empty", "-m", "an earlier update, still open");
    git(seed, "checkout", "-q", "main");
  }
  const origin = join(dir, "origin.git");
  git(dir, "clone", "-q", "--bare", seed, origin);
  const work = join(dir, "work");
  git(dir, "clone", "-q", origin, work);

  const upstream = join(dir, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  writeTree(upstream, platform);
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "the platform, released");

  const summary = join(dir, "step-summary.md");
  writeFileSync(summary, "", "utf8");
  return { dir, seed, origin, work, upstream, clone: join(dir, "upstream-clone"), summary };
}

function runnerFor(workspace: string, stepSummary: string, overrides: Partial<Runner> = {}): Runner {
  return {
    workspace,
    repository: "licensee/their-copy",
    refName: "main",
    serverUrl: "https://github.com",
    stepSummary,
    ...overrides,
  };
}

/** Stands in for gh: records every call and what it was given on stdin, and answers as told. */
const FAKE_GH = `
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const at = args.indexOf("--body-file");
const stdin = at >= 0 && args[at + 1] === "-" ? readFileSync(0, "utf8") : null;
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + "\\n");
const verb = args.slice(0, 2).join(" ");
if (verb === "pr view") {
  if (process.env.FAKE_GH_PR_STATE) { process.stdout.write(process.env.FAKE_GH_PR_STATE + "\\n"); process.exit(0); }
  process.stderr.write("no pull requests found for branch\\n");
  process.exit(1);
}
if (verb === "pr create" && process.env.FAKE_GH_PR_CREATE_FAILS) {
  process.stderr.write("GitHub Actions is not permitted to create or approve pull requests.\\n");
  process.exit(1);
}
process.stdout.write("https://github.com/licensee/their-copy/pull/1\\n");
`;

/**
 * Runs the script in a process of its own and watches it.
 *
 * Everything before the sync may read what it likes. After it - once rsync has
 * returned - every read of a file inside the repository, every module loaded
 * and every command started is written down, because each is a way for the
 * new version to leak into a run of the old one.
 */
const WATCHER = `
import childProcess from "node:child_process";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [scriptUrl, optionsJson, eventsPath] = process.argv.slice(2);
const options = JSON.parse(optionsJson);
const roots = [resolve(options.runner.workspace)];
try { roots.push(fs.realpathSync(options.runner.workspace)); } catch {}
const events = { commands: [], afterSync: { commands: [], reads: [], loads: [] } };
let synced = false;
let recording = true;

function pathOf(value) {
  if (typeof value === "string") return value;
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  return undefined;
}
function insideRepository(value) {
  const path = pathOf(value);
  if (path === undefined) return false;
  return roots.some((root) => {
    const rel = relative(root, resolve(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}
for (const target of [fs, fs.promises]) {
  for (const name of Object.keys(target)) {
    const original = target[name];
    if (typeof original !== "function" || /^[A-Z]/.test(name)) continue;
    const watched = function (...args) {
      if (recording && synced && insideRepository(args[0])) events.afterSync.reads.push(name + " " + pathOf(args[0]));
      return original.apply(this, args);
    };
    Object.assign(watched, original);
    target[name] = watched;
  }
}
for (const name of ["execFileSync", "spawnSync", "execSync", "execFile", "spawn", "exec", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function (file, ...rest) {
    if (recording) (synced ? events.afterSync.commands : events.commands).push(String(file));
    const result = original.call(this, file, ...rest);
    if (file === "rsync") synced = true;
    return result;
  };
}
registerHooks({
  load(url, context, nextLoad) {
    if (recording && synced) events.afterSync.loads.push(url);
    return nextLoad(url, context);
  },
});
syncBuiltinESMExports();

process.on("exit", () => {
  recording = false;
  fs.writeFileSync(eventsPath, JSON.stringify(events));
});
const { takeUpdates } = await import(scriptUrl);
process.exitCode = takeUpdates(options);
`;

type GhCall = { readonly args: readonly string[]; readonly stdin: string | null };
type Events = {
  readonly commands: readonly string[];
  readonly afterSync: { readonly commands: readonly string[]; readonly reads: readonly string[]; readonly loads: readonly string[] };
};
type Outcome = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly gh: readonly GhCall[];
  readonly summary: string;
  readonly events: Events;
};

function takeUpdatesIn(
  box: Sandbox,
  options: { runner?: Partial<Runner>; env?: Readonly<Record<string, string>>; script?: string } = {},
): Outcome {
  const bin = join(box.dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "fake-gh.mjs"), FAKE_GH, "utf8");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake-gh.mjs")}" "$@"\n`, "utf8");
  chmodSync(join(bin, "gh"), 0o755);
  const watcher = join(box.dir, "watch.mjs");
  writeFileSync(watcher, WATCHER, "utf8");

  const ghLog = join(box.dir, "gh.jsonl");
  const eventsPath = join(box.dir, "events.json");
  const script = options.script ?? join(box.work, "scripts", "take-updates.ts");
  const runner = runnerFor(box.work, box.summary, options.runner);
  const takeOptions = { runner, upstreamUrl: pathToFileURL(box.upstream).href, upstreamCheckout: box.clone };

  const result = spawnSync(process.execPath, [watcher, pathToFileURL(script).href, JSON.stringify(takeOptions), eventsPath], {
    env: { ...CLEAN_ENV, PATH: `${bin}:${CLEAN_ENV["PATH"] ?? ""}`, FAKE_GH_LOG: ghLog, ...options.env },
    encoding: "utf8",
    timeout: 60_000,
  });
  const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    gh: read(ghLog)
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as GhCall),
    summary: read(box.summary),
    events: JSON.parse(read(eventsPath) || '{"commands":[],"afterSync":{"commands":[],"reads":[],"loads":[]}}') as Events,
  };
}

function inOrigin(box: Sandbox, ...args: string[]): string {
  return git(box.origin, ...args);
}

function withSandbox(platform: Readonly<Record<string, string>>, body: (box: Sandbox) => void, options: { openBranch?: boolean } = {}): void {
  const box = sandbox(platform, options);
  try {
    body(box);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
}

test("an update arrives as a pull request, and leaves the copy's own files alone", () => {
  withSandbox(PLATFORM, (box) => {
    const copyHead = git(box.work, "rev-parse", "HEAD");
    const outcome = takeUpdatesIn(box);
    assert.equal(outcome.status, 0, outcome.stderr);

    const files = inOrigin(box, "ls-tree", "-r", "--name-only", BRANCH).split("\n");
    const show = (path: string): string => inOrigin(box, "show", `${BRANCH}:${path}`);
    assert.equal(show("README.md"), "the platform now", "the platform's files arrive");
    assert.equal(show("package.json"), '{ "type": "module", "version": "0.6.0" }');
    assert.equal(files.includes("stale.txt"), false, "a file the platform removed leaves the copy");
    assert.equal(show("platform.config.yaml"), "niche: the licensee's own", "their config is theirs");
    assert.equal(show("wrangler.jsonc"), '{ "name": "their-worker", "database_id": "their-database" }', "so is their wrangler config");
    assert.equal(show(".github/workflows/take-updates.yml"), "the shell they pasted", "and their .github");
    assert.equal(files.includes(".github/workflows/sync-to-release.yml"), false, "nothing of ours arrives under .github");

    assert.equal(inOrigin(box, "rev-parse", `${BRANCH}^`), copyHead, "the update is one commit on top of their own history");
    const upstreamSha = git(box.upstream, "rev-parse", "--short", "HEAD");
    assert.equal(inOrigin(box, "log", "-1", "--format=%s", BRANCH), `Take updates from the platform (${upstreamSha})`);
    assert.equal(inOrigin(box, "log", "-1", "--format=%ae", BRANCH), "github-actions@github.com");
    assert.equal(git(box.work, "remote", "get-url", "origin"), box.origin, "their .git is still theirs");

    assert.deepEqual(
      outcome.gh.map((call) => call.args.join(" ")),
      [
        `pr view ${BRANCH} --json state --jq .state`,
        `pr create --base main --head ${BRANCH} --title ${PULL_REQUEST_TITLE} --body-file -`,
      ],
    );
    assert.equal(outcome.gh[1]?.stdin, pullRequestBody(false), "the body is the whole text, and nothing about the shell");
    assert.equal(outcome.summary, "", "a pull request is its own report");
    assert.equal(outcome.stdout.includes(UPSTREAM_MARKER), false, "upstream's copy of the script is copied, never run");
  });
});

test("when the shell itself changed, the pull request says so", () => {
  withSandbox({ ...PLATFORM, [UPDATER_COPY]: "shell, second version\n" }, (box) => {
    const outcome = takeUpdatesIn(box);
    assert.equal(outcome.status, 0, outcome.stderr);
    const create = outcome.gh.find((call) => call.args[1] === "create");
    assert.equal(create?.stdin, pullRequestBody(true));
  });
});

test("nothing to take ends green, says so, and opens nothing", () => {
  withSandbox(COPY, (box) => {
    const outcome = takeUpdatesIn(box);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.equal(outcome.summary, `Already up to date with ${UPSTREAM}.\n`);
    assert.deepEqual(outcome.gh, [], "no pull request for an empty diff");
    assert.equal(inOrigin(box, "branch", "--list", BRANCH), "", "and nothing pushed");
  });
});

test("an open pull request is brought up to date rather than duplicated", () => {
  // The branch is already on the remote, as it is whenever a pull request is
  // open. The push goes through only because the checkout knows that branch
  // - what the shell's fetch-depth: 0 is for.
  withSandbox(
    PLATFORM,
    (box) => {
      const copyHead = git(box.work, "rev-parse", "HEAD");
      const outcome = takeUpdatesIn(box, { env: { FAKE_GH_PR_STATE: "OPEN" } });
      assert.equal(outcome.status, 0, outcome.stderr);
      assert.equal(inOrigin(box, "rev-parse", `${BRANCH}^`), copyHead, "the branch now carries the newest update");
      assert.deepEqual(
        outcome.gh.map((call) => call.args.slice(0, 2).join(" ")),
        ["pr view"],
        "and no second pull request",
      );
      assert.equal(outcome.summary, "Updated the open pull request.\n");
    },
    { openBranch: true },
  );
});

test("when Actions may not open a pull request, an issue says where the update is, and the run is green", () => {
  withSandbox(PLATFORM, (box) => {
    const outcome = takeUpdatesIn(box, { env: { FAKE_GH_PR_CREATE_FAILS: "1" } });
    assert.equal(outcome.status, 0, "the update did arrive; red would say it did not");
    const issue = outcome.gh.find((call) => call.args[0] === "issue");
    assert.deepEqual(issue?.args, ["issue", "create", "--title", ISSUE_TITLE, "--body-file", "-"]);
    const expected = issueBody(runnerFor(box.work, box.summary));
    assert.equal(issue?.stdin, expected);
    assert.equal(outcome.summary, expected, "and the run's own page says it too");
    assert.notEqual(inOrigin(box, "branch", "--list", BRANCH), "", "the branch the issue points at exists");
  });
});

test("a command that fails stops the run red, and nothing after it runs", () => {
  withSandbox(PLATFORM, (box) => {
    git(box.work, "remote", "set-url", "origin", join(box.dir, "nowhere.git"));
    const outcome = takeUpdatesIn(box);
    assert.equal(outcome.status, 1, "a push that did not happen must not end green");
    assert.match(outcome.stderr, /::error::`git push --force-with-lease origin platform-update` failed/);
    assert.deepEqual(outcome.gh, [], "no pull request for an update that was never pushed");
  });
});

test("inside the platform's own release repository it does nothing", () => {
  withSandbox(PLATFORM, (box) => {
    const outcome = takeUpdatesIn(box, { runner: { repository: UPSTREAM } });
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /There is nothing upstream of it/);
    assert.deepEqual(outcome.events.commands, [], "not even a clone");
  });
});

test("a root with no .git stops the run before anything is fetched, removed or copied", () => {
  // The failure this exists for: the copy pointed at a directory that is not
  // the checkout, deleting everything there that upstream does not have.
  // Inside the checkout is the dangerous case - git still works from a
  // subdirectory, so nothing else would stop it - and outside any repository
  // is the one an earlier plan would have produced (a root of `/`).
  withSandbox(PLATFORM, (box) => {
    const inside = join(box.work, "scripts");
    const outside = join(box.dir, "not-a-checkout");
    for (const [what, root] of [
      ["a directory inside the checkout", inside],
      ["a directory outside any repository", outside],
    ] as const) {
      writeTree(root, { "precious.txt": "not the platform's to delete\n" });
      writeTree(box.clone, { "left-from-last-time": "\n" });
      const outcome = takeUpdatesIn(box, { runner: { workspace: root }, script: SCRIPT });
      assert.equal(outcome.status, 1, `${what}: unsure which directory to replace means stop, red`);
      assert.match(outcome.stderr, /::error::.*has no \.git/, what);
      assert.equal(existsSync(join(root, "precious.txt")), true, `${what}: something there was deleted`);
      assert.equal(existsSync(join(box.clone, "left-from-last-time")), true, `${what}: the old clone was cleared`);
      assert.deepEqual(outcome.events.commands, [], `${what}: a command ran`);
    }
  });
});

test("after the sync the run loads no code and reads no file of the new version", () => {
  // The sync replaces this script while it runs. The old process finishing on
  // the old code is safe; the old process picking up the new version's code
  // or settings halfway through is not, and nothing else would show it.
  for (const [what, platform, env] of [
    ["the longest path: a changed shell, and a refused pull request", { ...PLATFORM, [UPDATER_COPY]: "shell, second version\n" }, { FAKE_GH_PR_CREATE_FAILS: "1" }],
    ["an open pull request", PLATFORM, { FAKE_GH_PR_STATE: "OPEN" }],
  ] as const) {
    withSandbox(platform, (box) => {
      const outcome = takeUpdatesIn(box, { env });
      assert.equal(outcome.status, 0, `${what}: ${outcome.stderr}`);
      const { commands, afterSync } = outcome.events;
      assert.ok(commands.includes("rsync"), `${what}: the watcher never saw the sync, so an empty record would prove nothing`);
      assert.ok(afterSync.commands.length > 0, `${what}: nothing was watched after the sync`);
      assert.deepEqual(afterSync.loads, [], `${what}: a module was loaded after the sync`);
      assert.deepEqual(afterSync.reads, [], `${what}: a file of the new version was read after the sync`);
      assert.deepEqual(
        afterSync.commands.filter((command) => command !== "git" && command !== "gh"),
        [],
        `${what}: only git and gh may look at the tree after the sync`,
      );
      assert.equal(outcome.stdout.includes(UPSTREAM_MARKER), false, `${what}: upstream's script ran`);
    });
  }
});

test("started the way the shell starts it, it runs - and outside Actions it refuses, red", () => {
  // `node scripts/take-updates.ts` has to reach main(). If the check for being
  // the entry point ever failed, the run would end green having done nothing,
  // which reads as "already up to date". Started relative to the checkout, as
  // the shell does, and by an absolute path through a symlink where the
  // machine has one (macOS's temporary directory is one): node resolves the
  // module's own URL through the link and leaves argv as typed, which is how
  // a naive comparison of the two misses.
  const dir = mkdtempSync(join(tmpdir(), "amp-take-updates-entry-"));
  try {
    writeTree(dir, { "package.json": '{ "type": "module" }\n', "scripts/take-updates.ts": SCRIPT_SOURCE });
    const env = Object.fromEntries(Object.entries(CLEAN_ENV).filter(([name]) => !name.startsWith("GITHUB_")));
    for (const entry of ["scripts/take-updates.ts", join(dir, "scripts", "take-updates.ts")]) {
      const result = spawnSync(process.execPath, [entry], { cwd: dir, env, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 1, `started as ${entry}, it has to run and refuse, not return quietly: ${result.stderr}`);
      assert.match(result.stderr, /::error::GITHUB_WORKSPACE, .* not set/, "and say what is missing");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
