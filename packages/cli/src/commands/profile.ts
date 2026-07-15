import fs from "node:fs";
import {
  createProfile,
  inspectProfile,
  listModels,
  loadProfile,
  ModelRefreshError,
  planChanges,
  ProfileValidationError,
  refreshModels,
  removeModel,
  removeProvider,
  resolveLappRoot,
  setDefault,
  TargetResolutionError,
  upsertModel,
  upsertProvider,
  validateProfile,
  writeProfileAtomic,
  type AuthConfig,
  type LappProfile,
  type ModelInput,
  type ProviderInput,
} from "@openlapp/lapp";
import {
  enabledValue,
  isPortableId,
  onePath,
  optionalString,
  parseCommandArgs,
  requiredString,
  stringList,
  UsageError,
  type CliOptionConfig,
} from "../args.js";
import { printJson, redact } from "../output.js";
import { applyPreset, getPreset, listPresets } from "../presets.js";
import { readSecretInput } from "../secret-input.js";
import { writeProfileWithVault, type PendingVaultWrite } from "./vault-transaction.js";

const writeOptions = {
  yes: { type: "boolean" },
  "dry-run": { type: "boolean" },
} satisfies CliOptionConfig;

function pathFrom(positionals: string[]): string {
  return resolveLappRoot(onePath(positionals));
}

function requireExisting(root: string): LappProfile {
  if (!fs.existsSync(root)) throw new Error(`profile does not exist: ${root}`);
  return loadProfile({ path: root });
}

function isEmptyDirectory(root: string): boolean {
  return fs.existsSync(root) && fs.statSync(root).isDirectory() && fs.readdirSync(root).length === 0;
}

async function maybeWrite(
  before: LappProfile | null,
  next: LappProfile,
  values: Record<string, string | boolean | string[] | undefined>,
): Promise<{ applied: boolean; changes: ReturnType<typeof planChanges>["changes"] }> {
  const validation = validateProfile(next);
  if (!validation.valid) {
    throw new ProfileValidationError(validation.diagnostics, "refusing to plan an invalid profile");
  }
  const changes = planChanges(before, next).changes;
  if (!values.yes || values["dry-run"]) return { applied: false, changes };
  await writeProfileAtomic(next, { ...(before ? { before } : {}) });
  return { applied: true, changes };
}

function assertWriteMode(values: Record<string, string | boolean | string[] | undefined>): void {
  if (values.yes && values["dry-run"]) {
    throw new UsageError("--yes and --dry-run cannot be combined");
  }
}

function printPlan(
  result: { applied: boolean; changes: Array<{ kind: string; path: string }> },
  sensitiveValues: readonly string[] = [],
): void {
  for (const change of result.changes) {
    console.log(`${change.kind}: ${redact(change.path, sensitiveValues)}`);
  }
  if (result.changes.length === 0) console.log("no changes");
  else if (!result.applied) console.log("not written; pass --yes to apply");
}

function headers(values: Record<string, string | boolean | string[] | undefined>): Record<string, string> | undefined {
  const specs = stringList(values, "header");
  if (!specs) return undefined;
  return Object.fromEntries(specs.map((spec) => {
    const at = spec.indexOf("=");
    if (at < 1) throw new UsageError("--header must be NAME=VALUE");
    return [spec.slice(0, at), spec.slice(at + 1)];
  }));
}

