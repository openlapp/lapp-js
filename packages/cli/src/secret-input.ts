import fs from "node:fs";
import readline from "node:readline";
import { UsageError } from "./args.js";

function requireNonEmptySecret(value: string): string {
  const secret = value.replace(/\r?\n$/, "");
  if (secret.length === 0) throw new UsageError("credential input is empty");
  return secret;
}

/** Read exactly one credential from piped stdin. The trailing line ending is not part of the secret. */
export function readSecretFromStdin(): string {
  if (process.stdin.isTTY) {
    throw new UsageError("--stdin requires piped stdin");
  }
  return requireNonEmptySecret(fs.readFileSync(0, "utf8"));
}

/**
 * Read a credential from a trusted terminal without echoing it. This function
 * deliberately writes the prompt to stderr so stdout remains machine-readable.
 */
export async function promptHiddenSecret(prompt = "Credential: "): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || !process.stdin.setRawMode) {
    throw new UsageError("non-interactive credential input requires --stdin or --env");
  }

  const input = process.stdin;
  const output = process.stderr;
  const wasRaw = input.isRaw;
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write(prompt);

  return new Promise<string>((resolve, reject) => {
    let secret = "";

    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      input.setRawMode(Boolean(wasRaw));
      if (!wasRaw) input.pause();
      output.write("\n");
    };

    const finish = (): void => {
      cleanup();
      try {
        resolve(requireNonEmptySecret(secret));
      } catch (error) {
        reject(error);
      }
    };

    const onKeypress = (text: string | undefined, key: readline.Key): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new UsageError("credential input cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
        return;
      }
      if (key.name === "backspace") {
        secret = secret.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && text && !key.name?.startsWith("arrow")) {
        secret += text;
      }
    };

    input.on("keypress", onKeypress);
  });
}

export async function readSecretInput(useStdin: boolean, prompt?: string): Promise<string> {
  return useStdin ? readSecretFromStdin() : promptHiddenSecret(prompt);
}
