/**
 * The accounts table's columns: what each one is called, how wide it starts,
 * and the widths the page's layout is derived from.
 *
 * This lived inside `ui.ts`'s page script, which is a string no test can call,
 * so the one thing worth checking about it - that a column is wide enough for
 * its own header, in both languages - could only be checked by regex against
 * the page's source. It is a real module now for the same reason `waiting.ts`
 * is: what the browser runs is what the tests run. `ui.ts` serialises the
 * result into the page rather than keeping a second copy.
 *
 * Widths are declared rather than left to the browser because the content
 * decides nothing sensible: one account with a long API error in its 直近サイクル
 * cell took the whole table and left 投稿 and 中央値 a character wide, headers
 * reading downwards. These are minimums that fit the header plus its usual
 * value; anything longer wraps inside its own column, and the operator can drag
 * any border to suit what they are actually looking at.
 */

/** A column as the page receives it: the label already resolved to the locale. */
export type PortfolioColumn = {
  readonly key: string;
  /** "" for the column that holds 開く - the control says what it is. */
  readonly label: string;
  readonly width: number;
  /** Right-aligned and tabular, so a column of figures can be scanned down. */
  readonly numeric?: boolean;
};

type ColumnShape = {
  readonly key: string;
  /** undefined means the column is deliberately unlabelled. */
  readonly labelKey?: string;
  readonly width: number;
  readonly numeric?: boolean;
};

/**
 * The widths are sized for the longer of the two languages, not for Japanese.
 * 成果 is two glyphs and "Conversions" is eleven; a width that fits the first
 * puts the second through its neighbour. One set of widths that holds in both
 * is cheaper than two sets that drift apart.
 */
const SHAPE: readonly ColumnShape[] = [
  { key: "name", labelKey: "accounts.colName", width: 176 },
  { key: "state", labelKey: "accounts.colState", width: 104 },
  { key: "cycle", labelKey: "accounts.colCycle", width: 196 },
  { key: "posts", labelKey: "accounts.colPosts", width: 56, numeric: true },
  { key: "median", labelKey: "accounts.colMedian", width: 62, numeric: true },
  { key: "clicks", labelKey: "accounts.colClicks", width: 68, numeric: true },
  { key: "conversions", labelKey: "accounts.colConversions", width: 92, numeric: true },
  { key: "revenue", labelKey: "accounts.colRevenue", width: 100, numeric: true },
  { key: "playbook", labelKey: "accounts.colPlaybook", width: 72, numeric: true },
  { key: "measurement", labelKey: "accounts.colMeasurement", width: 112 },
  { key: "actions", width: 68 },
];

/** Narrower than this and a column is thinner than its own header. */
export const MIN_COLUMN_WIDTH = 48;

/** `main`'s side padding, twice. The table is bounded by the window, not by main. */
export const PAGE_GUTTER = 32;

/** The columns, labelled in the locale the console is being read in. */
export function portfolioColumns(messages: Readonly<Record<string, string>>): readonly PortfolioColumn[] {
  return SHAPE.map((column) => ({
    key: column.key,
    label: column.labelKey === undefined ? "" : (messages[column.labelKey] ?? column.labelKey),
    width: column.width,
    ...(column.numeric ? { numeric: true as const } : {}),
  }));
}

/**
 * How wide the table is when every column is at its declared width.
 *
 * The page used to carry this as a second number - `min-width: 1180px` in the
 * stylesheet - and the two disagreed: the columns summed to 1378. The table was
 * therefore always 198px wider than the widest container it could ever sit in,
 * so the last column, which holds the only control in the row, was clipped on
 * every screen. Derived here, the two cannot drift again.
 */
export function portfolioTableWidth(columns: readonly PortfolioColumn[]): number {
  return columns.reduce((total, column) => total + column.width, 0);
}

/**
 * Below this window width the table stops being a table.
 *
 * Eleven columns need the width they need; a window narrower than that either
 * scrolls sideways or crushes them, and both are worse than not being a table.
 * So under this the rows become cards - see the media query in `ui.ts`. No
 * column is dropped there: this screen exists to compare accounts, and a
 * comparison missing a number is a wrong comparison, not a smaller one.
 */
export function portfolioStackBelow(columns: readonly PortfolioColumn[]): number {
  return portfolioTableWidth(columns) + PAGE_GUTTER;
}
