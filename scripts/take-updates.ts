#!/usr/bin/env node
/**
 * Takes the platform's updates into this copy, as a pull request.
 *
 * `.github/workflows/take-updates.yml` - the shell - checks this repository
 * out and runs this file, and that is all it does. Everything the updater
 * decides lives here instead, because the two travel differently. GitHub
 * never lets a workflow write under `.github/workflows/`, so the shell is
 * whatever the licensee pasted by hand, once; this file is an ordinary file,
 * and every update brings the current one with it. A fix made here reaches
 * every copy by itself. A fix made in the shell reaches nobody until each of
 * them pastes it again. See docs/3-development/taking-updates.md, plan D.
 *
 * ## The promise to the shell. Do not change it.
 *
 * A copy keeps running the shell it was given for as long as it exists, so
 * what the shell relies on here is fixed for good:
 *
 *   - this file's path, `scripts/take-updates.ts`
 *   - how it is started: `node scripts/take-updates.ts`, no arguments, from
 *     the repository `actions/checkout` has just made
 *   - the environment: `GH_TOKEN` from the shell, and the runner's own
 *     GITHUB_WORKSPACE, GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_SERVER_URL
 *     and GITHUB_STEP_SUMMARY
 *
 * Moving or renaming any of these breaks every licensee's updater at once,
 * and the only repair is a hand-paste in every copy.
 *
 * ## What runs is what was checked out
 *
 * The upstream clone is data: its files are copied, never executed. Running
 * upstream's copy of this script would put code nobody here has read behind
 * the write permission this job holds - the reason taking-updates.md §4
 * turned down a hosted app. The consequence is deliberate: a fix to this file
 * takes effect from the run *after* the one that carried it in.
 *
 * ## Nothing is loaded after the sync
 *
 * The sync replaces this very file while it runs. That is harmless only
 * because everything this process will execute was loaded before it started:
 * the imports are static, all of them are `node:` built-ins, and once the
 * sync has run this code neither loads a module nor reads a file of the
 * repository - only git and gh look at the tree from then on. A lazy load, or
 * a read of package.json, after the sync would mix the new version's code or
 * settings into a run of the old one. `test/take-updates.test.ts` watches a
 * real run for exactly that.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the platform is published. A copy of this file inside that repository
 * would be asking it to update itself, so the run stops when it finds it is
 * already there.
 */
export const UPSTREAM = "madbarbarian/Affiliate-Management-Platform-release";

/**
 * The branch the update is pushed to and the pull request is opened from.
 *
 * The shell names it as well - its job refuses to run from this branch - so
 * the two have to agree. `test/release.test.ts` holds them together.
 */
export const BRANCH = "platform-update";

/** Where upstream is cloned: outside the workspace, so the copy never copies the clone into itself. */
export const UPSTREAM_CHECKOUT = "/tmp/upstream";

/** Who the update commit is from, so it cannot be mistaken for the licensee's own. */
const COMMITTER = { name: "GitHub Actions", email: "github-actions@github.com" } as const;

/**
 * The shell's current text, as it reaches a copy: an ordinary file at the
 * root, because `.github/` is never synced (see KEPT). When it changes, the
 * pull request has to say so, since pasting it is the one step left to a
 * person. `scripts/make-release.ts` ships the shell under this name.
 */
export const UPDATER_COPY = "update-workflow.yml";

export const PULL_REQUEST_TITLE = "Take updates from the platform";
export const COMMIT_SUBJECT = "Take updates from the platform";
export const ISSUE_TITLE = "更新が届いています（Pull request を作れませんでした）";

/**
 * Yours, and never replaced from upstream. Each is something that exists in a
 * licensee's copy with their own values in it, so taking ours would take
 * their operation down:
 *
 *   .git                  - this copy's own history. The upstream clone has
 *                           one too, and copying it over would replace the
 *                           licensee's repository with ours.
 *   .github               - GitHub will not let a token write under
 *                           `.github/workflows/` without a permission
 *                           GITHUB_TOKEN does not have, and one refused file
 *                           fails the whole push - so a single change to the
 *                           shell would take every other fix down with it.
 *                           Its text still arrives, as UPDATER_COPY.
 *   platform.config.yaml  - their niche, audience, voice and accounts.
 *   wrangler.jsonc        - the Deploy button wrote their Worker's name and
 *                           the id of the database it made for them. Ours
 *                           carries our name and a placeholder, and a deploy
 *                           with that in it fails on "binding DB of type d1
 *                           must have a valid database_id". Found the first
 *                           time an update was ever taken, 2026-09-19.
 */
