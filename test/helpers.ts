/**
 * Test scaffolding: a whole company, deterministic, with no network.
 *
 * Fixed clock, sequential ids, in-memory storage and the mock adapters mean a
 * cycle can be replayed exactly, which is what makes assertions about the
 * learning loop possible at all.
 */

import { join } from "node:path";

import { fixedClock, type Clock } from "../src/core/clock.ts";
import { createEventBus } from "../src/core/events.ts";
import { sequentialIds } from "../src/core/ids.ts";
import { silentLogger } from "../src/core/logger.ts";
import { unwrap } from "../src/core/result.ts";
import { parseConfig, type PlatformConfig } from "../src/config/schema.ts";
import { repoRoot } from "../src/config/load.ts";
import { findMarket, resolveCompliance } from "../src/domain/market.ts";
import { createChannelRegistry } from "../src/channels/index.ts";
import { createNetworkRegistry } from "../src/networks/index.ts";
import { createPromptLibrary } from "../src/kernel/prompts.ts";
import { createOrchestrator, type Orchestrator } from "../src/kernel/orchestrator.ts";
import type { Services } from "../src/kernel/role.ts";
import { createMockProvider, type MockProvider } from "../src/llm/mock.ts";
import { createDemoHandlers } from "../src/llm/demo.ts";
import { createMemoryStore } from "../src/storage/memory-store.ts";
import type { Store } from "../src/storage/store.ts";

export const BASE_CONFIG = {
  version: 2,
  company: { name: "Test Co", operator: "tester", autonomy: "assisted" },
  runtime: { dataDir: ".amp-test", promptsDir: "prompts", logLevel: "error", logFormat: "json" },
  llm: { provider: "mock", model: "claude-opus-5", fastModel: "claude-haiku-4-5" },
  console: { enabled: false, host: "127.0.0.1", port: 4399, tokenEnv: "AMP_TEST_TOKEN" },
  policy: {
    requireDisclosure: true,
    disclosureText: "#PR",
    maxAiSmellScore: 60,
    blockOnComplianceFindings: true,
    bannedPhrases: ["いかがでしたか"],
    prohibitedClaims: ["必ず稼げる"],
    maxPostsPerDay: 2,
    minMinutesBetweenPosts: 120,
    metricsWindowHours: 72,
  },
  tracking: { baseUrl: "https://go.test.invalid", linkParam: "amp", extraParams: { utm_source: "test" } },
  markets: [
    {
      id: "jp",
      name: "日本",
      language: "ja",
      currency: "JPY",
      timezone: "Asia/Tokyo",
      disclosureText: "#PR",
      regulator: "消費者庁（景品表示法）",
      prohibitedClaims: ["必ず痩せる"],
      restrictedCategories: [
        { category: "health", note: "薬機法：効能効果は標榜できない", prohibited: false },
        { category: "gambling", note: "賭博罪：日本では取り扱えない", prohibited: true },
      ],
      crossBorderNotice: "海外事業者との直接契約になる旨を明記すること",
    },
    {
      id: "us",
      name: "United States",
      language: "en",
      currency: "USD",
      timezone: "America/New_York",
      disclosureText: "#ad",
      regulator: "FTC Endorsement Guides",
      prohibitedClaims: ["guaranteed income"],
      restrictedCategories: [],
      crossBorderNotice: "",
    },
  ],
  channels: [
    {
      id: "threads",
      adapter: "mock",
      enabled: true,
      credentialEnv: {},
      research: { queries: ["副業"], minLikes: 100, maxItems: 12, lookbackHours: 24 },
      options: { maxCharacters: 500, seed: "test" },
    },
  ],
  networks: [
    {
      id: "demo",
      adapter: "mock",
      enabled: true,
      credentialEnv: {},
      options: { subIdParam: "subid", conversionRate: 1, payout: 1000, currency: "JPY" },
    },
  ],
  offers: [
    {
      id: "offer_test",
      network: "demo",
      name: "テスト商材",
      landingUrl: "https://example.com/lp",
      payoutModel: "cpa",
      payoutValue: 1000,
      currency: "JPY",
      category: "productivity",
      originMarket: "jp",
      targetMarkets: ["jp"],
      crossBorderNote: "",
      complianceNotes: [],
      active: true,
    },
  ],
  ventures: [
    {
      id: "main",
      name: "テスト運用",
      niche: "AI活用",
      audience: "副業を始めたい会社員",
      market: "jp",
      timezone: "Asia/Tokyo",
      language: "ja",
      active: true,
      channels: ["threads"],
      offers: ["offer_test"],
      voice: {
        persona: "元編集者",
        firstPerson: "僕",
        tone: ["率直"],
        bannedPhrases: [],
        signaturePhrases: ["結論から言うと"],
      },
      cadence: { postsPerDay: 2, minMinutesBetweenPosts: 120, cycleStartsAt: "06:30", ideasPerCycle: 6 },
    },
  ],
} as const;

export function testConfig(overrides: Record<string, unknown> = {}): PlatformConfig {
  return parseConfig({ ...structuredClone(BASE_CONFIG), ...overrides }, "test-config");
}

export type TestCompany = {
  readonly services: Services;
  readonly orchestrator: Orchestrator;
  readonly store: Store;
  readonly clock: ReturnType<typeof fixedClock>;
  readonly llm: MockProvider;
  readonly config: PlatformConfig;
};

export function createTestCompany(
  options: {
    startIso?: string;
    config?: PlatformConfig;
    responses?: Record<string, (request: never) => unknown>;
  } = {},
): TestCompany {
  const config = options.config ?? testConfig();
  const clock = fixedClock(options.startIso ?? "2026-04-01T21:00:00Z"); // 06:00 JST
  const store = createMemoryStore();
  const llm = createMockProvider({
    responses: { ...createDemoHandlers(), ...(options.responses ?? {}) } as never,
  });

  const services: Services = {
    config,
    clock: clock as Clock,
    ids: sequentialIds(),
    logger: silentLogger,
    llm,
    store,
    channels: unwrap(
      createChannelRegistry({ channels: config.channels, env: {}, nowMs: () => clock.now() }),
    ),
    networks: unwrap(
      createNetworkRegistry({
        networks: config.networks,
        env: {},
        nowMs: () => clock.now(),
        knownSubIds: () => knownCodes,
      }),
    ),
    prompts: createPromptLibrary(join(repoRoot(), "prompts")),
    bus: createEventBus(),
  };

  // The mock network converts against links the company has actually issued.
  let knownCodes: string[] = [];
  services.bus.on("*", () => {
    void store.links.all().then((links) => {
      knownCodes = links.map((link) => link.code);
    });
  });

  return { services, orchestrator: createOrchestrator(services), store, clock, llm, config };
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** The compliance profile for the test config's JP venture. */
export function testProfile(config: PlatformConfig, offerId?: string) {
  const venture = config.ventures[0]!;
  const offer = offerId ? config.offers.find((entry) => entry.id === offerId) : undefined;
  return resolveCompliance({
    policy: config.policy,
    market: findMarket(config.markets, venture.market),
    ...(offer ? { offer } : {}),
  });
}
