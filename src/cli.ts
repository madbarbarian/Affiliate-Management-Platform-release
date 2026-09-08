#!/usr/bin/env node
/**
 * `amp` - the operator's whole interface to the company.
 *
 * Two commands do the day's work (`cycle run`, `approve`) and one runs it
 * unattended (`daemon`). Everything else exists to answer "what is it doing
 * and why", which is the question that actually gets asked once a system runs
 * itself.
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { describeError, type PlatformError } from "./core/result.ts";
import { loadConfigSync, loadDotEnv, repoRoot, resolveConfigPath } from "./config/load.ts";
import { parseYaml } from "./config/yaml.ts";
import { get, isPlainObject } from "./config/validate.ts";
import { describeGate } from "./kernel/approvals.ts";
import { applyPause, applyResume, describePause, pausedBy, readPause } from "./kernel/pause.ts";
import { fileState } from "./kernel/state.ts";
import {
  appendVentureBlock,
  describeProposal,
  listProposals,
  markAppended,
  renderVentureBlock,
  resolveProposal,
  runScout,
} from "./kernel/exploration.ts";
import {
  deactivateVenture,
  describeInactive,
  isVentureActive,
  reactivateVenture,
  readVentureState,
} from "./kernel/venture-state.ts";
import { buildPortfolio, renderPortfolio } from "./domain/portfolio.ts";
import { roster } from "./roles/index.ts";
import { createRuntime, type Runtime, type RuntimeOptions } from "./runtime.ts";
import { startConsole } from "./console/server.ts";
import { startDaemon } from "./scheduler/daemon.ts";
import { createJsonStore, describeDataDir } from "./storage/json-store.ts";
import { computePerformance } from "./domain/performance.ts";
import { describeMeasurementChain, stepLabel } from "./domain/measurement.ts";
import { formatMoney, totalCounts } from "./affiliate/attribution.ts";
import { REDIRECT_PATH } from "./affiliate/links.ts";
import { buildStatement, renderStatement } from "./domain/licensing.ts";
import { formatPostPerformance } from "./roles/format.ts";
import { CYCLE_STEPS, type CycleStep, type VentureId } from "./core/types.ts";

const USAGE = `
amp — autonomous affiliate operations

Usage
  amp <command> [options]

Getting started
  init                    Create platform.config.yaml and .env.local from the shipped examples
  doctor                  Validate config and check every credential and adapter
  roles                   Print the org chart

Running the company
  cycle run               Run today's cycle until it needs you, or finishes
  cycle status            Show where today's cycle got to
  pending                 List what is waiting on your decision
  approve <decision-id>   Approve and order, from the terminal
  dispatch                Publish anything whose slot has arrived
  daemon                  Run continuously: start cycles on time, publish on time
  console                 Serve the approval console (and the tracking redirect)

Stopping
  pause                   Stop everything now. Nothing runs and nothing publishes
  resume                  Start again after a pause

Exploring (weekly, not daily)
  scout                   Ask the scout which accounts to try next. Calls the model once
  scout list              Proposals waiting for your decision (--all: decided ones too)
  scout show <id>         One proposal in full, with the ventures[] block it would become
  scout accept <id>       Accept one: appends its ventures[] block to the config (inactive, backed up)
                          --print-only shows the block instead of writing it
  scout dismiss <id>      Decline one (--reason says why, for the record)
                          While the daemon runs, accept and dismiss from the console instead:
                          the daemon holds the data lock
  portfolio               Every account on one page: earning, stuck at a gate, unmeasured, or flagged

Switching accounts on and off (no config edit, no restart, nothing deleted)
  venture deactivate <id> Stop running an account, keep everything it learned (--reason)
  venture activate <id>   Run it again
  venture list            Each account's effective state and why

Reporting
  report                  What published, what it earned, what the playbook learned
  statement               What each venture owes under the configured billing terms

Options
  --venture <id>          Limit to one venture (default: all active ventures)
  --config <path>         Use a specific config file
  --dry-run               Simulate everything: no API calls, no posts, nothing written
  --until <step>          cycle run: stop before this step (${CYCLE_STEPS.join(", ")})
  --date <YYYY-MM-DD>     cycle run: operate on a specific local date
  --days <n>              report / portfolio: how far back to look (default 7 / 30)
  --count <n>             scout: how many proposals to ask for (1-10)
  --all                   scout list: include accepted and dismissed proposals
  --print-only            scout accept: show the block, do not write the config
  --select <a,b>          approve: item ids to approve (default: the recommended ones)
  --order <a,b>           approve: publishing order (default: the order given by --select)
  --none                  approve: reject everything in this decision
  --reason <text>         pause: why, so the record says more than "stopped"
  --json                  Machine-readable output where it makes sense
  --help, -h              This text
`.trimStart();

type Options = {
  command: string[];
  venture?: string;
  config?: string;
  until?: string;
  date?: string;
  days?: number;
  count?: number;
  select?: string[];
  order?: string[];
  reason?: string;
  dryRun: boolean;
  none: boolean;
  all: boolean;
  printOnly: boolean;
  json: boolean;
  help: boolean;
};

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const command = commandKey(options.command);

  if (options.help || command === "" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (command) {
    case "init":
      return commandInit();
    case "roles":
      return commandRoles(options);
    case "doctor":
      return withRuntime(options, { lock: false, owner: "doctor" }, commandDoctor);
    case "cycle run":
      return withRuntime(options, { lock: !options.dryRun, owner: "cycle run" }, commandCycleRun);
    case "cycle status":
      return withRuntime(options, { lock: false, owner: "cycle status" }, commandCycleStatus);
    case "pending":
      return withRuntime(options, { lock: false, owner: "pending" }, commandPending);
    case "approve":
      return withRuntime(options, { lock: true, owner: "approve" }, commandApprove);
    case "dispatch":
      return withRuntime(options, { lock: true, owner: "dispatch" }, commandDispatch);
    case "report":
      return withRuntime(options, { lock: false, owner: "report" }, commandReport);
    case "statement":
      return withRuntime(options, { lock: false, owner: "statement" }, commandStatement);
    case "console":
      return withRuntime(options, { lock: true, owner: "console" }, commandConsole);
    case "daemon":
      return withRuntime(options, { lock: true, owner: "daemon" }, commandDaemon);
    case "scout":
      return withRuntime(options, { lock: true, owner: "scout" }, commandScout);
    case "scout list":
      return withRuntime(options, { lock: false, owner: "scout list" }, commandScoutList);
    case "scout show":
      return withRuntime(options, { lock: false, owner: "scout show" }, commandScoutShow);
    case "scout accept":
      return withRuntime(options, { lock: true, owner: "scout accept" }, (runtime, opts) =>
        commandScoutResolve(runtime, opts, "accepted"),
      );
    case "scout dismiss":
      return withRuntime(options, { lock: true, owner: "scout dismiss" }, (runtime, opts) =>
        commandScoutResolve(runtime, opts, "dismissed"),
      );
    case "portfolio":
      return withRuntime(options, { lock: false, owner: "portfolio" }, commandPortfolio);
    // No data lock: these write a small state file the daemon re-reads every
    // tick, never the store, so they work while it runs.
    case "venture deactivate":
      return withRuntime(options, { lock: false, owner: "venture deactivate" }, (runtime, opts) =>
        commandVentureSwitch(runtime, opts, false),
      );
    case "venture activate":
      return withRuntime(options, { lock: false, owner: "venture activate" }, (runtime, opts) =>
        commandVentureSwitch(runtime, opts, true),
      );
    case "venture list":
      return withRuntime(options, { lock: false, owner: "venture list" }, commandVentureList);
    // Deliberately not routed through `withRuntime`. Stopping must not depend
    // on the model provider, the channels or the networks being configured -
    // a broken adapter or an expired API key is one of the reasons someone
    // reaches for the stop, and it must not be the reason they cannot. It also
    // takes no data lock, because the daemon it is stopping is holding one.
    case "pause":
      return commandPause(options);
    case "resume":
      return commandResume(options);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandInit(): Promise<number> {
  const root = repoRoot();
  const configTarget = join(root, "platform.config.yaml");
  const envTarget = join(root, ".env.local");
  const created: string[] = [];

  if (existsSync(configTarget)) {
    process.stdout.write(`platform.config.yaml already exists — leaving it alone.\n`);
  } else {
    await copyFile(join(root, "platform.config.example.yaml"), configTarget);
    created.push("platform.config.yaml");
  }

  if (existsSync(envTarget)) {
    process.stdout.write(`.env.local already exists — leaving it alone.\n`);
  } else {
    const example = join(root, ".env.local.sample");
    const template = existsSync(example) ? await readFile(example, "utf8") : "";
    // A console token is generated here rather than left blank, so the console
    // is never accidentally run without one.
    const token = randomBytes(24).toString("hex");
    await writeFile(envTarget, template.replace("AMP_CONSOLE_TOKEN=", `AMP_CONSOLE_TOKEN=${token}`), "utf8");
    created.push(".env.local");
  }

  await mkdir(join(root, ".amp"), { recursive: true });

  process.stdout.write(
    [
      created.length > 0 ? `Created: ${created.join(", ")}` : "Nothing to create.",
      "",
      "Next:",
      "  1. Edit platform.config.yaml — the market, the venture, the voice, the offers.",
      "  2. Put ANTHROPIC_API_KEY in .env.local (secrets never go in .env).",
      "  3. node src/cli.ts doctor",
      "  4. node src/cli.ts cycle run --dry-run    (simulates everything, publishes nothing)",
      "",
    ].join("\n"),
  );
  return 0;
}

async function commandRoles(options: Options): Promise<number> {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(roster, null, 2)}\n`);
    return 0;
  }
  process.stdout.write("The company:\n\n");
  for (const [index, role] of roster.entries()) {
    process.stdout.write(`  ${index + 1}. ${role.title}\n     ${role.description}\n\n`);
  }
  process.stdout.write(
    "Your job: say OK to the proposals, and choose what goes out first.\nEverything else runs without you.\n",
  );
  return 0;
}

async function commandDoctor(runtime: Runtime, options: Options): Promise<number> {
  const lines: string[] = [];
  let problems = 0;

  // First line, before anything else. Someone running `doctor` because posts
  // are not appearing should not have to read past the model name to find out
  // that they stopped the platform on Friday.
  const stop = readPause(runtime.state);
  if (stop.all) {
    lines.push(`STOPPED     ${describePause(stop.all)}`);
    lines.push("");
  } else {
    for (const [ventureId, record] of Object.entries(stop.ventures)) {
      lines.push(`STOPPED     ${describePause(record, ventureId as VentureId)}`);
    }
    if (Object.keys(stop.ventures).length > 0) lines.push("");
  }

  lines.push(`config      ${runtime.loaded.path}`);
  lines.push(`data        ${runtime.loaded.dataDir}`);
  lines.push(`prompts     ${runtime.loaded.promptsDir}`);
  lines.push(`autonomy    ${runtime.config.company.autonomy}`);
  lines.push(`model       ${runtime.config.llm.provider} / ${runtime.config.llm.model} (effort ${runtime.config.llm.effort})`);
  lines.push("");

  for (const name of ["researcher", "planner", "writer", "inspector", "analyst", "publisher", "scout"]) {
    for (const suffix of ["system", "user"]) {
      const key = `${name}.${suffix}`;
      if (!runtime.services.prompts.has(key)) {
        lines.push(`prompt      MISSING ${key}.md`);
        problems += 1;
      }
    }
  }

  for (const channel of runtime.services.channels.enabled()) {
    const health = await channel.healthCheck();
    lines.push(`channel     ${channel.id} (${channel.adapter}) — ${health.ok ? health.value : `FAILED: ${health.error.message}`}`);
    if (!health.ok) problems += 1;
  }

  for (const network of runtime.services.networks.enabled()) {
    const health = await network.healthCheck();
    lines.push(`network     ${network.id} (${network.adapter}) — ${health.ok ? health.value : `FAILED: ${health.error.message}`}`);
    if (!health.ok) problems += 1;
  }

  const ventureState = readVentureState(runtime.state);
  if (ventureState.warning) {
    lines.push(`state       ${ventureState.warning}`);
    problems += 1;
  }
  for (const venture of runtime.config.ventures) {
    const deactivated = ventureState.inactive[venture.id];
    lines.push(
      `venture     ${venture.id} — ${
        deactivated ? `deactivated by ${deactivated.by}${deactivated.reason ? ` (${deactivated.reason})` : ""}` : venture.active ? "active" : "inactive"
      }, ` +
        `${venture.cadence.postsPerDay}/day from ${venture.cadence.cycleStartsAt} ${venture.timezone}`,
    );

    // Checked before the first post rather than discovered a month later,
    // because a month measured through a broken chain cannot be re-measured.
    const chain = describeMeasurementChain(runtime.config, venture.id);
    if (chain.closed) {
      lines.push(`            measurement: closed — posts, clicks and revenue all come back`);
    } else {
      lines.push(`            measurement: INCOMPLETE`);
      for (const link of chain.links) {
        if (link.ok) continue;
        lines.push(`              ✗ ${stepLabel(link.step)}`);
        lines.push(`                ${link.problem}`);
      }
      // Not counted as a failure: running on the simulated adapters before you
      // have accounts is the intended way to start, and `doctor` refusing then
      // would train people to ignore it.
      lines.push(
        `              (fine while you are trying it out. Not fine once posts reach an audience.)`,
      );
    }
  }

  const files = await describeDataDir(runtime.loaded.dataDir);
  lines.push("");
  lines.push(files.length === 0 ? "store       empty (nothing has run yet)" : `store       ${files.length} files`);
  for (const file of files) lines.push(`            ${file.file} (${file.bytes} bytes)`);

  process.stdout.write(`${lines.join("\n")}\n\n`);
  process.stdout.write(problems === 0 ? "All checks passed.\n" : `${problems} problem(s) found.\n`);
  return problems === 0 ? 0 : 1;
}

async function commandCycleRun(runtime: Runtime, options: Options): Promise<number> {
  const ventures = selectVentures(runtime, options);
  if (ventures.length === 0) return noVenture(options);

  // A typo here used to be cast straight to `CycleStep` and then never match a
  // step, so `--until dispatchh` ran the whole cycle instead of stopping - and
  // under `autonomy: auto` that means all the way through publishing. The one
  // flag whose job is "stop before this" must not fail open.
  if (options.until !== undefined && !CYCLE_STEPS.includes(options.until as CycleStep)) {
    process.stderr.write(
      `--until "${options.until}" is not a step. Use one of: ${CYCLE_STEPS.join(", ")}\n`,
    );
    return 2;
  }

  let failures = 0;
  for (const ventureId of ventures) {
    const result = await runtime.orchestrator.runCycle(ventureId, {
      ...(options.date ? { date: options.date } : {}),
      ...(options.until ? { until: options.until as CycleStep } : {}),
    });
    if (!result.ok) {
      process.stderr.write(`${ventureId}: ${describeError(result.error)}\n`);
      failures += 1;
      continue;
    }
    const cycle = result.value;
    process.stdout.write(
      `${ventureId}: ${cycle.status}` +
        (cycle.nextStep ? ` — next step "${cycle.nextStep}"` : "") +
        (cycle.pendingDecisionId ? `\n  waiting on you: amp approve ${cycle.pendingDecisionId}` : "") +
        "\n",
    );
    for (const record of cycle.completed.slice(-9)) {
      process.stdout.write(`  ✓ ${record.step.padEnd(18)} ${record.note}\n`);
    }
  }

  const stats = runtime.services.llm.stats();
  if (stats.calls > 0) {
    process.stdout.write(
      `\n${stats.calls} model calls — ${stats.inputTokens} in / ${stats.outputTokens} out` +
        (stats.cacheReadTokens > 0 ? ` (${stats.cacheReadTokens} cached)` : "") +
        "\n",
    );
  }
  return failures === 0 ? 0 : 1;
}

async function commandCycleStatus(runtime: Runtime, options: Options): Promise<number> {
  const ventures = selectVentures(runtime, options);
  const cycles = await runtime.services.store.cycles.find((cycle) => ventures.includes(cycle.ventureId));
  const recent = cycles.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(recent, null, 2)}\n`);
    return 0;
  }
  if (recent.length === 0) {
    process.stdout.write("No cycles yet. Start one with `amp cycle run`.\n");
    return 0;
  }
  for (const cycle of recent) {
    process.stdout.write(`\n${cycle.date}  ${cycle.ventureId}  [${cycle.status}]\n`);
    for (const record of cycle.completed) {
      process.stdout.write(`  ✓ ${record.step.padEnd(18)} ${record.note}\n`);
    }
    if (cycle.nextStep) process.stdout.write(`  … ${cycle.nextStep}\n`);
    if (cycle.failure) process.stdout.write(`  ✗ ${cycle.failure.step}: ${cycle.failure.message}\n`);
  }
  process.stdout.write("\n");
  return 0;
}

async function commandPending(runtime: Runtime, options: Options): Promise<number> {
  const decisions = await runtime.orchestrator.pendingDecisions(options.venture);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(decisions, null, 2)}\n`);
    return 0;
  }
  if (decisions.length === 0) {
    process.stdout.write("Nothing is waiting on you.\n");
    return 0;
  }
  for (const decision of decisions) {
    process.stdout.write(`\n${decision.id}  (${decision.ventureId})\n${describeGate(decision.gate)}\n`);
    process.stdout.write(`Pick up to ${decision.selectionHint.max}. ★ marks the recommendation.\n\n`);
    for (const item of decision.items) {
      process.stdout.write(`  ${item.recommended ? "★" : " "} ${item.id}\n      ${item.title}\n      ${item.summary}\n`);
    }
    process.stdout.write(`\n  amp approve ${decision.id}                # take the recommendation\n`);
    process.stdout.write(`  amp approve ${decision.id} --select a,b   # choose, in this order\n`);
    process.stdout.write(`  amp approve ${decision.id} --none         # skip today\n`);
  }
  process.stdout.write("\n");
  return 0;
}

async function commandApprove(runtime: Runtime, options: Options): Promise<number> {
  const decisionId = options.command[1];
  if (!decisionId) {
    process.stderr.write("Which decision? Run `amp pending` to see the ids.\n");
    return 2;
  }
  const decision = await runtime.services.store.decisions.get(decisionId);
  if (!decision) {
    process.stderr.write(`No decision "${decisionId}".\n`);
    return 1;
  }

  // `--select` with no usable ids used to fall through as "approve nothing",
  // which resolves the decision as a rejection - and a resolved decision cannot
  // be resolved again, so a typo silently cost the day's publishing with no way
  // back. Rejecting everything is a real answer, but it has its own flag.
  if (!options.none && options.select !== undefined) {
    const known = new Set(decision.items.map((item) => item.id));
    const unknown = options.select.filter((id) => !known.has(id));
    if (options.select.length === 0 || unknown.length === options.select.length) {
      process.stderr.write(
        `--select matched nothing in ${decisionId}. Nothing was decided.\n` +
          `  Available: ${decision.items.map((item) => item.id).join(", ")}\n` +
          `  To reject the whole slate on purpose, use --none.\n`,
      );
      return 2;
    }
    if (unknown.length > 0) {
      process.stderr.write(`Ignoring ids that are not in this decision: ${unknown.join(", ")}\n`);
    }
  }

  const selected = options.none
    ? []
    : (options.select ?? decision.items.filter((item) => item.recommended).map((item) => item.id));
  const ordering = options.order ?? selected;

  const result = await runtime.orchestrator.resolveGate(decisionId, {
    decidedBy: runtime.config.company.operator,
    selectedIds: selected,
    ordering,
    nowIso: runtime.services.clock.nowIso(),
  });
  if (!result.ok) {
    process.stderr.write(`${describeError(result.error)}\n`);
    return 1;
  }

  process.stdout.write(
    `${selected.length === 0 ? "Rejected everything" : `Approved ${selected.length}`}. ` +
      `Cycle is now ${result.value.status}` +
      (result.value.nextStep ? ` at "${result.value.nextStep}"` : "") +
      ".\n",
  );
  if (result.value.pendingDecisionId && result.value.pendingDecisionId !== decisionId) {
    process.stdout.write(`Next: amp approve ${result.value.pendingDecisionId}\n`);
  }
  return 0;
}

async function commandDispatch(runtime: Runtime): Promise<number> {
  const result = await runtime.orchestrator.dispatchDue(runtime.services.clock.now());
  if (!result.ok) {
    process.stderr.write(`${describeError(result.error)}\n`);
    return 1;
  }
  process.stdout.write(
    `Published ${result.value.published.length}, failed ${result.value.failed.length}, ` +
      `${result.value.stillWaiting} still waiting for their slot.\n`,
  );
  if (result.value.held > 0) {
    process.stdout.write(
      `${result.value.held} post(s) whose slot has passed are held by a stop. ` +
        `They go out when you run \`amp resume\`.\n`,
    );
  }
  if (result.value.commentsWithheld > 0) {
    process.stdout.write(
      `${result.value.commentsWithheld} post(s) went live on the channel's own schedule while ` +
        `stopped, so their comments — including the link — were not added. ` +
        `Resuming does not add them later; decide at the channel.\n`,
    );
  }
  for (const failure of result.value.failed) {
    process.stderr.write(`  ✗ ${failure.postId}: ${failure.reason}\n`);
  }
  return result.value.failed.length === 0 ? 0 : 1;
}

type StopTarget = {
  readonly dataDir: string;
  readonly path: string;
  /** Undefined when the config did not validate, so ids cannot be checked. */
  readonly ventureIds: readonly string[] | undefined;
};