export const KEPT: readonly string[] = [".git", ".github", "platform.config.yaml", "wrangler.jsonc"];

/**
 * The runner's environment, by what it is used for. These names are part of
 * the promise to the shell above.
 */
export type Runner = {
  readonly workspace: string;
  readonly repository: string;
  readonly refName: string;
  readonly serverUrl: string;
  readonly stepSummary: string;
};

const RUNNER_ENV: Readonly<Record<keyof Runner, string>> = {
  workspace: "GITHUB_WORKSPACE",
  repository: "GITHUB_REPOSITORY",
  refName: "GITHUB_REF_NAME",
  serverUrl: "GITHUB_SERVER_URL",
  stepSummary: "GITHUB_STEP_SUMMARY",
};

export type RunnerRead = { readonly ok: true; readonly runner: Runner } | { readonly ok: false; readonly missing: readonly string[] };

/** Every missing name at once, so one run says everything that is wrong. */
export function readRunner(env: Readonly<Record<string, string | undefined>>): RunnerRead {
  const missing = Object.values(RUNNER_ENV).filter((name) => !env[name]);
  if (missing.length > 0) return { ok: false, missing };
  const value = (key: keyof Runner): string => env[RUNNER_ENV[key]] as string;
  return {
    ok: true,
    runner: {
      workspace: value("workspace"),
      repository: value("repository"),
      refName: value("refName"),
      serverUrl: value("serverUrl"),
      stepSummary: value("stepSummary"),
    },
  };
}

/**
 * Why the copy must not run into `workspace`, or undefined when it may.
 *
 * The copy deletes whatever upstream does not have. Pointed at the wrong
 * directory it deletes the wrong things, so the root is taken from
 * GITHUB_WORKSPACE - never from where this file happens to sit, which a copy
 * of it elsewhere would turn into `/` - and it has to be a git checkout before
 * anything is touched. Unsure means stop.
 */
export function rootProblem(workspace: string, upstreamCheckout: string, hasGit: boolean): string | undefined {
  if (!isAbsolute(workspace)) {
    return `GITHUB_WORKSPACE is "${workspace}", not an absolute path, so which directory the update would replace is a guess. Nothing was touched.`;
  }
  if (contains(workspace, upstreamCheckout) || contains(upstreamCheckout, workspace)) {
    return `The upstream clone (${upstreamCheckout}) and the repository (${workspace}) overlap, and the copy between them deletes files. Nothing was touched.`;
  }
  if (!hasGit) {
    return `${workspace} has no .git, so it is not the repository actions/checkout made, and the copy - which deletes whatever upstream lacks - would land somewhere else. Nothing was touched. Check that actions/checkout runs before this step.`;
  }
  return undefined;
}

