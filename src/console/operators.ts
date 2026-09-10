/**
 * Who is holding the console open.
 *
 * The console used to have one passphrase, and every approval it recorded said
 * `company.operator` - whoever had actually pressed the button. That is not a
 * gap you can close later: an approval written in 2026 says the owner's name
 * forever, and on the day a second person starts operating, the whole history
 * becomes "one of two".
 *
 * So a passphrase carries a name. One operator needs no configuration at all
 * (the owner, holding `console.tokenEnv`); anyone else is a `console.operators`
 * entry naming their own env var. Nothing else changes: no roles, no accounts,
 * no sign-up. Every named holder can still do everything, exactly as before -
 * the difference is only that the record is true.
 */

import type { PlatformConfig } from "../config/schema.ts";

export type Operator = {
  readonly name: string;
  readonly token: string;
};

/**
 * The operators whose passphrase is actually set, the owner first.
 *
 * An entry whose env var is missing or blank is dropped rather than admitted
 * with an empty secret: `Cookie: amp_console=` opening the console is a bug
 * this project has already had once, and it is worth not being able to have
 * again.
 */
export function resolveOperators(
  config: PlatformConfig,
  env: Readonly<Record<string, string | undefined>>,
): Operator[] {
  const declared: readonly { name: string; tokenEnv: string }[] = [
    { name: config.company.operator, tokenEnv: config.console.tokenEnv },
    ...config.console.operators,
  ];
  const operators: Operator[] = [];
  for (const entry of declared) {
    const token = env[entry.tokenEnv]?.trim();
    if (token) operators.push({ name: entry.name, token });
  }
  return operators;
}

/**
 * Which operator is missing a passphrase, for `doctor` and the console's own
 * startup to say so by name. A listed person whose env var is unset cannot get
 * in, and the only symptom otherwise is their passphrase "not working".
 */
export function operatorsWithoutTokens(
  config: PlatformConfig,
  env: Readonly<Record<string, string | undefined>>,
): { name: string; tokenEnv: string }[] {
  return config.console.operators.filter((entry) => !env[entry.tokenEnv]?.trim());
}