/**
 * Reads just enough config to know where the data lives. Everything the stop
 * needs and nothing that can be broken by a bad credential - or by a config
 * that does not validate. Full validation is the right gate for starting a
 * cycle and the wrong one for stopping: a file half-edited, or an unset
 * `${VAR}`, must not be the reason the stop button does nothing. When the
 * config fails to load, `runtime.dataDir` is taken from the raw YAML instead.
 */
function stopTarget(options: Options): StopTarget | undefined {
  loadDotEnv(repoRoot());
  let path: string;
  try {
    path = resolveConfigPath(options.config ? { explicit: options.config } : {});
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return undefined;
  }

  try {
    const loaded = loadConfigSync({ explicit: path });
    return { dataDir: loaded.dataDir, path, ventureIds: loaded.config.ventures.map((venture) => venture.id) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(path, "utf8"));
    } catch {
      process.stderr.write(
        `${message}\n${path} could not be read as YAML, so there is no way to know where the data lives. ` +
          `To stop anyway, write the word STOP into <dataDir>/paused.json by hand - an unreadable stop file counts as stopped.\n`,
      );
      return undefined;
    }
    const runtime = isPlainObject(raw) ? get(raw, "runtime") : undefined;
    const declared = isPlainObject(runtime) ? get(runtime, "dataDir") : undefined;
    const dataDir = typeof declared === "string" && declared.trim() !== "" ? declared.trim() : ".amp";
    process.stderr.write(
      `${message}\nThe config did not validate. Stopping anyway, using runtime.dataDir (${dataDir}) from the raw file. ` +
        `Venture ids cannot be checked until the config loads.\n`,
    );
    return { dataDir: isAbsolute(dataDir) ? dataDir : resolvePath(dirname(path), dataDir), path, ventureIds: undefined };
  }
}