function contains(outer: string, inner: string): boolean {
  const path = relative(outer, inner);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/**
 * The copy from upstream into this repository.
 *
 * Copied rather than merged, on purpose. A copy made by the Deploy button
 * shares no history with the platform, so `git merge` would refuse it as
 * unrelated - and forcing that through produces a first merge nobody can
 * read. Replacing the files and showing the diff is the same information
 * without the ceremony.
 *
 * --checksum, because the default quick check is size plus mtime and both can
 * match while the contents differ. Taking v0.6.0 into a real copy delivered 26
 * files and silently skipped `package.json`: the version string had gone from
 * "0.5.1" to "0.6.0", the same number of bytes, and two checkouts made seconds
 * apart carried close enough mtimes. The copy then ran the new code while
 * reporting the old version. Any same-length change is the same failure - a
 * threshold, a model id - and it is invisible, which is what makes it worth
 * the extra read of a few hundred small files.
 *
 * The trailing slashes are load-bearing: without the one on `from`, rsync
 * copies the directory itself rather than what is in it.
 */
export function rsyncArgs(from: string, to: string): string[] {
  return ["-a", "--checksum", "--delete", ...KEPT.map((path) => `--exclude=${path}`), withSlash(from), withSlash(to)];
}

function withSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

/** Whether the staged change includes the shell's text: `git diff --name-only`, one exact path per line. */
export function updaterChanged(stagedNames: string): boolean {
  return stagedNames.split("\n").includes(UPDATER_COPY);
}

/** Read the way `gh pr view --jq .state | grep -q OPEN` read it: any output containing OPEN. */
export function stateSaysOpen(prViewOutput: string): boolean {
  return prViewOutput.includes("OPEN");
}

/**
 * The pull request is the one place a licensee decides whether to merge an
 * update, and the setup screen, the console and the CHANGELOG are all
 * Japanese by default - so Japanese first, then English, both always. Nothing
 * here depends on a config the updater might not be able to parse.
 */
const PR_BODY = block([
  "プラットフォームが、あなたの控えを作ったときから変わりました。この Pull request の",
  "中身が、変わったところのすべてです。**読んでから、マージしてください。**",
  "マージすると、ほかの変更と同じように Cloudflare が自動で配置し直します。",
  "",
  "**`platform.config.yaml` は入っていません。** ニッチ・読者・文体・アカウントは",
  "あなたのもので、プラットフォーム側は何も口を出しません。鍵は Cloudflare の",
  "ダッシュボードにあってこのリポジトリには無いので、そこにも触れません。",
  "",
  "**`prompts/` を自分で書き換えていた場合**、この Pull request はそれを配布版で",
  "上書きします。そのときはこの Pull request を閉じ、`runtime.promptsDir` を自分の",
  "フォルダに向けて、そこにプロンプトを写してから、もう一度実行してください。",
  "それ以降、プラットフォームがそのフォルダに触れることはありません。",
  "",
  "**まず差分の中の `CHANGELOG.md` を読んでください。** 運用している人が抱く",
  "ひとつの問い — *これをマージしたら、明日の朝が壊れないか* — に答えるために",
  "書いてあります。",
  "",
  "---",
  "",
  "The platform has changed since your copy was made. Everything in this pull",
  "request is what changed — read it, then merge it. Cloudflare redeploys on the",
  "merge, as it does for any push here.",
  "",
  "**`platform.config.yaml` is not in here.** Your niche, your audience, your",
  "voice and your accounts are yours, and nothing upstream has an opinion about",
  "them. Your secrets are in Cloudflare's dashboard, not in this repository, so",
  "there is nothing here for this to disturb either.",
  "",
  "**If you see your own edits to `prompts/` being replaced**, that is this",
  "pull request replacing them with the shipped versions. Close it, point",
  "`runtime.promptsDir` at a directory of your own, copy your prompts there, and",
  "run this again — upstream will never touch them after that.",
  "",
  "**Read `CHANGELOG.md` in the diff first.** It is written for exactly this",
  "moment: someone with a running operation and one question, *will merging this",
  "break my morning?*",
]);

const PR_BODY_UPDATER = block([
  "",
  "---",
  "",
  "### この Pull request にできない、ひとつのこと",
  "",
  "**`update-workflow.yml` が変わっています。これは「更新を取ってくる仕組み」そのものです。**",
  "GitHub はワークフローに `.github/workflows/` を書かせないので、実際に動いている",
  "`.github/workflows/take-updates.yml` はこの Pull request では変わりません。",
  "",
  "**目的：更新を取ってくる仕組みそのものを、新しくするため。**",
  "貼り替えるまでは、**古い仕組みが動き続けます**。更新は今までどおり届きますが、",
  "この変更で直したことは、あなたの控えではまだ直っていません。",
  "",
  "**マージしたあとで**（前だと、コピー元がまだ古いままです）:",
  "",
  "1. リポジトリ直下の `update-workflow.yml` を開き、右上のコピーのアイコンで全部コピー",
  "2. `.github/workflows/take-updates.yml` を開き、鉛筆のアイコンで編集",
  "3. 中を全部選択して貼り付け、**Commit changes**",
  "",
  "ブラウザで数分です。この節が出るのは、仕組みそのものが変わったときだけです。",
  "",
  "---",
  "",
  "### One thing this pull request cannot do for you",
  "",
  "**`update-workflow.yml` changed in this diff, and that file is this updater.**",
  "GitHub does not let a workflow write to `.github/workflows/`, so the copy that",
  "actually runs — `.github/workflows/take-updates.yml` — is untouched here.",
  "",
  "**Why: so the thing that fetches updates is itself up to date.** Until you",
  "paste it, **the old one keeps running**. Updates still arrive, but whatever",
  "this change fixed is not fixed in your copy yet.",
  "",
  "**After merging** (before it, the source you would copy is still the old one):",
  "open `update-workflow.yml`, copy all of it, open",
  "`.github/workflows/take-updates.yml`, replace the contents, and commit. A few",
  "minutes, in the browser, and it only appears when the updater itself changed.",
]);

/**
 * The body exactly as the workflow used to write it: each part a YAML block
 * scalar (one trailing newline), printed with `printf '%s\n'` (another).
 */
export function pullRequestBody(updaterChanged: boolean): string {
  return printed(PR_BODY) + (updaterChanged ? printed(PR_BODY_UPDATER) : "");
}

/**
 * What to say when Actions is not allowed to open the pull request.
 *
 * A repository created today does not let it - Settings -> Actions -> General
 * -> Workflow permissions, off by default. The push has already succeeded by
 * then, so the update is sitting on the branch and the only thing missing is
 * the page to read it on. Ending red says the opposite: the first time this
 * was ever run for real, it looked like nothing arrived. So: an issue saying
 * where the update is and which checkbox opens the normal path, and a green
 * run, because the work did happen.
 */
export function issueBody(runner: Runner): string {
  return lines([
    "### 更新は届いています。開く画面だけがありません",
    "",
    "このリポジトリでは、GitHub Actions が Pull request を作ることが",
    "許可されていません（新しいリポジトリの既定）。更新そのものは",
    `\`${BRANCH}\` ブランチに届いています。`,
    "",
    `**いま開くには:** <${runner.serverUrl}/${runner.repository}/compare/${runner.refName}...${BRANCH}>`,
    "",
    "**次回から自動で開くには:** Settings → Actions → General →",
    "Workflow permissions → **Allow GitHub Actions to create and",
    "approve pull requests** にチェックを入れてください。1回だけです。",
  ]);
}

function block(text: readonly string[]): string {
  return `${text.join("\n")}\n`;
}

function printed(text: string): string {
  return `${text}\n`;
}

function lines(text: readonly string[]): string {
  return text.map((line) => `${line}\n`).join("");
}

export type TakeUpdatesOptions = {
  readonly runner: Runner;
  readonly upstreamUrl: string;
  readonly upstreamCheckout: string;
};

/** Runs the whole update. The exit code for the job: 0 green, 1 red. */
export function takeUpdates(options: TakeUpdatesOptions): number {
  const { runner, upstreamCheckout } = options;
  if (runner.repository === UPSTREAM) {
    say("This is the release repository. There is nothing upstream of it.");
    return 0;
  }
  const problem = rootProblem(runner.workspace, upstreamCheckout, existsSync(join(runner.workspace, ".git")));
  if (problem !== undefined) {
    complain(problem);
    return 1;
  }
  try {
    return take(options);
  } catch (cause) {
    if (cause instanceof CommandFailed) {
      complain(cause.message);
      return 1;
    }
    throw cause;
  }
}

function take({ runner, upstreamUrl, upstreamCheckout }: TakeUpdatesOptions): number {
  const root = runner.workspace;

  rmSync(upstreamCheckout, { recursive: true, force: true });
  run("git", ["clone", "--depth", "1", upstreamUrl, upstreamCheckout], root);
  const upstreamSha = capture("git", ["-C", upstreamCheckout, "rev-parse", "--short", "HEAD"], root).trim();

  run("git", ["config", "user.email", COMMITTER.email], root);
  run("git", ["config", "user.name", COMMITTER.name], root);
  run("git", ["checkout", "-B", BRANCH], root);
  run("rsync", rsyncArgs(upstreamCheckout, root), root);
  run("git", ["add", "-A"], root);

  // The tree is the new version from here on. No module is loaded and no file
  // of it is read below this line - see "Nothing is loaded after the sync".
  const updater = updaterChanged(capture("git", ["diff", "--staged", "--name-only"], root));

  if (!hasStagedChanges(root)) {
    summarise(runner, `Already up to date with ${UPSTREAM}.\n`);
    return 0;
  }

  run("git", ["commit", "-m", `${COMMIT_SUBJECT} (${upstreamSha})`], root);
  run("git", ["push", "--force-with-lease", "origin", BRANCH], root);

  // One open pull request at a time: a second one for the same branch would
  // be a duplicate, and the branch already carries the newest.
  if (pullRequestIsOpen(root)) {
    summarise(runner, "Updated the open pull request.\n");
    return 0;
  }
  if (createPullRequest(root, runner.refName, pullRequestBody(updater))) return 0;

  const issue = issueBody(runner);
  run("gh", ["issue", "create", "--title", ISSUE_TITLE, "--body-file", "-"], root, issue);
  summarise(runner, issue);
  return 0;
}

/** A command whose failure means stop: nothing after it may run. */
class CommandFailed extends Error {}

function run(command: string, args: readonly string[], cwd: string, input?: string): void {
  try {
    execFileSync(command, [...args], {
      cwd,
      stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
      ...(input === undefined ? {} : { input }),
    });
  } catch (cause) {
    throw failed(command, args, cause);
  }
}

function capture(command: string, args: readonly string[], cwd: string): string {
  try {
    return execFileSync(command, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch (cause) {
    throw failed(command, args, cause);
  }
}

/**
 * `git diff --quiet` answers in its exit code: 0 nothing staged, 1 something
 * staged. Anything else is git failing, and is not read as either.
 */
function hasStagedChanges(cwd: string): boolean {
  const args = ["diff", "--staged", "--quiet"];
  const result = spawnSync("git", args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw failed("git", args, result.error ?? `exit ${String(result.status ?? result.signal)}`);
}

/**
 * Failing is an answer here, not an error: `gh pr view` exits non-zero when
 * the branch has no pull request, which is exactly the case where one should
 * be opened. Only what it printed decides, as the pipe into grep did.
 */
function pullRequestIsOpen(cwd: string): boolean {
  const result = spawnSync("gh", ["pr", "view", BRANCH, "--json", "state", "--jq", ".state"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return stateSaysOpen(result.stdout ?? "");
}

/** Whether the pull request was opened. Refused is an answer: the caller files an issue instead. */
function createPullRequest(cwd: string, base: string, body: string): boolean {
  const result = spawnSync(
    "gh",
    ["pr", "create", "--base", base, "--head", BRANCH, "--title", PULL_REQUEST_TITLE, "--body-file", "-"],
    { cwd, input: body, stdio: ["pipe", "inherit", "inherit"] },
  );
  return result.status === 0;
}

function failed(command: string, args: readonly string[], cause: unknown): CommandFailed {
  const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
  return new CommandFailed(
    `\`${[command, ...args].join(" ")}\` failed (${detail}). Stopped there: nothing after it ran. Its own output is above.`,
  );
}

function summarise(runner: Runner, text: string): void {
  appendFileSync(runner.stepSummary, text);
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** As a workflow error, so it shows on the run's page and not only in the log. */
function complain(text: string): void {
  process.stderr.write(`::error::${text}\n`);
}

function main(): number {
  const read = readRunner(process.env);
  if (!read.ok) {
    complain(
      `${read.missing.join(", ")} not set. GitHub Actions sets these for .github/workflows/take-updates.yml, which is what runs this file - it is not meant to be run by hand.`,
    );
    return 1;
  }
  return takeUpdates({
    runner: read.runner,
    upstreamUrl: `https://github.com/${UPSTREAM}.git`, // public: no token needed to read it
    upstreamCheckout: UPSTREAM_CHECKOUT,
  });
}

// Importable from the tests without taking anything. Both sides are real
// paths, because a path through a symlink would otherwise not match - and the
// run would end green having done nothing at all.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
