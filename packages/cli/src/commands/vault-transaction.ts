import {
  credentialBindingForProvider,
  CredentialError,
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

export async function writeProfileWithVault(
  before: LappProfile | null,
  next: LappProfile,
  mode: { apply: boolean; dryRun: boolean },
  vaultWrite?: PendingVaultWrite,
): Promise<{ applied: boolean; changes: ReturnType<typeof planChanges>["changes"] }> {
  const validation = validateProfile(next);
  if (!validation.valid) {
    throw new ProfileValidationError(validation.diagnostics, "refusing to plan an invalid profile");
  }
  const changes = planChanges(before, next).changes;
  if (!mode.apply || mode.dryRun) return { applied: false, changes };
  if (!vaultWrite) {
    await writeProfileAtomic(next, { ...(before ? { before } : {}) });
    return { applied: true, changes };
  }

  const nextProvider = next.providers.find((entry) =>
    entry.config.auth.type !== "none" && entry.config.auth.secret === vaultWrite.ref);
  if (!nextProvider) throw new Error("vault credential is not referenced by the proposed profile");
  const nextBinding = credentialBindingForProvider(nextProvider.config);
  if (!nextBinding) throw new Error("authenticated provider is missing a credential binding");
  const vault = await openSystemCredentialVault();

  let previous: {
    secret: string;
    binding: NonNullable<ReturnType<typeof credentialBindingForProvider>>;
  } | undefined;
  const previousProvider = before?.providers.find((entry) => entry.config.id === nextProvider.config.id);
  const previousUsesRef = Boolean(previousProvider
    && previousProvider.config.auth.type !== "none"
    && previousProvider.config.auth.secret === vaultWrite.ref);
  const previousBinding = previousUsesRef && previousProvider
    ? credentialBindingForProvider(previousProvider.config) ?? nextBinding
    : nextBinding;
  const previousStatus = await vault.status(vaultWrite.ref, previousBinding);
  if (previousStatus.exists && previousStatus.bindingMatches !== true) {
    if (!vaultWrite.overwrite || changes.length > 0) {
      throw new CredentialError(
        "VAULT_BINDING_MISMATCH",
        "Vault credential is bound to different provider settings; re-enter it with --overwrite after saving the provider configuration",
      );
    }
  }
  if (
    changes.length > 0
    && previousStatus.exists
    && previousStatus.bindingMatches === true
    && vaultWrite.overwrite
  ) {
    previous = {
      secret: await vault.resolve(vaultWrite.ref, previousBinding),
      binding: previousBinding,
    };
  }

  await vault.put(vaultWrite.ref, vaultWrite.secret, nextBinding, { overwrite: vaultWrite.overwrite });
  if (changes.length === 0) return { applied: true, changes };
  try {
    await writeProfileAtomic(next, { ...(before ? { before } : {}) });
  } catch (error) {
    try {
      if (previous) {
        await vault.put(vaultWrite.ref, previous.secret, previous.binding, { overwrite: true });
      } else {
        await vault.delete(vaultWrite.ref);
      }
    } catch {
      throw new CredentialError(
        "CREDENTIAL_UPDATE_PARTIAL_FAILURE",
        "profile update failed and the previous Vault credential could not be restored",
      );
    }
    if (error instanceof Error && error.name === "ProfileWriteRollbackError") {
      throw new CredentialError(
        "CREDENTIAL_UPDATE_PARTIAL_FAILURE",
        "profile update failed and the previous profile files could not be restored",
      );
    }
    throw error;
  }
  return { applied: true, changes };
}