async function commandPause(options: Options): Promise<number> {
  const target = stopTarget(options);
  if (!target) return 1;

  const ventureId = options.venture as VentureId | undefined;
  if (ventureId !== undefined && target.ventureIds === undefined) {
    // A partial stop against a config that did not load could name a venture
    // that no longer exists and stop nothing. The whole-company stop needs no
    // ids and is what a broken config calls for anyway.
    process.stderr.write(
      `Cannot check --venture "${ventureId}" against a config that did not load. ` +
        `Stop everything with \`amp pause\` (no --venture), or fix ${target.path} first.\n`,
    );
    return 2;
  }
  if (ventureId !== undefined && target.ventureIds && !target.ventureIds.includes(ventureId)) {
    process.stderr.write(`No venture "${ventureId}" in ${target.path}.\n`);
    return 2;
  }

  // Written before anything else is attempted. Whatever else fails from here -
  // an unreadable store, a missing data directory - the machine is stopped.
  const outcome = await applyPause({
    state: fileState(target.dataDir),
    ...(ventureId ? { ventureId } : {}),
    reason: options.reason ?? "(no reason given)",
    by: "amp pause",
    at: new Date().toISOString(),
  });

  if (!outcome.ok) {
    process.stderr.write(
      `Everything is already stopped, because the stop file could not be read:\n` +
        `  ${outcome.unreadable.reason}\n` +
        `Stopping one venture from here would start the others. Nothing was changed.\n` +
        `Fix or delete ${target.dataDir}/paused.json, or run \`amp resume\` first.\n`,
    );
    return 1;
  }

  const record = pausedBy(outcome.state, ventureId);
  process.stdout.write(`${record ? describePause(record, ventureId) : "Stopped."}\n`);

  // The one thing a stop cannot do. Posts already accepted by a channel's own
  // scheduler will go live on that channel's clock, and the only place to
  // cancel them is the channel itself. Saying so here, at the moment of
  // stopping, is the difference between a stop button and a false one.
  await warnAboutPostsBeyondRecall(target.dataDir, ventureId);
  return 0;
}