interface AuthSelection {
  auth?: AuthConfig;
  vaultWrite?: PendingVaultWrite;
  plaintextWarning?: boolean;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function authWithSecret(
  secret: string,
  values: Record<string, string | boolean | string[] | undefined>,
  existing?: AuthConfig,
  preset?: AuthConfig,
): AuthConfig {
  const requestedType = optionalString(values, "auth-type");
  const name = optionalString(values, "auth-name");
  const base = existing && existing.type !== "none"
    ? existing
    : preset && preset.type !== "none" ? preset : undefined;
  const type = requestedType ?? base?.type ?? "bearer";
  if (type === "bearer") {
    if (name) throw new UsageError("--auth-name is not valid for bearer authentication");
    return { type, secret };
  }
  if (type === "header" || type === "query") {
    const resolvedName = name
      ?? (existing?.type === type ? existing.name : undefined)
      ?? (preset?.type === type ? preset.name : undefined);
    if (!resolvedName) throw new UsageError(`--auth-name is required for ${type} authentication`);
    return { type, name: resolvedName, secret };
  }
  throw new UsageError("--auth-type must be bearer, header, or query");
}

async function authFromFlags(
  values: Record<string, string | boolean | string[] | undefined>,
  providerId: string,
  creating: boolean,
  existing?: AuthConfig,
  preset?: AuthConfig,
): Promise<AuthSelection> {
  const vaultId = optionalString(values, "vault");
  const envName = optionalString(values, "env");
  const plaintext = Boolean(values.plaintext);
  const noAuth = Boolean(values["no-auth"]);
  const sources = Number(vaultId !== undefined) + Number(envName !== undefined) + Number(plaintext) + Number(noAuth);
  const implicitVault = creating && sources === 0 && preset?.type !== "none";
  if (sources > 1) {
    throw new UsageError("--vault, --env, --plaintext, and --no-auth are mutually exclusive");
  }
  if (values["allow-plaintext"] && !plaintext) {
    throw new UsageError("--allow-plaintext is only valid with --plaintext");
  }
  if (plaintext && !values["allow-plaintext"]) {
    throw new UsageError("--plaintext requires --allow-plaintext");
  }
  if (values.stdin && !plaintext && vaultId === undefined && !implicitVault) {
    throw new UsageError("--stdin is only valid with --vault or --plaintext");
  }
  if (values.overwrite && vaultId === undefined && !implicitVault) {
    throw new UsageError("--overwrite is only valid with --vault");
  }
  if (noAuth) {
    if (optionalString(values, "auth-type") || optionalString(values, "auth-name") || values.stdin || values.overwrite) {
      throw new UsageError("--no-auth cannot be combined with authentication options");
    }
    return { auth: { type: "none" } };
  }
  if (envName !== undefined) {
    if (!ENV_NAME.test(envName)) throw new UsageError("--env must be a valid environment variable name");
    if (values.stdin || values.overwrite) throw new UsageError("--env cannot be combined with --stdin or --overwrite");
    return { auth: authWithSecret(`env://${envName}`, values, existing, preset) };
  }

  const isApplied = Boolean(values.yes) && !values["dry-run"];
  if (plaintext) {
    const secret = isApplied
      ? await readSecretInput(Boolean(values.stdin), "Plaintext credential: ")
      : "<plaintext-not-read>";
    return {
      auth: authWithSecret(secret, values, existing, preset),
      plaintextWarning: true,
    };
  }

  if (vaultId !== undefined || implicitVault) {
    const credentialId = vaultId ?? "default";
    if (!isPortableId(credentialId)) throw new UsageError("--vault must be a portable credential id");
    const ref = `vault://${providerId}/${credentialId}`;
    const secret = isApplied
      ? await readSecretInput(Boolean(values.stdin), `Credential for ${providerId}/${credentialId}: `)
      : "";
    return {
      auth: authWithSecret(ref, values, existing, preset),
      ...(isApplied ? { vaultWrite: { ref, secret, overwrite: Boolean(values.overwrite) } } : {}),
    };
  }

  if (creating && preset?.type === "none") return { auth: { type: "none" } };
  if (creating) {
    const ref = `vault://${providerId}/default`;
    const secret = isApplied
      ? await readSecretInput(Boolean(values.stdin), `Credential for ${providerId}/default: `)
      : "";
    return {
      auth: authWithSecret(ref, values, existing, preset),
      ...(isApplied ? { vaultWrite: { ref, secret, overwrite: Boolean(values.overwrite) } } : {}),
    };
  }

  const requestedType = optionalString(values, "auth-type");
  const requestedName = optionalString(values, "auth-name");
  if (!requestedType && !requestedName) return {};
  if (!existing || existing.type === "none") {
    throw new UsageError("changing authentication requires --vault, --env, or --plaintext");
  }
  return { auth: authWithSecret(existing.secret, values, existing) };
}

export async function commandValidate(argv: string[]): Promise<void> {
  const { values, positionals } = parseCommandArgs(argv, { json: { type: "boolean" } });
  const root = pathFrom(positionals);
  loadProfile({ path: root });
  if (values.json) printJson({ valid: true, rootDir: root });
  else console.log(`valid: ${root}`);
}

export async function commandInspect(argv: string[]): Promise<void> {
  const { values, positionals } = parseCommandArgs(argv, { json: { type: "boolean" } });
  const inspection = inspectProfile({ path: pathFrom(positionals) });
  if (values.json) {
    printJson(inspection);
    return;
  }
  console.log(`root: ${inspection.rootDir}`);
  for (const provider of inspection.providers) {
    console.log(`${provider.id}: ${provider.protocols.join(", ")} (${provider.modelCount} models)${provider.enabled ? "" : " [disabled]"}`);
  }
  for (const diagnostic of inspection.diagnostics) {
    console.error(`${diagnostic.level}: ${diagnostic.location ? `${diagnostic.location}: ` : ""}${diagnostic.message}`);
  }
}

const providerPatchOptions = {
  id: { type: "string" },
  name: { type: "string" },
  "base-url": { type: "string" },
  protocol: { type: "string", multiple: true },
  vault: { type: "string" },
  env: { type: "string" },
  plaintext: { type: "boolean" },
  "allow-plaintext": { type: "boolean" },
  stdin: { type: "boolean" },
  overwrite: { type: "boolean" },
  "no-auth": { type: "boolean" },
  "auth-type": { type: "string" },
  "auth-name": { type: "string" },
  header: { type: "string", multiple: true },
  "models-protocol": { type: "string" },
  "models-url": { type: "string" },
  enabled: { type: "boolean" },
  disabled: { type: "boolean" },
  ...writeOptions,
} satisfies CliOptionConfig;

const providerAddOptions = {
  ...providerPatchOptions,
  model: { type: "string" },
} satisfies CliOptionConfig;

const providerRemoveOptions = {
  id: { type: "string" },
  ...writeOptions,
} satisfies CliOptionConfig;

export async function commandProvider(argv: string[]): Promise<void> {
  const sub = argv.shift();
  if (!sub || !["add", "set", "remove"].includes(sub)) throw new UsageError("provider requires add, set, or remove");
  const { values, positionals } = parseCommandArgs(
    argv,
    sub === "add" ? providerAddOptions : sub === "set" ? providerPatchOptions : providerRemoveOptions,
  );
  assertWriteMode(values);
  const root = pathFrom(positionals);
  const id = requiredString(values, "id");
  const before = sub === "add" && (!fs.existsSync(root) || isEmptyDirectory(root))
    ? null
    : fs.existsSync(root) ? loadProfile({ path: root }) : null;
  if (sub !== "add" && !before) throw new Error(`profile does not exist: ${root}`);
  const profile = before ?? createProfile({ rootDir: root });
  const hasProvider = profile.providers.some((provider) => provider.config.id === id);
  if (sub === "add" && hasProvider) throw new Error(`provider already exists: ${id}`);
  if (sub !== "add" && !hasProvider) throw new Error(`provider not found: ${id}`);

  let next: LappProfile;
  let vaultWrite: AuthSelection["vaultWrite"];
  let outputSecrets: string[] = [];
  if (sub === "remove") {
    next = removeProvider(profile, id);
  } else {
    const existing = profile.providers.find((provider) => provider.config.id === id)?.config;
    const preset = sub === "add" && getPreset(id)
      ? applyPreset(id, {
          ...(optionalString(values, "base-url") ? { baseUrl: optionalString(values, "base-url") } : {}),
          ...(values["no-auth"] ? { noAuth: true } : {}),
          ...(optionalString(values, "model") ? { model: optionalString(values, "model") } : {}),
        }).input
      : undefined;
    const modelsProtocol = optionalString(values, "models-protocol");
    const modelsUrl = optionalString(values, "models-url");
    if ((modelsProtocol && !modelsUrl) || (!modelsProtocol && modelsUrl)) {
      throw new UsageError("--models-protocol and --models-url must be provided together");
    }
    if (modelsProtocol && modelsProtocol !== "openai-models" && modelsProtocol !== "anthropic-models") {
      throw new UsageError("--models-protocol must be openai-models or anthropic-models");
    }
    const discoveryProtocol = modelsProtocol as "openai-models" | "anthropic-models" | undefined;
    const authSelection = await authFromFlags(values, id, sub === "add", existing?.auth, preset?.auth);
    vaultWrite = authSelection.vaultWrite;
    const explicitAuth = authSelection.auth;
    if (vaultWrite) outputSecrets = [vaultWrite.secret];
    else if (authSelection.plaintextWarning && explicitAuth && explicitAuth.type !== "none") {
      outputSecrets = [explicitAuth.secret];
    }
    const requestHeaders = headers(values);
    if (sub === "add" && !preset) {
      if (!optionalString(values, "base-url")) throw new UsageError("provider add requires --base-url");
      if (!stringList(values, "protocol")) throw new UsageError("provider add requires --protocol");
      if (!explicitAuth) throw new UsageError("provider add requires authentication configuration");
    }
    const input: ProviderInput = {
      id,
      ...(optionalString(values, "name") !== undefined ? { name: optionalString(values, "name") } : {}),
      ...(optionalString(values, "base-url") !== undefined ? { baseUrl: optionalString(values, "base-url") } : {}),
      ...(stringList(values, "protocol") ? { protocols: stringList(values, "protocol") } : {}),
      ...(explicitAuth ? { auth: explicitAuth } : {}),
      ...(requestHeaders ? { requestHeaders: { ...(existing?.requestHeaders ?? {}), ...requestHeaders } } : {}),
      ...(discoveryProtocol && modelsUrl ? { modelDiscovery: { protocol: discoveryProtocol, url: modelsUrl } } : {}),
      ...(enabledValue(values) !== undefined ? { enabled: enabledValue(values) } : {}),
      ...(preset
        ? {
            baseUrl: preset.baseUrl,
            protocols: preset.protocols,
            auth: preset.auth,
            ...(preset.modelDiscovery ? { modelDiscovery: preset.modelDiscovery } : {}),
          }
        : {}),
    };
    // Explicit flags always win over preset defaults.
    if (optionalString(values, "base-url") !== undefined) input.baseUrl = optionalString(values, "base-url");
    if (stringList(values, "protocol")) input.protocols = stringList(values, "protocol");
    if (explicitAuth) input.auth = explicitAuth;
    if (discoveryProtocol && modelsUrl) input.modelDiscovery = { protocol: discoveryProtocol, url: modelsUrl };
    next = upsertProvider(profile, input);
    const seedModel = optionalString(values, "model") ?? preset?.defaultModel;
    if (sub === "add" && seedModel) {
      next = upsertModel(next, { providerId: id, id: seedModel, type: "chat" });
    }
    if (authSelection.plaintextWarning) {
      console.error("warning: plaintext credentials may be read by any process that can access the profile");
    }
  }
  try {
    printPlan(await writeProfileWithVault(before, next, {
      apply: Boolean(values.yes),
      dryRun: Boolean(values["dry-run"]),
    }, vaultWrite), outputSecrets);
  } catch (error) {
    if (error instanceof Error) error.message = redact(error.message, outputSecrets);
    throw error;
  }
}

const modelPatchOptions = {
  provider: { type: "string" },
  id: { type: "string" },
  name: { type: "string" },
  alias: { type: "string", multiple: true },
  protocol: { type: "string", multiple: true },
  type: { type: "string" },
  capability: { type: "string", multiple: true },
  "input-modality": { type: "string", multiple: true },
  "output-modality": { type: "string", multiple: true },
  "context-window": { type: "string" },
  "max-output-tokens": { type: "string" },
  enabled: { type: "boolean" },
  disabled: { type: "boolean" },
  ...writeOptions,
} satisfies CliOptionConfig;

const modelRemoveOptions = {
  provider: { type: "string" },
  id: { type: "string" },
  ...writeOptions,
} satisfies CliOptionConfig;

function positiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new UsageError(`--${name} must be a positive integer`);
  return parsed;
}

