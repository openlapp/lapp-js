import fs from "node:fs";
import {
  credentialBindingForProvider,
  loadProfile,
  openSystemCredentialVault,
  resolveLappRoot,
  upsertProvider,
  type LappProfile,
  type ProviderConfig,
} from "@openlapp/lapp";
import {
  onePath,
  isPortableId,
  optionalString,
  parseCommandArgs,
  requiredString,
  UsageError,
  type CliOptionConfig,
} from "../args.js";
import { printJson, redact } from "../output.js";
import { readSecretInput } from "../secret-input.js";
import { writeProfileWithVault } from "./vault-transaction.js";

const VAULT_REF = /^vault:\/\/([a-z0-9][a-z0-9._-]{0,63})\/([a-z0-9][a-z0-9._-]{0,63})$/;

const commonOptions = {
  provider: { type: "string" },
  id: { type: "string" },
  json: { type: "boolean" },
} satisfies CliOptionConfig;

function profileFrom(positionals: string[]): LappProfile {
  const root = resolveLappRoot(onePath(positionals));
  if (!fs.existsSync(root)) throw new Error(`profile does not exist: ${root}`);
  return loadProfile({ path: root });
}

function providerFrom(profile: LappProfile, providerId: string): ProviderConfig {
  const provider = profile.providers.find((entry) => entry.config.id === providerId);
  if (!provider) throw new Error(`provider not found: ${providerId}`);
  return provider.config;
}

function credentialRef(provider: ProviderConfig, requestedId?: string): { ref: string; credentialId: string } {
  let credentialId = requestedId;
  if (credentialId === undefined && provider.auth.type !== "none") {
    const match = VAULT_REF.exec(provider.auth.secret);
    if (match?.[1] === provider.id) credentialId = match[2];
  }
  credentialId ??= "default";
  if (!isPortableId(credentialId)) throw new UsageError("--id must be a portable credential id");
  return { ref: `vault://${provider.id}/${credentialId}`, credentialId };
}

function printCredentialPlan(
  ref: string,
  applied: boolean,
  action: "set" | "delete",
  sensitiveValues: readonly string[] = [],
): void {
  console.log(`${action}: ${redact(ref, sensitiveValues)}`);
  if (!applied) console.log(`not ${action === "set" ? "written" : "deleted"}; pass --yes to apply`);
}

export async function commandCredential(argv: string[]): Promise<void> {
  const sub = argv.shift();
  if (!sub || !["set", "status", "delete"].includes(sub)) {
    throw new UsageError("credential requires set, status, or delete");
  }
  const { values, positionals } = parseCommandArgs(argv, sub === "set"
    ? {
        ...commonOptions,
        stdin: { type: "boolean" },
        overwrite: { type: "boolean" },
        yes: { type: "boolean" },
        "dry-run": { type: "boolean" },
      }
    : sub === "delete"
      ? {
          ...commonOptions,
          yes: { type: "boolean" },
          "dry-run": { type: "boolean" },
        }
      : commonOptions);
  if (values.yes && values["dry-run"]) throw new UsageError("--yes and --dry-run cannot be combined");

  const profile = profileFrom(positionals);
  const providerId = requiredString(values, "provider");
  const provider = providerFrom(profile, providerId);
  const { ref, credentialId } = credentialRef(provider, optionalString(values, "id"));

  if (sub === "status") {
    const binding = credentialBindingForProvider(provider);
    if (!binding) throw new UsageError("credential status requires an authenticated provider");
    const status = await (await openSystemCredentialVault()).status(ref, binding);
    const data = {
      providerId,
      credentialId,
      ref,
      available: status.exists && status.bindingMatches === true,
      ...(status.exists ? { bindingMatches: status.bindingMatches === true } : {}),
    };
    if (values.json) printJson({ credential: data });
    else {
      console.log(`${ref}: ${status.exists && status.bindingMatches === true ? "available" : "unavailable"}`);
      if (status.bindingMatches !== undefined) {
        console.log(`binding: ${status.bindingMatches ? "matches" : "mismatch"}`);
      }
    }
    return;
  }

  const apply = Boolean(values.yes) && !values["dry-run"];
  if (sub === "delete") {
    if (!apply) {
      if (values.json) printJson({ credential: { providerId, credentialId, ref, deleted: false, applied: false } });
      else printCredentialPlan(ref, false, "delete");
      return;
    }
    const deleted = await (await openSystemCredentialVault()).delete(ref);
    if (values.json) printJson({ credential: { providerId, credentialId, ref, deleted, applied: true } });
    else console.log(`${deleted ? "deleted" : "not found"}: ${ref}`);
    return;
  }

  if (provider.auth.type === "none") {
    throw new UsageError("credential set requires an authenticated provider; use provider set first");
  }
  if (values.json && apply && !values.stdin) {
    throw new UsageError("credential set --json requires --stdin when applying");
  }
  const next = upsertProvider(profile, {
    id: providerId,
    auth: provider.auth.type === "bearer"
      ? { type: "bearer", secret: ref }
      : { type: provider.auth.type, name: provider.auth.name, secret: ref },
  });
  const secret = apply
    ? await readSecretInput(Boolean(values.stdin), `Credential for ${providerId}/${credentialId}: `)
    : "";
  let result: Awaited<ReturnType<typeof writeProfileWithVault>>;
  try {
    result = await writeProfileWithVault(profile, next, {
      apply,
      dryRun: Boolean(values["dry-run"]),
    }, apply ? { ref, secret, overwrite: Boolean(values.overwrite) } : undefined);
  } catch (error) {
    if (error instanceof Error) error.message = redact(error.message, [secret]);
    throw error;
  }
  if (values.json) {
    printJson({
      credential: {
        providerId: redact(providerId, [secret]),
        credentialId: redact(credentialId, [secret]),
        ref: redact(ref, [secret]),
        applied: result.applied,
        changes: result.changes.map((change) => ({
          ...change,
          path: redact(change.path, [secret]),
        })),
      },
    });
  } else {
    printCredentialPlan(ref, result.applied, "set", [secret]);
  }
}