async function warnAboutPostsBeyondRecall(dataDir: string, ventureId?: VentureId): Promise<void> {
  let store;
  try {
    store = await createJsonStore({ dataDir, lock: false, owner: "pause" });
  } catch {
    process.stdout.write(
      `\n(Could not read ${dataDir} to check for posts already handed to a channel. ` +
        `The stop is in place; check the channel itself.)\n`,
    );
    return;
  }
  try {
    const nowMs = Date.now();
    const beyondRecall = (
      await store.posts.find(
        (post) =>
          post.status === "scheduled" &&
          post.scheduledFor > nowMs &&
          (ventureId === undefined || post.ventureId === ventureId),
      )
    ).sort((a, b) => a.scheduledFor - b.scheduledFor);

    if (beyondRecall.length === 0) return;
    process.stdout.write(
      `\n⚠  ${beyondRecall.length} post(s) are already with the channel's own scheduler and ` +
        `will still go live. Cancel them in the channel:\n`,
    );
    for (const post of beyondRecall) {
      process.stdout.write(
        `   ${new Date(post.scheduledFor).toISOString()}  ${post.ventureId}  ` +
          `${post.externalId ?? "(no channel id)"}  ${truncateLine(post.content.hook)}\n`,
      );
    }
  } finally {
    await store.close();
  }
}

