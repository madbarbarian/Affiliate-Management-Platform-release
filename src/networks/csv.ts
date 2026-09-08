/**
 * An affiliate network read from its own CSV export.
 *
 * This is the adapter most operators will actually use. Almost no consumer
 * affiliate network gives publishers a conversion API - A8.net, もしも,
 * バリューコマース, afb, アクセストレード, ShareASale, CJ, Rakuten Advertising
 * and Amazon Associates all hand you a report to download instead. Writing a
 * bespoke adapter per network would be nine integrations that break whenever a
 * dashboard changes; reading the file they already produce does not.
 *
 * Drop the exports in a directory, map the columns once in config, and the
 * analysis role picks them up on its next run. Conversions are deduplicated by
 * the network's own id, so re-importing the same file is harmless - which
 * matters, because an operator will absolutely re-download last month's report.
 *
 * Japanese networks commonly export Shift_JIS; set `options.encoding`.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

import { fail, ok, tryAsync, type PlatformError, type Result } from "../core/result.ts";
import type { ConversionStatus, Offer } from "../core/types.ts";
import type { NetworkConversion, NetworkFactoryContext, OfferNetwork } from "./network.ts";

type ColumnMap = {
  externalId: string;
  subId: string;
  at: string;
  amount: string;
  currency?: string;
  status?: string;
};

const DEFAULT_COLUMNS: ColumnMap = {
  externalId: "order_id",
  subId: "subid",
  at: "date",
  amount: "amount",
  currency: "currency",
  status: "status",
};

/**
 * How networks spell the three states. Extend per network via
 * `options.statusMap` rather than editing this - it is only a starting point.
 */
const DEFAULT_STATUS_MAP: Record<string, ConversionStatus> = {
  approved: "approved",
  confirmed: "approved",
  paid: "approved",
  承認: "approved",
  確定: "approved",
  成果確定: "approved",
  pending: "pending",
  open: "pending",
  未確定: "pending",
  保留: "pending",
  rejected: "rejected",
  declined: "rejected",
  reversed: "rejected",
  却下: "rejected",
  キャンセル: "rejected",
  非承認: "rejected",
};

