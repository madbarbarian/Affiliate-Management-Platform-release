/**
 * The console page's HTML skeleton: the head, the header, and the three
 * views' markup. style and script are the fully rendered strings from
 * style.ts and the pieces composed in ui.ts - this file only glues them
 * into the document at the same two points they always sat.
 *
 * escapeHtml moved here from ui.ts because every call to it is inside this
 * markup; nothing else in the split ever needed it.
 */

import type { Locale, MessageKey } from "../messages.ts";

export function pageShell(
  options: { companyName: string; locale?: Locale },
  locale: Locale,
  t: (key: MessageKey) => string,
  style: string,
  script: string,
): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.companyName)} — ${escapeHtml(t('page.titleSuffix'))}</title>
<style>${style}</style>
</head>
<body>
<header>
  <h1>${escapeHtml(options.companyName)}</h1>
  <span style="flex:1"></span>
  <!-- Who you are approving as sits in the furniture, next to the refresh
       button, because it does not change all session and every other tool puts
       it here. It used to share a grey span with the waiting count, where a
       name read as a role and both were skipped. -->
  <!-- Two views became three, which is where a way between them starts to
       earn its place. Links rather than buttons: they are navigation, and the
       browser's back button should work on them. -->
  <nav><a href="#/">${escapeHtml(t("nav.today"))}</a><a href="#/settings">${escapeHtml(t("nav.settings"))}</a></nav>
  <span class="who" id="who" hidden></span>
  <!-- The operator's own answer to "is this readable where I am". Next to
       refresh because it is furniture, not a decision: it changes nothing about
       the operation and is remembered per browser, like the column widths. The
       label is here as well as in applyTheme so it is never an empty pill in
       the frame before the page's script runs. -->
  <button id="theme" title="${escapeHtml(t("page.themeTitle"))}">${escapeHtml(t("theme.auto"))}</button>
  <button id="refresh">${escapeHtml(t("page.refresh"))}</button>
</header>
<main>
  <div id="stopped"></div>
  <!-- Below the stop banner on purpose: stopping is an emergency, an update
       never is. Empty until the check answers, so a licensee who is current -
       or offline - sees nothing at all rather than a box that says nothing. -->
  <div id="update"></div>
  <!-- Whether a slow press is still working. Outside every view because the
       card a message like this used to go in is rebuilt by the poll, and at
       the ideas gate it is gone from the screen altogether. -->
  <div id="notice" hidden></div>

<div id="view-today">
  <!--
    Which account is in what state - nothing account-specific and actionable.
    decisions.md, 2026-09-23: with the owner running three accounts, a single
    company-wide list of judgement and a single company-wide schedule stopped
    being "today's 30 seconds" and started being three accounts' worth of
    decisions poured into one list with no section between them. Both moved to
    each account's own screen (#/ventures/<id>, below in #view-venture), which
    already filtered to one account before this strip existed. What is left on
    this page is the answer to "which account needs a look" - not the look
    itself.
  -->
  <section id="status-strip-section">
    <h2>${escapeHtml(t("status.heading"))}</h2>
    <div id="status-strip"><p class="empty">${escapeHtml(t("page.loading"))}</p></div>
  </section>

  <section id="portfolio-section">
    <h2 id="accounts-head"></h2>
    <p class="muted">${t("accounts.lede")}</p>
    <div id="portfolio"></div>
  </section>

  <section id="proposals-section">
    <h2>${escapeHtml(t("scout.heading"))}</h2>
    <div id="proposals"></div>
  </section>

  <section>
    <!-- Empty until render(): the window length is {days} from /api/state,
         the same value the accounts table's own heading names, and this is
         not known at the time this shell is served. -->
    <h2 id="stats-head"></h2>
    <div id="stats"></div>
  </section>

  <section>
    <h2>${escapeHtml(t("today.activity"))}</h2>
    <div id="activity"></div>
  </section>
</div>

<!--
  The account. Same page, a different route: the list is for comparing and this
  is for understanding and fixing one account, and a screen that does both ends
  up doing neither - an API error in a comparison row took the whole table once.
-->
<div id="view-venture" hidden>
  <p><a class="back" href="#/">${escapeHtml(t("venture.back"))}</a></p>
  <!-- The gate, on the screen the operator opened to deal with this account.
       Above everything else here for the same reason it is at the top of the
       day's page: it is the only thing on either screen that is waiting on a
       person. Filled by render(), never by renderVenture() - the tick, the
       reorder and the select-all buttons all call render() alone, and a gate
       drawn anywhere else would freeze the moment one was pressed. -->
  <div id="venture-decisions"></div>
  <div id="venture-head"></div>
  <!--
    予約中の投稿 and the hand-over cards, moved here from the day's page
    (decisions.md, 2026-09-23). They were never company-wide reports - each
    row and each card already belonged to one account - the day's page just
    showed every account's at once. This is that same list and those same
    cards, filtered to this account, so removing them from the top page loses
    nothing: it only removes the other accounts' rows a reader here never
    wanted anyway.
  -->
  <section>
    <h2>${escapeHtml(t("today.upcoming"))}</h2>
    <div id="venture-hand-over"></div>
    <div id="venture-upcoming"></div>
  </section>
  <section>
    <h2>${escapeHtml(t("venture.lastCycle"))}</h2>
    <div id="venture-cycle"></div>
  </section>
  <section>
    <h2>${escapeHtml(t("venture.history"))}</h2>
    <div id="venture-history"></div>
  </section>
  <section>
    <h2 id="venture-numbers-head"></h2>
    <div id="venture-numbers"></div>
  </section>
  <section>
    <h2 id="venture-playbook-head"></h2>
    <div id="venture-playbook"></div>
  </section>
  <section>
    <h2>${escapeHtml(t("setup.heading"))}</h2>
    <p class="muted">${escapeHtml(t("setup.lede"))}</p>
    <div id="venture-setup"></div>
  </section>
  <section>
    <h2>${escapeHtml(t("switch.heading"))}</h2>
    <div id="venture-switch"></div>
  </section>
</div>

<div id="view-settings" hidden>
  <p><a class="back" href="#/">${escapeHtml(t("venture.back"))}</a></p>
  <section>
    <h2>${escapeHtml(t("settings.heading"))}</h2>
    <p class="muted">${escapeHtml(t("settings.lede"))}</p>
    <div id="settings-body"><p class="empty">${escapeHtml(t("page.loading"))}</p></div>
  </section>
</div>
</main>

<script type="module">${script}</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