async function commandResume(options: Options): Promise<number> {
  const target = stopTarget(options);
  if (!target) return 1;

  const ventureId = options.venture as VentureId | undefined;
  const outcome = await applyResume({
    state: fileState(target.dataDir),
    ...(ventureId ? { ventureId } : {}),
  });

  if (!outcome.ok) {
    process.stderr.write(
      `Everything is stopped, so resuming one venture would change nothing.\n` +
        `  Stopped ${outcome.blockedByAll.at} (${outcome.blockedByAll.by}): ${outcome.blockedByAll.reason}\n` +
        `Run \`amp resume\` with no --venture to start everything.\n`,
    );
    return 1;
  }

  const scope = ventureId === undefined ? "Everything" : `Venture "${ventureId}"`;
  process.stdout.write(
    outcome.wasPaused
      ? `${scope} is running again. Posts whose slot passed while stopped go out on the next dispatch.\n`
      : `${scope} was not stopped. Nothing changed.\n`,
  );
  return 0;
}

function truncateLine(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

async function commandReport(runtime: Runtime, options: Options): Promise<number> {
  const days = options.days ?? 7;
  const ventures = selectVentures(runtime, options);
  const nowMs = runtime.services.clock.now();

  for (const ventureId of ventures) {
    const venture = runtime.config.ventures.find((entry) => entry.id === ventureId);
    if (!venture) continue;
    const offers = runtime.config.offers.filter((offer) => venture.offers.includes(offer.id));
    const performance = await computePerformance(runtime.services.store, {
      ventureId,
      nowMs,
      sinceMs: nowMs - days * 86_400_000,
      offers,
      defaultCurrency: offers[0]?.currency ?? "JPY",
    });
    const patterns = await runtime.services.store.patterns.find((pattern) => pattern.ventureId === ventureId);

    process.stdout.write(`\n=== ${venture.name} — last ${days} days ===\n\n`);
    const counts = totalCounts(performance.totals.values());
    process.stdout.write(`market       ${venture.market}\n`);
    process.stdout.write(`posts        ${performance.rows.length}\n`);
    process.stdout.write(`median score ${Math.round(performance.medianScore)}\n`);
    process.stdout.write(`clicks       ${counts.clicks}\n`);
    process.stdout.write(`conversions  ${counts.conversions}\n`);
    process.stdout.write(`approved     ${formatMoney(performance.totals, "approvedRevenue")}\n`);
    process.stdout.write(`pending      ${formatMoney(performance.totals, "pendingRevenue")}\n\n`);
    process.stdout.write(`${formatPostPerformance(performance.rows, 10)}\n\n`);

    const active = patterns.filter((pattern) => pattern.status === "active");
    process.stdout.write(`playbook     ${active.length} active / ${patterns.length} total\n`);
    for (const pattern of active.sort((a, b) => b.confidence - a.confidence).slice(0, 6)) {
      process.stdout.write(`  ${pattern.confidence.toFixed(2)}  ${pattern.name}\n        ${pattern.template}\n`);
    }
  }
  process.stdout.write("\n");
  return 0;
}

async function commandStatement(runtime: Runtime, options: Options): Promise<number> {
  const days = options.days ?? 30;
  const nowMs = runtime.services.clock.now();
  const period = {
    fromIso: new Date(nowMs - days * 86_400_000).toISOString(),
    toIso: new Date(nowMs).toISOString(),
    days,
  };

  if (runtime.config.licensing.model === "none" && runtime.config.licensing.overrides.length === 0) {
    process.stdout.write(
      "licensing.model is \"none\" — nothing is billed.\n" +
        "Set it to \"subscription\" or \"revshare\" in platform.config.yaml if you operate this\n" +
        "instance on someone else's behalf. See docs/7-references/configuration.md.\n",
    );
    return 0;
  }

  const statements = [];
  for (const ventureId of selectVentures(runtime, options)) {
    const venture = runtime.config.ventures.find((entry) => entry.id === ventureId);
    if (!venture) continue;
    const offers = runtime.config.offers.filter((offer) => venture.offers.includes(offer.id));
    const performance = await computePerformance(runtime.services.store, {
      ventureId,
      nowMs,
      sinceMs: nowMs - days * 86_400_000,
      offers,
      defaultCurrency: offers[0]?.currency ?? "JPY",
    });
    statements.push(
      buildStatement({
        licensing: runtime.config.licensing,
        ventureId,
        ventureName: venture.name,
        totals: performance.totals,
        period,
      }),
    );
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ period, statements }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write("\n=== Statement ===\n\n");
  for (const statement of statements) {
    process.stdout.write(`${renderStatement(statement, period)}\n\n`);
  }
  process.stdout.write(
    "This is arithmetic, not an invoice. No tax is applied and no money moves.\n" +
      "Amounts are never converted between currencies.\n\n",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Exploring
// ---------------------------------------------------------------------------

async function commandScout(runtime: Runtime, options: Options): Promise<number> {
  // The same 1-10 the schema allows for the scheduled run. A flag is not a
  // way around a bound that exists to keep one model call readable.
  const count = options.count === undefined ? undefined : Math.min(10, Math.max(1, options.count));
  const result = await runScout(runtime.services, {
    ...(count !== undefined ? { count } : {}),
    state: runtime.state,
  });
  if (!result.ok) {
    process.stderr.write(`${describeError(result.error)}\n`);
    return 1;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
    return 0;
  }
  const { proposals, dropped } = result.value;
  process.stdout.write(`\n=== The scout proposes ${proposals.length} account(s) ===\n\n`);
  for (const proposal of proposals) process.stdout.write(`${describeProposal(proposal)}\n\n`);
  if (dropped.length > 0) {
    process.stdout.write(`Refused by the guardrails (${dropped.length}):\n`);
    for (const entry of dropped) process.stdout.write(`  ✗ ${entry.niche}: ${entry.reason}\n`);
    process.stdout.write("\n");
  }
  if (proposals.length > 0) {
    process.stdout.write(
      "Accept one with `amp scout accept <id>` - it prints the ventures[] block to paste into platform.config.yaml.\n" +
        "Decline with `amp scout dismiss <id> --reason \"…\"`. Nothing changes until you paste.\n",
    );
  }
  return 0;
}

async function commandScoutList(runtime: Runtime, options: Options): Promise<number> {
  const proposals = await listProposals(runtime.services.store, options.all ? undefined : "proposed");
  if (options.json) {
    process.stdout.write(`${JSON.stringify(proposals, null, 2)}\n`);
    return 0;
  }
  if (proposals.length === 0) {
    process.stdout.write(
      options.all ? "No proposals yet. `amp scout` asks for some.\n" : "No proposals waiting. `amp scout` asks for new ones; `--all` shows decided ones.\n",
    );
    return 0;
  }
  for (const proposal of proposals) process.stdout.write(`${describeProposal(proposal)}\n\n`);
  return 0;
}

/**
 * One proposal in full, with its block. This is how an accepted proposal's
 * block is read again: the console only keeps it for a while, and `accept`
 * refuses to decide twice.
 */
async function commandScoutShow(runtime: Runtime, options: Options): Promise<number> {
  const proposalId = options.command[2];
  if (!proposalId) {
    process.stderr.write("Usage: amp scout show <proposal-id>\n");
    return 2;
  }
  const proposal = await runtime.services.store.proposals.get(proposalId);
  if (!proposal) {
    process.stderr.write(`No proposal "${proposalId}". \`amp scout list --all\` shows every one.\n`);
    return 2;
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...proposal, block: renderVentureBlock(proposal, runtime.config) }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${describeProposal(proposal)}\n\n`);
  process.stdout.write(
    proposal.status === "accepted"
      ? `Accepted${proposal.resolvedBy ? ` by ${proposal.resolvedBy}` : ""}. The block to paste under \`ventures:\`:\n\n`
      : proposal.status === "dismissed"
        ? `Dismissed${proposal.resolutionNote ? `: ${proposal.resolutionNote}` : ""}. For reference, the block it would have become:\n\n`
        : "Not decided yet. If accepted, this is the block it becomes:\n\n",
  );
  process.stdout.write(`${renderVentureBlock(proposal, runtime.config)}\n\n`);
  return 0;
}

async function commandScoutResolve(
  runtime: Runtime,
  options: Options,
  status: "accepted" | "dismissed",
): Promise<number> {
  const proposalId = options.command[2];
  if (!proposalId) {
    process.stderr.write(`Usage: amp scout ${status === "accepted" ? "accept" : "dismiss"} <proposal-id>\n`);
    return 2;
  }
  const result = await resolveProposal(runtime.services, {
    proposalId,
    status,
    by: runtime.config.company.operator,
    nowIso: runtime.services.clock.nowIso(),
    ...(options.reason ? { note: options.reason } : {}),
  });
  if (!result.ok) {
    process.stderr.write(`${result.error.message}\n`);
    return result.error.kind === "not_found" ? 2 : 1;
  }
  if (status === "dismissed") {
    process.stdout.write(`Dismissed "${result.value.niche}".\n`);
    return 0;
  }
  const block = renderVentureBlock(result.value, runtime.config);
  if (!options.printOnly) {
    const nowIso = runtime.services.clock.nowIso();
    const appended = await appendVentureBlock(runtime.loaded.path, block, join(runtime.loaded.dataDir, "config-backups"), { nowIso });
    if (appended.ok) {
      await markAppended(runtime.services.store, result.value.id, appended.value, nowIso);
      process.stdout.write(
        `Accepted "${result.value.niche}" and appended it to ${appended.value.configPath} under \`ventures:\`, ` +
          `as active: false. The previous file is at ${appended.value.backupPath}.\n\n` +
          `Open the config, read the voice, set active: true when it reads right, then restart the daemon. ` +
          `Nothing runs until you do. \`amp scout show ${result.value.id}\` prints the block again.\n\n`,
      );
      process.stdout.write(`${block}\n\n`);
      return 0;
    }
    process.stderr.write(`${appended.error.message}\n\n`);
  }
  process.stdout.write(
    `Accepted "${result.value.niche}".\n\n` +
      `Paste this under \`ventures:\` in ${runtime.loaded.path}, adjust the voice, set active: true, ` +
      `then restart the daemon. \`amp scout show ${result.value.id}\` prints it again.\n\n`,
  );
  process.stdout.write(`${block}\n\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Switching accounts on and off
// ---------------------------------------------------------------------------

async function commandVentureSwitch(runtime: Runtime, options: Options, on: boolean): Promise<number> {
  const ventureId = options.command[2] as VentureId | undefined;
  if (!ventureId) {
    process.stderr.write(`Usage: amp venture ${on ? "activate" : "deactivate"} <venture-id>\n`);
    return 2;
  }
  const venture = runtime.config.ventures.find((entry) => entry.id === ventureId);
  if (!venture) {
    process.stderr.write(`No venture "${ventureId}" in ${runtime.loaded.path}.\n`);
    return 2;
  }
  const dataDir = runtime.loaded.dataDir;
  const nowIso = runtime.services.clock.nowIso();
  // The audit log is append-only lines, which is why this is safe without the
  // data lock the daemon holds: nothing is rewritten. The same click in the
  // console leaves the same record, so the trail does not depend on the surface.
  const audit = (type: string, summary: string): Promise<void> =>
    runtime.services.store.audit.append({
      id: runtime.services.ids.next("evt"),
      at: nowIso,
      ventureId,
      type,
      actor: runtime.config.company.operator,
      summary,
      data: {},
    });
  if (!on) {
    const reason = options.reason ?? "";
    const state = await deactivateVenture(runtime.state, ventureId, { at: nowIso, by: runtime.config.company.operator, reason });
    await audit("venture.deactivated", `Deactivated "${venture.name}"${reason ? `: ${reason}` : ""}.`);
    process.stdout.write(`${describeInactive(venture, state)}\n`);
    const held = await runtime.services.store.posts.find((post) => post.ventureId === ventureId && post.status === "approved");
    if (held.length > 0) {
      process.stdout.write(`${held.length} approved post(s) are held and will go out if the account is reactivated.\n`);
    }
    // Same distinction the stop draws: a post the channel's own scheduler
    // already holds is on the channel's clock, and deactivating here does not
    // reach it.
    await warnAboutPostsBeyondRecall(dataDir, ventureId);
    return 0;
  }
  const { wasInactive } = await reactivateVenture(runtime.state, ventureId);
  await audit("venture.activated", `Reactivated "${venture.name}".`);
  if (!venture.active) {
    process.stdout.write(
      `Cleared the operator's deactivation, but "${ventureId}" has active: false in ${runtime.loaded.path}. ` +
        `Set it to true and restart the daemon.\n`,
    );
    return 0;
  }
  process.stdout.write(wasInactive ? `Venture "${ventureId}" is running again.\n` : `Venture "${ventureId}" was not deactivated.\n`);
  return 0;
}

async function commandVentureList(runtime: Runtime, options: Options): Promise<number> {
  const state = readVentureState(runtime.state);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        runtime.config.ventures.map((venture) => ({
          id: venture.id,
          name: venture.name,
          active: isVentureActive(venture, state),
          configActive: venture.active,
          deactivated: state.inactive[venture.id] ?? null,
        })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (state.warning) process.stderr.write(`${state.warning}\n`);
  for (const venture of runtime.config.ventures) {
    process.stdout.write(`${venture.id}  ${venture.name}\n  ${describeInactive(venture, state)}\n`);
  }
  return 0;
}

async function commandPortfolio(runtime: Runtime, options: Options): Promise<number> {
  const portfolio = await buildPortfolio({
    config: runtime.config,
    store: runtime.services.store,
    nowMs: runtime.services.clock.now(),
    days: options.days ?? 30,
    state: runtime.state,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(portfolio, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`\n${renderPortfolio(portfolio)}\n\n`);
  return 0;
}

async function commandConsole(runtime: Runtime): Promise<number> {
  const started = await startConsole(runtime);
  if (!started.ok) {
    process.stderr.write(`${describeError(started.error)}\n`);
    return 1;
  }
  process.stdout.write(`Approval console: ${started.value.url}\n`);
  process.stdout.write(
    `Tracking redirect: ${runtime.config.tracking.baseUrl}${REDIRECT_PATH}<code> → served here at ${REDIRECT_PATH}<code>\n`,
  );
  process.stdout.write("Ctrl-C to stop.\n");
  await waitForSignal();
  await started.value.close();
  return 0;
}

async function commandDaemon(runtime: Runtime): Promise<number> {
  const state = readVentureState(runtime.state);
  for (const venture of runtime.config.ventures.filter((entry) => isVentureActive(entry, state))) {
    process.stdout.write(
      `${venture.id}: cycle starts ${venture.cadence.cycleStartsAt} ${venture.timezone}, ` +
        `up to ${venture.cadence.postsPerDay} posts/day\n`,
    );
  }
  const daemon = await startDaemon(runtime, { withConsole: true });
  await waitForSignal();
  process.stdout.write("\nStopping…\n");
  await daemon.stop();
  return 0;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function withRuntime(
  options: Options,
  runtimeOptions: Pick<RuntimeOptions, "lock" | "owner">,
  run: (runtime: Runtime, options: Options) => Promise<number>,
): Promise<number> {
  const created = await createRuntime({
    ...(options.config ? { configPath: options.config } : {}),
    dryRun: options.dryRun,
    ...runtimeOptions,
  });
  if (!created.ok) {
    process.stderr.write(`${formatStartupError(created.error)}\n`);
    return 1;
  }
  try {
    return await run(created.value, options);
  } finally {
    await created.value.close();
  }
}

function formatStartupError(error: PlatformError): string {
  // Config problems are the common case and the message already reads well;
  // repeating the code in front of it just adds noise.
  return error.kind === "config" ? error.message : describeError(error);
}

function selectVentures(runtime: Runtime, options: Options): string[] {
  const state = readVentureState(runtime.state);
  const active = runtime.config.ventures.filter((venture) => isVentureActive(venture, state)).map((venture) => venture.id);
  if (!options.venture) return active;
  return active.filter((id) => id === options.venture);
}

function noVenture(options: Options): number {
  process.stderr.write(
    options.venture
      ? `No active venture "${options.venture}".\n`
      : "No active ventures in the config.\n",
  );
  return 1;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    command: [],
    dryRun: false,
    none: false,
    all: false,
    printOnly: false,
    json: false,
    help: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--none":
        options.none = true;
        break;
      case "--all":
        options.all = true;
        break;
      case "--print-only":
        options.printOnly = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--venture":
        options.venture = next();
        break;
      case "--config":
        options.config = next();
        break;
      case "--until":
        options.until = next();
        break;
      case "--date":
        options.date = next();
        break;
      case "--days": {
        const value = Number(next());
        if (Number.isFinite(value) && value > 0) options.days = Math.floor(value);
        break;
      }
      case "--count": {
        const value = Number(next());
        if (Number.isFinite(value) && value > 0) options.count = Math.floor(value);
        break;
      }
      case "--select":
        options.select = splitList(next());
        break;
      case "--order":
        options.order = splitList(next());
        break;
      case "--reason":
        options.reason = next();
        break;
      default:
        if (arg.startsWith("-")) {
          process.stderr.write(`Unknown option "${arg}" — ignoring it.\n`);
          break;
        }
        positional.push(arg);
    }
  }

  options.command = positional;
  return options;
}

/**
 * `cycle` and `scout` are the two-word commands; everything else takes
 * arguments. `scout` alone is a command too, so its second word is only part
 * of the key when it is one of the known sub-commands.
 */
export function commandKey(positional: readonly string[]): string {
  if (positional[0] === "cycle") return `cycle ${positional[1] ?? ""}`.trim();
  // Any second word becomes part of the key, so `scout acept` is an unknown
  // command rather than a run of the scout - which calls the model and stores
  // proposals, the opposite of the no-cost accept that was meant.
  if (positional[0] === "scout" && positional[1] !== undefined) return `scout ${positional[1]}`;
  if (positional[0] === "venture") return `venture ${positional[1] ?? ""}`.trim();
  return positional[0] ?? "";
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((cause) => {
      process.stderr.write(`${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
      process.exitCode = 1;
    });
}

export { main };
