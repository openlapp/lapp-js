import {
  MissingEnvSecretError,
  ModelRefreshError,
  ProfileValidationError,
  TargetResolutionError,
} from "@openlapp/lapp";
import { UsageError } from "./args.js";

export interface CliFailure {
  exitCode: 1 | 2;
  code: string;
  message: string;
}

const SECRET_PATTERNS = [
  /(sk-[A-Za-z0-9_-]{8,})/g,
  /(Bearer\s+)[^\s"']+/gi,
  /((?:api[_-]?key|token|secret)["'\s:=]+)[^\s,"'}]+/gi,
];

export function redact(text: string, values: readonly string[] = []): string {
  let result = text;
  for (const value of values) {
    if (value) result = result.split(value).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (_match, prefix?: string) => `${prefix ?? ""}[REDACTED]`);
  }
  return result;
}

export function classifyError(error: unknown): CliFailure {
  const message = redact(error instanceof Error ? error.message : String(error));
  const credentialCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  if (error instanceof UsageError) return { exitCode: 2, code: "USAGE", message };
  if (error instanceof ProfileValidationError) return { exitCode: 1, code: "PROFILE_INVALID", message };
  if (error instanceof TargetResolutionError) return { exitCode: 1, code: error.code, message };
  if (error instanceof MissingEnvSecretError) return { exitCode: 1, code: error.code, message };
  if (error instanceof ModelRefreshError) return { exitCode: 1, code: error.code, message };
  if (credentialCode && [
    "INVALID_SECRET_REFERENCE",
    "UNSUPPORTED_SECRET_SCHEME",
    "ENV_SECRET_MISSING",
    "VAULT_BACKEND_UNAVAILABLE",
    "VAULT_CREDENTIAL_NOT_FOUND",
    "VAULT_CREDENTIAL_EXISTS",
    "VAULT_RECORD_INVALID",
    "VAULT_BINDING_MISMATCH",
    "VAULT_ACCESS_DENIED",
    "VAULT_OPERATION_FAILED",
    "CREDENTIAL_UPDATE_PARTIAL_FAILURE",
  ].includes(credentialCode)) {
    return { exitCode: 1, code: credentialCode, message };
  }
  return { exitCode: 1, code: "INTERNAL_ERROR", message };
}

export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify({ version: 1, data })}\n`);
}

export function printJsonError(error: CliFailure): void {
  process.stderr.write(`${JSON.stringify({ version: 1, error: { code: error.code, message: error.message } })}\n`);
}
