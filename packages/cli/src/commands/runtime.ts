import fs from "node:fs";
import {
  createLappClient,
  loadProfile,
  openSystemCredentialVault,
  parseSecretRef,
  resolveLappRoot,
  selectConnection,
  type ConnectionPlan,
  type ModelSelector,
} from "@openlapp/lapp";
import {
  optionalString,
  parseCommandArgs,
  stringList,
  UsageError,
  type CliOptionConfig,
} from "../args.js";
import { printJson } from "../output.js";

const targetOptions = {
  path: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  default: { type: "string" },
} satisfies CliOptionConfig;

function selector(
  values: Record<string, string | boolean | string[] | undefined>,
  required: boolean,
): ModelSelector {
  const provider = optionalString(values, "provider");
  const model = optionalString(values, "model");
  const defaultTask = optionalString(values, "default");
  if (defaultTask && (provider || model)) {
    throw new UsageError("--default cannot be combined with --provider or --model");
  }
  if ((provider && !model) || (!provider && model)) {
    throw new UsageError("--provider and --model must be provided together");
  }
  if (defaultTask) return { default: defaultTask };
  if (provider && model) return { providerId: provider, model };
  if (required) throw new UsageError("use --provider/--model or --default");
  return { default: "chat" };
}

function profileFrom(values: Record<string, string | boolean | string[] | undefined>) {
  return loadProfile({ path: resolveLappRoot(optionalString(values, "path")) });
}

function redactResolved(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues.reduce(
    (result, secret) => secret ? result.split(secret).join("[REDACTED]") : result,
    value,
  );
}

interface PublicAuthStatus {
  type: string;
  name?: string;
  scheme: "none" | "plaintext" | "env" | "vault";
  available: boolean;
  bindingMatches?: boolean;
}

function publicConnection(connection: ConnectionPlan, auth: PublicAuthStatus): Record<string, unknown> {
  const sensitiveValues = connection.auth.type === "none" ? [] : [connection.auth.secret];
  const publicString = (value: string): string => redactResolved(value, sensitiveValues);
  return {
    providerId: publicString(connection.providerId),
    modelId: publicString(connection.modelId),
    protocol: publicString(connection.protocol),
    baseUrl: publicString(connection.baseUrl),
    requestHeaders: Object.fromEntries(
      Object.entries(connection.requestHeaders).map(([name, value]) => [
        publicString(name),
        publicString(value),
      ]),
    ),
    auth,
  };
}

async function authStatus(connection: ConnectionPlan): Promise<PublicAuthStatus> {
  if (connection.auth.type === "none") return { type: "none", scheme: "none", available: true };
  const common = {
    type: connection.auth.type,
    ...(connection.auth.type === "header" || connection.auth.type === "query"
      ? { name: connection.auth.name }
      : {}),
  };
  const ref = parseSecretRef(connection.auth.secret);
  if (ref.scheme === "plaintext") return { ...common, scheme: "plaintext", available: true };
  if (ref.scheme === "env") {
    return {
      ...common,
      scheme: "env",
      available: Boolean(ref.reference && process.env[ref.reference]),
    };
  }
  if (ref.scheme === "vault") {
    if (!connection.credentialBinding) throw new Error("authenticated provider is missing a credential binding");
    const status = await (await openSystemCredentialVault()).status(
      connection.auth.secret,
      connection.credentialBinding,
    );
    return {
      ...common,
      scheme: "vault",
      available: status.exists && status.bindingMatches === true,
      ...(status.exists ? { bindingMatches: status.bindingMatches === true } : {}),
    };
  }
  throw new Error("unsupported or invalid secret reference");
}

export async function commandResolve(argv: string[]): Promise<void> {
  const { values, positionals } = parseCommandArgs(argv, {
    ...targetOptions,
    protocol: { type: "string", multiple: true },
    json: { type: "boolean" },
  });
  if (positionals.length) throw new UsageError("resolve takes no positional arguments");
  const profile = profileFrom(values);
  const connection = selectConnection(profile, selector(values, true), {
    ...(stringList(values, "protocol") ? { supportedProtocols: stringList(values, "protocol") } : {}),
  });
  const status = await authStatus(connection);
  const view = publicConnection(connection, status);
  if (values.json) {
    printJson({ connection: view });
    return;
  }
  const publicView = view as {
    providerId: string;
    modelId: string;
    protocol: string;
    baseUrl: string;
    auth: PublicAuthStatus;
  };
  console.log(`${publicView.providerId}/${publicView.modelId}`);
  console.log(`protocol: ${publicView.protocol}`);
  console.log(`baseUrl: ${publicView.baseUrl}`);
  console.log(`auth: ${publicView.auth.type} (${publicView.auth.scheme}, ${publicView.auth.available ? "available" : "unavailable"})`);
  if (publicView.auth.bindingMatches === false) console.log("binding: mismatch");
}

export async function commandPing(argv: string[]): Promise<void> {
  const { values, positionals } = parseCommandArgs(argv, {
    ...targetOptions,
    json: { type: "boolean" },
  });
  if (positionals.length) throw new UsageError("ping takes no positional arguments");
  const target = selector(values, false);
  const profile = profileFrom(values);
  const client = createLappClient({
    profile,
    ...(target && "default" in target
      ? { default: target.default }
      : { provider: target.providerId, model: target.model }),
    env: process.env,
    redactSuccessfulSecrets: true,
  });
  const result = await client.testConnection();
  if (!result.ok) {
    const error = new Error(result.message ?? "connection test failed") as Error & { code?: string };
    if (result.code) error.code = result.code;
    throw error;
  }
  if (values.json) printJson(result);
  else console.log(`pong: ${result.provider}/${result.model} (${result.protocol})`);
}

function readMessage(positionals: string[]): string {
  const inline = positionals.join(" ").trim();
  if (inline) return inline;
  if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8").trim();
  throw new UsageError("chat requires a message argument or stdin");
}

export async function commandChat(argv: string[]): Promise<void> {
  const { values, positionals } = parseCommandArgs(argv, {
    ...targetOptions,
    system: { type: "string" },
    stream: { type: "boolean" },
    json: { type: "boolean" },
  });
  if (values.stream && values.json) throw new UsageError("--stream cannot be combined with --json");
  const target = selector(values, false);
  const profile = profileFrom(values);
  const client = createLappClient({
    profile,
    ...(target && "default" in target
      ? { default: target.default }
      : { provider: target.providerId, model: target.model }),
    env: process.env,
    redactSuccessfulSecrets: true,
  });
  const message = readMessage(positionals);
  const messages = [
    ...(optionalString(values, "system")
      ? [{ role: "system" as const, content: optionalString(values, "system")! }]
      : []),
    { role: "user" as const, content: message },
  ];
  if (values.stream) {
    for await (const event of client.stream({ messages })) {
      if (event.kind === "delta") process.stdout.write(event.text);
      else if (event.kind === "error") throw new Error(event.message);
    }
    process.stdout.write("\n");
    return;
  }
  const response = await client.chat({ messages });
  if (values.json) {
    printJson({
      text: response.text,
      providerId: response.provider,
      modelId: response.model,
      protocol: response.protocol,
      ...(response.usage ? { usage: response.usage } : {}),
      ...(response.finishReason ? { finishReason: response.finishReason } : {}),
    });
  } else {
    console.log(response.text);
  }
}
