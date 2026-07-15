import { parseArgs, type ParseArgsConfig } from "node:util";

export class UsageError extends Error {
  override name = "UsageError";
}

export type CliOptionConfig = NonNullable<ParseArgsConfig["options"]>;

export function parseCommandArgs(
  args: string[],
  options: CliOptionConfig,
): { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] } {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    return {
      values: parsed.values as Record<string, string | boolean | string[] | undefined>,
      positionals: parsed.positionals,
    };
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

export function onePath(positionals: string[], label = "path"): string | undefined {
  if (positionals.length > 1) throw new UsageError(`expected at most one ${label}`);
  return positionals[0];
}

export function requiredString(
  values: Record<string, string | boolean | string[] | undefined>,
  name: string,
): string {
  const value = values[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}

export function optionalString(
  values: Record<string, string | boolean | string[] | undefined>,
  name: string,
): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

export function stringList(
  values: Record<string, string | boolean | string[] | undefined>,
  name: string,
): string[] | undefined {
  const value = values[name];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return undefined;
}

export function enabledValue(
  values: Record<string, string | boolean | string[] | undefined>,
): boolean | undefined {
  if (values.enabled && values.disabled) {
    throw new UsageError("--enabled and --disabled cannot be combined");
  }
  if (values.enabled) return true;
  if (values.disabled) return false;
  return undefined;
}

const PORTABLE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_ID = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** IDs used in shared paths and Vault account names must work on every supported OS. */
export function isPortableId(value: string): boolean {
  return PORTABLE_ID.test(value)
    && !WINDOWS_RESERVED_ID.test(value)
    && !value.endsWith(".");
}