export function createCsvNetwork(context: NetworkFactoryContext): OfferNetwork {
  const reportsDir = String(context.options["reportsDir"] ?? "");
  const encoding = String(context.options["encoding"] ?? "utf-8");
  const delimiter = String(context.options["delimiter"] ?? ",");
  const subIdParam = String(context.options["subIdParam"] ?? "subid");
  const defaultCurrency = String(context.options["currency"] ?? "JPY");
  const columns: ColumnMap = { ...DEFAULT_COLUMNS, ...readColumnMap(context.options["columns"]) };
  const statusMap: Record<string, ConversionStatus> = {
    ...DEFAULT_STATUS_MAP,
    ...readStatusMap(context.options["statusMap"]),
  };
  /** Rows dated before this are ignored regardless of the `since` argument. */
  const amountScale = Number(context.options["amountScale"] ?? 1);
  /** Minutes east of UTC that the export's local timestamps are written in. */
  const timezoneOffsetMinutes = Number(context.options["timezoneOffsetMinutes"] ?? 0);

  /** Files the last import could not read. Reported by healthCheck. */
  let unreadable: { file: string; reason: string }[] = [];

  return {
    id: context.id,
    adapter: "csv",

    async listOffers(): Promise<Result<Offer[], PlatformError>> {
      // A report tells you what converted, never what is available to promote.
      return ok([]);
    },

    async fetchConversions(sinceIso): Promise<Result<NetworkConversion[], PlatformError>> {
      if (reportsDir === "") {
        return fail("config", "network.no_reports_dir", `Network "${context.id}" needs options.reportsDir.`);
      }
      if (!existsSync(reportsDir)) {
        // An empty inbox is normal, not a failure - the operator may not have
        // downloaded this week's report yet.
        return ok([]);
      }

      const listing = await tryAsync("storage", "network.reports_unreadable", () =>
        readdir(reportsDir, { withFileTypes: true }),
      );
      if (!listing.ok) return listing;

      const since = Date.parse(sinceIso);
      const conversions: NetworkConversion[] = [];
      const seen = new Set<string>();
      const skipped: { file: string; reason: string }[] = [];

      for (const entry of listing.value) {
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".csv") continue;
        const path = join(reportsDir, entry.name);

        // One unreadable file - a partial download, a permissions problem, a
        // stray non-report - used to abandon the whole import, throwing away
        // every valid report sitting next to it. Skip it loudly and carry on:
        // some revenue recorded beats none.
        const read = await tryAsync("storage", "network.report_unreadable", () => readFile(path));
        if (!read.ok) {
          skipped.push({ file: entry.name, reason: read.error.message });
          continue;
        }

        let text: string;
        try {
          text = new TextDecoder(encoding).decode(read.value);
        } catch (cause) {
          return fail(
            "config",
            "network.bad_encoding",
            `Network "${context.id}" is configured with encoding "${encoding}", which this Node build cannot decode. ` +
              `Try "utf-8" or "shift_jis".`,
            { cause },
          );
        }

        const rows = parseCsv(stripBom(text), delimiter);
        const header = rows.shift();
        if (!header) continue;

        const index = buildIndex(header);
        const missing = (["externalId", "subId", "at", "amount"] as const).filter(
          (field) => index.get(normaliseHeader(columns[field])) === undefined,
        );
        if (missing.length > 0) {
          return fail(
            "config",
            "network.column_missing",
            `${entry.name} has no column for ${missing.map((field) => `${field} ("${columns[field]}")`).join(", ")}. ` +
              `Its headers are: ${header.join(", ")}. Fix options.columns for network "${context.id}".`,
          );
        }

        for (const row of rows) {
          const cell = (field: keyof ColumnMap): string => {
            const name = columns[field];
            if (!name) return "";
            const position = index.get(normaliseHeader(name));
            return position === undefined ? "" : (row[position] ?? "").trim();
          };

          const externalId = cell("externalId");
          const subId = cell("subId");
          if (externalId === "" || subId === "") continue;
          if (seen.has(externalId)) continue;

          const at = parseDate(cell("at"), timezoneOffsetMinutes);
          if (at === undefined) continue;
          if (Number.isFinite(since) && at < since) continue;

          seen.add(externalId);
          conversions.push({
            externalId,
            subId,
            at: new Date(at).toISOString(),
            amount: parseAmount(cell("amount")) * amountScale,
            currency: cell("currency") || defaultCurrency,
            status: readStatus(statusMap, cell("status")),
          });
        }
      }

      // Surfaced through healthCheck rather than a log line, because `doctor`
      // is where an operator looks and a warning in yesterday's log is not.
      unreadable = skipped;
      return ok(conversions);
    },

    buildTrackedUrl({ landingUrl, subId }) {
      try {
        const url = new URL(landingUrl);
        url.searchParams.set(subIdParam, subId);
        return ok(url.toString());
      } catch (cause) {
        return fail("validation", "network.bad_landing_url", `Offer landing URL is not a valid URL: ${landingUrl}`, {
          cause,
        });
      }
    },

    async healthCheck(): Promise<Result<string, PlatformError>> {
      if (reportsDir === "") {
        return fail("config", "network.no_reports_dir", `Network "${context.id}" needs options.reportsDir.`);
      }
      if (!existsSync(reportsDir)) {
        return ok(`csv network ready - ${reportsDir} does not exist yet (drop exports there)`);
      }
      const entries = await readdir(reportsDir);
      const files = entries.filter((name) => extname(name).toLowerCase() === ".csv");
      const base = `csv network ready - ${files.length} report(s) in ${reportsDir}, decoded as ${encoding}`;
      return unreadable.length === 0
        ? ok(base)
        : ok(
            `${base}. ${unreadable.length} could not be read on the last import and were skipped: ` +
              `${unreadable.map((entry) => entry.file).join(", ")}`,
          );
    },
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 with the delimiter left configurable, because plenty of exports are
 * tab- or semicolon-separated. Handles quoted fields containing the delimiter,
 * newlines, and doubled quotes - all three of which turn up in real product
 * names and break a naive `split(",")`.
 */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i] as string;

    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field === "") {
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (character === "\r") continue;
    if (character === "\n") {
      row.push(field);
      // Skip blank lines rather than emitting a one-empty-field row.
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += character;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function buildIndex(header: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, position) => {
    const key = normaliseHeader(name);
    if (!index.has(key)) index.set(key, position);
  });
  return index;
}

