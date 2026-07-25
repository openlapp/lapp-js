import {
  commitProfileTransaction,
  credentialBindingForProvider,
  openSystemCredentialVault,
  planChanges,
  ProfileValidationError,
  validateProfile,
  writeProfileAtomic,
  type LappProfile,
} from "@openlapp/lapp";

export interface PendingVaultWrite {
  ref: string;
  secret: string;
  overwrite: boolean;
}

/** Thin CLI adapter over the SDK's locked Vault + profile transaction. */
export async function writeProfileWithVault(
  before: LappProfile | null,
  next: LappProfile,
  mode: { apply: boolean; dryRun: boolean; rootDir: string; expectedRevision: string },
  vaultWrite?: PendingVaultWrite,
): Promise<{ applied: boolean; changes: ReturnType<typeof planChanges>["changes"] }> {
  const validation = validateProfile(next);
  if (!validation.valid) {
    throw new ProfileValidationError(validation.diagnostics, "refusing to plan an invalid profile");
  }
  const changes = planChanges(before, next).changes;
  if (!mode.apply || mode.dryRun) return { applied: false, changes };

  if (!vaultWrite) {
    await commitProfileTransaction({
      rootDir: mode.rootDir,
      expectedRevision: mode.expectedRevision,
      before,
      next,
      profileChanged: changes.length > 0,
      writeProfile: writeProfileAtomic,
    });
    return { applied: true, changes };
  }

  const nextProvider = next.providers.find((entry) =>
    entry.config.auth.type !== "none" && entry.config.auth.secret === vaultWrite.ref);
  if (!nextProvider) throw new Error("Vault credential is not referenced by the proposed profile");
  const binding = credentialBindingForProvider(nextProvider.config);
  if (!binding) throw new Error("authenticated provider is missing a credential binding");
  await commitProfileTransaction({
    rootDir: mode.rootDir,
    expectedRevision: mode.expectedRevision,
    before,
    next,
    profileChanged: changes.length > 0,
    vault: await openSystemCredentialVault(),
    writeProfile: writeProfileAtomic,
    vaultWrite: {
      ref: vaultWrite.ref,
      secret: vaultWrite.secret,
      binding,
      overwrite: vaultWrite.overwrite,
    },
  });
  return { applied: true, changes };
}
