/**
 * Builds a module the way `wrangler deploy` builds the Worker, and loads it.
 *
 * Node runs this repository by stripping types and nothing else, so every test
 * that imports `src/` runs the code exactly as written. Cloudflare never does:
 * wrangler puts the Worker through esbuild first, and esbuild rewrites it - by
 * default it wraps named functions in `__name(...)` so that `.name` survives
 * bundling. Anything a page carries that came out of that rewrite is something
 * no other test here has ever seen.
 *
 * That is not hypothetical. The console's wait judgement was carried to the
 * browser as `fn.toString()`, so on Cloudflare it arrived with `__name` calls in
 * it, on a page that defines no `__name`, and threw on its first poll. From
 * v0.7.0 on, the two buttons pressed every day stayed on 動かしています… for
 * good on every deploy - while every test in this directory was green.
 *
 * esbuild is wrangler's own, resolved from wrangler's package rather than
 * imported by name: the version doing this transform is then the version that
 * deploys, and it is not a second dependency that could drift from it.
 */

import { Buffer } from "node:buffer";
import { createRequire } from "node:module";

type Esbuild = {
  build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};

const fromHere = createRequire(import.meta.url);
const esbuild = createRequire(fromHere.resolve("wrangler/package.json"))("esbuild") as Esbuild;

/**
 * What wrangler hands esbuild for a modules Worker (`bundleWorker` in
 * wrangler-dist/cli.js), minus what only matters for the Worker's own entry.
 *
 * `keepNames` is written out although it is wrangler's default
 * (`keep_names ?? true`): a page has to survive the transform a licensee gets
 * without touching wrangler.jsonc, so turning it off there must not turn it
 * off here.
 */
const AS_WRANGLER_DOES = {
  bundle: true,
  format: "esm",
  target: "es2024",
  conditions: ["workerd", "worker", "browser"],
  keepNames: true,
} as const;

/**
 * `entry` bundled as wrangler would, then imported.
 *
 * `minify` is what `wrangler deploy --minify` adds. Checking both is how a test
 * says "whatever the next transform is", rather than "this one".
 */
export async function importAsWranglerBuildsIt<T>(entry: string, options: { minify?: boolean } = {}): Promise<T> {
  const result = await esbuild.build({
    ...AS_WRANGLER_DOES,
    entryPoints: [entry],
    minify: options.minify ?? false,
    write: false,
    logLevel: "silent",
  });
  const code = result.outputFiles[0]!.text;
  // A data: URL rather than a file: the output has no imports left to resolve,
  // and nothing is left behind in a temporary directory.
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as T;
}
