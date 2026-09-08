/**
 * Is the measurement chain closed?
 *
 * The platform's whole claim is that it learns from what happened. That rests
 * on an unbroken chain:
 *
 *   post -> engagement -> tracked link -> click -> conversion -> approved revenue
 *
 * Every link is implemented. Nothing, until now, checked that a particular
 * venture's configuration actually joins them up - so an operation could run
 * for a month on simulated numbers, or with a redirect nobody was serving,
 * and look healthy the whole time. The cost is not a missing report; it is a
 * month of learning built on nothing, and a month that cannot be re-measured
 * because the clicks were never recorded.
 *
 * This is a configuration check, not a live one. It answers "can this ever
 * work", not "did anything happen today" - which is the question worth asking
 * before the first post, when there is nothing to measure yet.
 */

import type { PlatformConfig } from "../config/schema.ts";
import type { VentureId } from "../core/types.ts";

export type ChainStep = "publish" | "engagement" | "link" | "conversion" | "revenue";

export type ChainLink = {
  readonly step: ChainStep;
  /** True when this link can carry real data. */
  readonly ok: boolean;
  /** What is wrong and what to change. Empty when `ok`. */
  readonly problem: string;
};

export type MeasurementChain = {
  readonly ventureId: VentureId;
  /** True only when every link can carry real data. */
  readonly closed: boolean;
  readonly links: readonly ChainLink[];
};

const STEP_LABEL: Readonly<Record<ChainStep, string>> = {
  publish: "post reaches a channel",
  engagement: "the channel reports numbers back",
  link: "readers can follow a tracked link",
  conversion: "the network reports conversions",
  revenue: "a conversion is worth a known amount",
};

export function stepLabel(step: ChainStep): string {
  return STEP_LABEL[step];
}

export function describeMeasurementChain(
  config: PlatformConfig,
  ventureId: VentureId,
): MeasurementChain {
  const venture = config.ventures.find((entry) => entry.id === ventureId);
  if (!venture) {
    return {
      ventureId,
      closed: false,
      links: [{ step: "publish", ok: false, problem: `No venture "${ventureId}" in the config.` }],
    };
  }

  const channels = config.channels.filter(
    (channel) => venture.channels.includes(channel.id) && channel.enabled,
  );
  const offers = config.offers.filter((offer) => venture.offers.includes(offer.id) && offer.active);
  const networkById = new Map(config.networks.map((network) => [network.id, network]));

  const links: ChainLink[] = [];

  links.push(
    channels.length > 0
      ? pass("publish")
      : problem(
          "publish",
          `Venture "${venture.id}" has no enabled channel. Enable one of ` +
            `${venture.channels.map((id) => `"${id}"`).join(", ") || "(none listed)"} under \`channels\`.`,
        ),
  );

  // The mock adapters exist so the whole loop runs before anyone has an
  // account. Left in place once real posting starts they are worse than
  // nothing: the reports look right and every number in them is invented.
  const simulatedChannels = channels.filter((channel) => channel.adapter === "mock");
  links.push(
    simulatedChannels.length === 0 && channels.length > 0
      ? pass("engagement")
      : problem(
          "engagement",
          simulatedChannels.length > 0
            ? `Channel(s) ${list(simulatedChannels.map((c) => c.id))} use the "mock" adapter. ` +
                `Their engagement numbers are simulated, so nothing this venture learns is real. ` +
                `Set a real \`adapter\` before you post for an audience.`
            : "No channel to report engagement.",
        ),
  );

  links.push(linkStep(config));

  const offersWithoutNetwork = offers.filter((offer) => !networkById.has(offer.network));
  const simulatedNetworks = offers
    .map((offer) => networkById.get(offer.network))
    .filter((network) => network !== undefined && (network.adapter === "mock" || !network.enabled));

  links.push(
    offers.length === 0
      ? problem(
          "conversion",
          `Venture "${venture.id}" carries no active offer, so there is nothing to convert. ` +
            `Add one under \`offers\` and list it in the venture.`,
        )
      : offersWithoutNetwork.length > 0
        ? problem(
            "conversion",
            `Offer(s) ${list(offersWithoutNetwork.map((o) => o.id))} name a network that is not ` +
              `configured. Add it under \`networks\`.`,
          )
        : simulatedNetworks.length > 0
          ? problem(
              "conversion",
              `Network(s) ${list(simulatedNetworks.map((n) => n!.id))} are disabled or use the ` +
                `"mock" adapter, so no real conversion will ever arrive. Use the "csv" adapter ` +
                `with your ASP's report export, or a real integration.`,
            )
          : pass("conversion"),
  );

  const unpriced = offers.filter((offer) => offer.payoutValue <= 0 || offer.currency.trim() === "");
  links.push(
    offers.length > 0 && unpriced.length === 0
      ? pass("revenue")
      : problem(
          "revenue",
          offers.length === 0
            ? "No offer, so no revenue to attribute."
            : `Offer(s) ${list(unpriced.map((o) => o.id))} have no payout or no currency, so a ` +
                `conversion cannot be valued. Set \`payoutValue\` and \`currency\`.`,
        ),
  );

  return { ventureId, closed: links.every((link) => link.ok), links };
}

/**
 * The click link is the one people are surprised by. Tracked links point at the
 * console's redirect, which only exists while the console is running - so a
 * daemon started with the console disabled hands readers a URL that answers
 * nothing, and records no clicks.
 */
function linkStep(config: PlatformConfig): ChainLink {
  let url: URL;
  try {
    url = new URL(config.tracking.baseUrl);
  } catch {
    return problem(
      "link",
      `tracking.baseUrl is not a URL: "${config.tracking.baseUrl}". Set it to the address ` +
        `readers can reach, e.g. "https://go.example.com".`,
    );
  }

  if (!config.console.enabled) {
    return problem(
      "link",
      "console.enabled is false, but the console is what serves the tracking redirect. " +
        "Every tracked link would 404 and no click would be recorded. Set console.enabled to true.",
    );
  }

  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".invalid");
  if (local) {
    return problem(
      "link",
      `tracking.baseUrl points at "${url.hostname}", which a reader cannot reach. ` +
        `Point it at a hostname that resolves publicly and forwards to this machine's console.`,
    );
  }

  return pass("link");
}

function pass(step: ChainStep): ChainLink {
  return { step, ok: true, problem: "" };
}

function problem(step: ChainStep, detail: string): ChainLink {
  return { step, ok: false, problem: detail };
}

function list(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}