export async function commandModel(argv: string[]): Promise<void> {
  const sub = argv.shift();
  if (!sub || !["add", "set", "remove"].includes(sub)) throw new UsageError("model requires add, set, or remove");
  const { values, positionals } = parseCommandArgs(
    argv,
    sub === "remove" ? modelRemoveOptions : modelPatchOptions,
  );
  assertWriteMode(values);
  const root = pathFrom(positionals);
  const before = requireExisting(root);
  const providerId = requiredString(values, "provider");
  const id = requiredString(values, "id");
  const provider = before.providers.find((entry) => entry.config.id === providerId);
  if (!provider) throw new Error(`provider not found: ${providerId}`);
  const hasModel = provider.models.models.some((model) => model.id === id);
  if (sub === "add" && hasModel) throw new Error(`model already exists: ${providerId}/${id}`);
  if (sub === "set" && !hasModel) throw new Error(`model not found: ${providerId}/${id}`);
  const next = sub === "remove"
    ? removeModel(before, { providerId, model: id })
    : upsertModel(before, {
        providerId,
        id,
        ...(optionalString(values, "name") !== undefined ? { name: optionalString(values, "name") } : {}),
        ...(stringList(values, "alias") ? { aliases: stringList(values, "alias") } : {}),
        ...(stringList(values, "protocol") ? { protocols: stringList(values, "protocol") } : {}),
        ...(optionalString(values, "type") !== undefined ? { type: optionalString(values, "type") } : {}),
        ...(stringList(values, "capability") ? { capabilities: stringList(values, "capability") } : {}),
        ...(stringList(values, "input-modality") ? { inputModalities: stringList(values, "input-modality") } : {}),
        ...(stringList(values, "output-modality") ? { outputModalities: stringList(values, "output-modality") } : {}),
        ...(positiveInteger(optionalString(values, "context-window"), "context-window") !== undefined
          ? { contextWindow: positiveInteger(optionalString(values, "context-window"), "context-window") }
          : {}),
        ...(positiveInteger(optionalString(values, "max-output-tokens"), "max-output-tokens") !== undefined
          ? { maxOutputTokens: positiveInteger(optionalString(values, "max-output-tokens"), "max-output-tokens") }
          : {}),
        ...(enabledValue(values) !== undefined ? { enabled: enabledValue(values) } : {}),
      } satisfies ModelInput);
  printPlan(await maybeWrite(before, next, values));
}

