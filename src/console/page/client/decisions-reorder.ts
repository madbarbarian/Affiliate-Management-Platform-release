/**
 * move(): reorders a decision's selected items for the up/down buttons
 * renderDecision (decisions.ts) draws. Split into its own file rather than
 * folded into decisions.ts because in the original page it sits between the
 * venture-action listeners, not next to renderDecision.
 */

export const DECISIONS_REORDER_SCRIPT = `function move(entry, itemId, delta) {
  const index = entry.order.indexOf(itemId);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= entry.order.length) return;
  const [removed] = entry.order.splice(index, 1);
  entry.order.splice(target, 0, removed);
}

/**
 * What is in force for the whole company, to read.
 *
 * Two of these rows are why this screen exists. Until now neither the autonomy
 * setting nor the model provider appeared anywhere on this page, so a licensee could be
 * running unattended, or running on the simulated model with nothing real being
 * written, and have no way to find that out from the console. Those two say so
 * in the warning colour when they are set to something worth knowing; the rest
 * is reference.
 */
`;
