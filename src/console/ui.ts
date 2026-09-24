/**
 * The approval console's single page.
 *
 * Deliberately one file with no build step and no framework. The operator's
 * whole job is two clicks a day; the tooling around those two clicks should
 * not need a bundler, a lockfile, or a deploy.
 *
 * The page itself - the CSS, the HTML skeleton and the browser-side script -
 * lives under `./page/`, split into pieces that can be read, changed and
 * tested on their own; see that directory for why the boundaries fall where
 * they do. This file's own job is unchanged: compute the values that differ
 * per render (the locale, its messages, the accounts table's column widths)
 * and hand them to those pieces in the order the page was always built in.
 * `renderPage`'s signature, and the fact that it is this file's only export,
 * have not changed.
 */

import { messagesFor, type Locale } from "./messages.ts";
import { portfolioColumns, portfolioStackBelow, portfolioTableWidth } from "./portfolio-columns.ts";
import { pageStyle } from "./page/style.ts";
import { pageShell } from "./page/shell.ts";
import { clientHelpersScript } from "./page/client/helpers.ts";
import { DECISIONS_SCRIPT } from "./page/client/decisions.ts";
import { DECISIONS_REORDER_SCRIPT } from "./page/client/decisions-reorder.ts";
import { DECISIONS_ACTIONS_SCRIPT } from "./page/client/decisions-actions.ts";
import { HAND_OVER_SCRIPT } from "./page/client/hand-over.ts";
import { HAND_OVER_ACTIONS_SCRIPT } from "./page/client/hand-over-actions.ts";
import { TODAY_SCRIPT } from "./page/client/today.ts";
import { VENTURE_ACTIONS_SCRIPT } from "./page/client/venture-actions.ts";
import { VENTURE_SCRIPT } from "./page/client/venture.ts";
import { SETTINGS_SCRIPT } from "./page/client/settings.ts";
import { TIMELINE_SCRIPT } from "./page/client/timeline.ts";
import { LOAD_POLL_SCRIPT } from "./page/client/load-poll.ts";

export function renderPage(options: { companyName: string; locale?: Locale }): string {
  const locale = options.locale ?? "ja";
  const T = messagesFor(locale);
  const t = (key: keyof typeof T): string => T[key];
  // The accounts table's layout is arithmetic on its own column widths, not a
  // set of round numbers chosen next to them. Every one of the three defects
  // the owner walked through came from a number that had been written twice.
  const columns = portfolioColumns(T);
  const tableWidth = portfolioTableWidth(columns);
  const stackBelow = portfolioStackBelow(columns);
  // Two selectors need these, and plain CSS has no way to give one declaration
  // block two of them when one is inside a media query. One string, used twice,
  // beats one palette maintained twice.
  // Joined rather than written as a template literal: `dark` crosses into
  // `pageStyle`'s own literal (`./page/style.ts`) as a plain argument, not by
  // being spliced into a surrounding one - this file does not hold the page
  // any more, so the backtick-counting test now guards each piece under
  // `./page/` on its own rather than this file as a whole.
  const dark = [
    "color-scheme: dark;",
    "--bg: #14141a; --panel: #1e1e25; --ink: #f0f0ee; --muted: #a8a8a4;",
    "--line: #35353e; --line-strong: #46464f; --accent: #7fcf9f; --accent-ink: #102016;",
    "--warn: #efbe6c; --danger: #f08c74; --chip: #2c2c35;",
    "--row-alt: #232330; --row-hover: #2b2b38;",
  ].join(" ");
  const style = pageStyle(tableWidth, stackBelow, dark);
  // In the exact order the original single file held them - the client script
  // is one program, and nothing here reorders a line of it.
  const script =
    clientHelpersScript(T, columns) +
    DECISIONS_SCRIPT +
    HAND_OVER_SCRIPT +
    TODAY_SCRIPT +
    HAND_OVER_ACTIONS_SCRIPT +
    VENTURE_ACTIONS_SCRIPT +
    DECISIONS_REORDER_SCRIPT +
    SETTINGS_SCRIPT +
    TIMELINE_SCRIPT +
    DECISIONS_ACTIONS_SCRIPT +
    VENTURE_SCRIPT +
    LOAD_POLL_SCRIPT;
  return pageShell(options, locale, t, style, script);
}
