/**
 * The deployed entry point: the handlers, with the bundle the build produced.
 *
 * Kept apart from `handler.ts` so the handlers can be built with a different
 * bundle in a test - this repository's own build has no licensee config, so
 * the configured path would otherwise never be exercised.
 */

import { createWorker } from "./handler.ts";
import { configSource, configText, prompts, release } from "./bundled.generated.ts";

export { TickLock } from "./lock-do.ts";

export default createWorker({ configSource, configText, prompts, ...(release ? { release } : {}) });
