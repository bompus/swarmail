// The source hash scripts/build.ts compiles into the binary with `--define`; null when running from source.
declare const SWARMAIL_SOURCE: string | undefined;
export const buildSource: string | null =
  typeof SWARMAIL_SOURCE === "string" ? SWARMAIL_SOURCE : null;
