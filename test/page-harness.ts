/**
 * Runs the console's page script the way a browser would.
 *
 * Every test of `src/console/` before this one read the page as text: does it
 * contain this heading, does it carry this word. A page that could not be
 * parsed at all passed every one of them, and did - the console shipped with
 * `(s) => {"running":"動作中"}[s]` in it, sat on 読み込み中… and was inert.
 * Two more escapes had been eaten by the template literal the page is written
 * inside, and those still parse, so even parsing it would not have been enough.
 *
 * So this executes it: a small DOM, and a `fetch` pointed at the real router,
 * so the page runs against the JSON the console actually serves. What it does
 * not cover is layout and events - there is no CSS and no pointer here. What
 * it does cover is every line between "the server answered" and "the operator
 * reads a sentence", which is where this project's elementary bugs live.
 */

import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

/** Only the surface the page touches. Anything else is a bug in this stub. */
export type FakeElement = {
  id: string;
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  readonly style: Record<string, string>;
  readonly dataset: Record<string, string>;
  value: string;
  checked: boolean;
  disabled: boolean;
  addEventListener(): void;
  querySelectorAll(): FakeElement[];
  querySelector(): FakeElement | null;
  closest(): FakeElement | null;
  getAttribute(): string | null;
  setAttribute(): void;
  appendChild(): void;
  remove(): void;
  getBoundingClientRect(): { width: number; left: number };
};

function element(id: string): FakeElement {
  return {
    id,
    innerHTML: "",
    textContent: "",
    hidden: false,
    style: {},
    dataset: {},
    value: "",
    checked: false,
    disabled: false,
    addEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    getAttribute: () => null,
    setAttribute: () => {},
    appendChild: () => {},
    remove: () => {},
    getBoundingClientRect: () => ({ width: 100, left: 0 }),
  };
}

export type PageRun = {
  /** Every element the page asked for, by id, with what it wrote into it. */
  readonly elements: Map<string, FakeElement>;
  /** Shorthand for `elements.get(id).innerHTML`, or "" for an id never touched. */
  html(id: string): string;
  /** Paths the page requested, in order. */
  readonly requests: readonly string[];
};

export type PageOptions = {
  /** The console's base URL, e.g. http://127.0.0.1:1234 */
  readonly base: string;
  /** A passphrase that opens it. */
  readonly token: string;
  /** The address the page thinks it is at, e.g. "#/ventures/main". */
  readonly hash?: string;
  /** An id whose content means the render has happened. */
  readonly until: string;
};

/** Fetches the real page, runs its script, and returns what it rendered. */
export async function openPage(options: PageOptions): Promise<PageRun> {
  const { base, token, hash = "", until } = options;
  const page = await fetch(`${base}/?token=${encodeURIComponent(token)}`);
  assert.equal(page.status, 200, "the console did not serve its page");
  const html = await page.text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
  assert.equal(scripts.length, 1, "the page is supposed to carry exactly one script");

  const elements = new Map<string, FakeElement>();
  const requests: string[] = [];
  const context = {
    console,
    URL,
    JSON,
    Math,
    Date,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    // The page polls every thirty seconds. Letting that through would hold the
    // test process open long after the assertion is done.
    setInterval: () => 0,
    clearInterval: () => {},
    document: {
      getElementById(id: string) {
        const found = elements.get(id) ?? element(id);
        elements.set(id, found);
        return found;
      },
      addEventListener: () => {},
      querySelectorAll: () => [],
    },
    window: {
      location: { hash, origin: base },
      addEventListener: () => {},
      scrollTo: () => {},
      prompt: () => "",
      confirm: () => true,
      localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    },
    async fetch(path: string, init?: RequestInit) {
      requests.push(path);
      return globalThis.fetch(`${base}${path}`, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${token}` },
      });
    },
  };

  runInNewContext(scripts[0]!, context, { filename: "console-page.js" });

  // `load()` is fired at the end of the script and is async. Wait for the
  // element the caller named to have something in it.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((elements.get(until)?.innerHTML ?? "") !== "") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.notEqual(
    elements.get(until)?.innerHTML ?? "",
    "",
    `the page never rendered #${until}. Requests: ${requests.join(", ") || "none"}`,
  );

  return {
    elements,
    html: (id) => elements.get(id)?.innerHTML ?? "",
    requests,
  };
}