export async function commandDefault(argv: string[]): Promise<void> {
  const sub = argv.shift();
  if (sub !== "set") throw new UsageError("default requires set");
  const { values, positionals } = parseCommandArgs(argv, {
    task: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    ...writeOptions,
  });
  assertWriteMode(values);
  const before = requireExisting(pathFrom(positionals));
  const next = setDefault(before, requiredString(values, "task"), {
    providerId: requiredString(values, "provider"),
    model: requiredString(values, "model"),
  });
  printPlan(await maybeWrite(before, next, values));
}

export async function commandModels(argv: string[]): Promise<void> {
  const sub = argv.shift();
  if (!sub || !["list", "refresh"].includes(sub)) throw new UsageError("models requires list or refresh");
  const { values, positionals } = parseCommandArgs(
    argv,
    sub === "list"
      ? {
          provider: { type: "string" },
          json: { type: "boolean" },
        }
      : {
          provider: { type: "string" },
          json: { type: "boolean" },
          apply: { type: "boolean" },
          yes: { type: "boolean" },
          "dry-run": { type: "boolean" },
        },
  );
  const root = pathFrom(positionals);
  const profile = requireExisting(root);
  if (sub === "list") {
    const models = listModels(profile, {
      ...(optionalString(values, "provider") ? { providerId: optionalString(values, "provider") } : {}),
    });
    if (values.json) printJson({ models });
    else for (const model of models) console.log(`${model.providerId}/${model.modelId} [${model.protocols.join(", ")}]`);
    return;
  }

  const providerId = requiredString(values, "provider");
  if (values["dry-run"] && (values.apply || values.yes)) {
    throw new UsageError("--dry-run cannot be combined with --apply or --yes");
  }
  if (values.apply && !values.yes) throw new UsageError("models refresh --apply requires --yes");
  if (values.yes && !values.apply) throw new UsageError("models refresh --yes requires --apply");
  if (values["dry-run"]) {
    const provider = profile.providers.find((entry) => entry.config.id === providerId);
    if (!provider) throw new TargetResolutionError(`provider not found: ${providerId}`, "PROVIDER_NOT_FOUND");
    if (provider.config.enabled === false) {
      throw new TargetResolutionError(`provider is disabled: ${providerId}`, "PROVIDER_DISABLED");
    }
    if (!provider.config.modelDiscovery) {
      throw new ModelRefreshError(
        `model discovery is not configured for provider "${providerId}"`,
        "DISCOVERY_NOT_CONFIGURED",
      );
    }
    const data = {
      providerId,
      added: [],
      diagnostics: [{
        level: "INFO" as const,
        message: "dry run skipped credential access and remote model discovery",
      }],
      applied: false,
      skipped: true,
    };
    if (values.json) printJson(data);
    else console.log("dry run: credential access and remote model discovery skipped");
    return;
  }
  const result = await refreshModels(profile, providerId, { env: process.env });
  const applied = Boolean(values.apply);
  if (applied) await writeProfileAtomic(result.nextProfile, { before: profile });
  const data = { providerId, added: result.added, diagnostics: result.diagnostics, applied };
  if (values.json) printJson(data);
  else {
    console.log(`found ${result.added.length} new model(s)`);
    for (const model of result.added) console.log(`add: ${model.providerId}/${model.modelId}`);
    if (!applied && result.added.length) console.log("not written; pass --apply --yes to apply");
  }
}

export async function commandPresets(argv: string[]): Promise<void> {
  const { values, positionals } = parseCommandArgs(argv, { json: { type: "boolean" } });
  if (positionals.length) throw new UsageError("presets takes no positional arguments");
  const presets = listPresets();
  if (values.json) printJson({ presets });
  else for (const preset of presets) console.log(`${preset.id}: ${preset.displayName}`);
}