/** Exports differ in case, spacing and BOM placement. Match forgivingly. */
function normaliseHeader(name: string): string {
  return name.replace(/^﻿/, "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Accepts what real exports contain: ISO, `YYYY/MM/DD HH:mm`, and
 * `YYYY年MM月DD日`. Anything else is skipped rather than guessed at, because a
 * misread date silently shifts revenue into the wrong reporting window.
 */
export function parseDate(value: string, timezoneOffsetMinutes = 0): number | undefined {
  const text = value.trim();
  if (text === "") return undefined;

  // `YYYY年MM月DD日` and `YYYY/MM/DD` come from an ASP writing in its own
  // timezone, not UTC. Reading them as UTC shifted every JST date nine hours,
  // which moves conversions across the window boundary in both directions.
  // `timezoneOffsetMinutes` says which zone the export is written in.
  const japanese = /^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?/.exec(text);
  if (japanese) {
    return localToEpoch(
      Number(japanese[1]),
      Number(japanese[2]) - 1,
      Number(japanese[3]),
      Number(japanese[4] ?? 0),
      Number(japanese[5] ?? 0),
      0,
      timezoneOffsetMinutes,
    );
  }

  const slashed = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (slashed) {
    return localToEpoch(
      Number(slashed[1]),
      Number(slashed[2]) - 1,
      Number(slashed[3]),
      Number(slashed[4] ?? 0),
      Number(slashed[5] ?? 0),
      Number(slashed[6] ?? 0),
      timezoneOffsetMinutes,
    );
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** A wall-clock time in the export's own timezone, as epoch ms. */
function localToEpoch(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  offsetMinutes: number,
): number {
  return Date.UTC(year, monthIndex, day, hour, minute, second) - offsetMinutes * 60_000;
}

/** Strips currency symbols, thousands separators and stray whitespace. */
export function parseAmount(value: string): number {
  const cleaned = value.replace(/[^0-9.\-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readColumnMap(raw: unknown): Partial<ColumnMap> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Partial<ColumnMap> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && key in DEFAULT_COLUMNS) {
      out[key as keyof ColumnMap] = value;
    }
  }
  return out;
}

/**
 * Looks a reported status up in the map, ignoring case and surrounding space.
 *
 * The map's keys are lower-case and the lookup was not, so an ASP exporting
 * "Approved" - which the shipped Impact example maps exactly - fell through to
 * "pending". Approved revenue then stayed zero forever: no report showed
 * earnings, no pattern gained evidence from a conversion, and a revshare
 * statement billed nothing. Headers were already matched case-insensitively;
 * the values were not, and that inconsistency was the whole bug.
 */
function readStatus(
  statusMap: Record<string, ConversionStatus>,
  reported: string,
): ConversionStatus {
  const key = reported.trim().toLowerCase();
  return statusMap[key] ?? statusMap[reported.trim()] ?? "pending";
}

function readStatusMap(raw: unknown): Record<string, ConversionStatus> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ConversionStatus> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Lower-cased on the way in so an operator writing "Approved" in their
    // config matches an ASP exporting "APPROVED". Both halves normalise, or
    // neither works.
    if (value === "approved" || value === "pending" || value === "rejected") {
      out[key.trim().toLowerCase()] = value;
    }
  }
  return out;
}
