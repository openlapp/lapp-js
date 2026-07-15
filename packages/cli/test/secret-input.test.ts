import { describe, expect, it } from "vitest";
import { promptHiddenSecret } from "../src/secret-input.js";

describe("credential input", () => {
  it("refuses to show an application-controlled prompt without a trusted TTY", async () => {
    if (process.stdin.isTTY && process.stderr.isTTY) return;
    await expect(promptHiddenSecret()).rejects.toThrow(/non-interactive credential input/);
  });
});
