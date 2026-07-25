import { isDeepStrictEqual } from "node:util";
import {
  credentialBindingForProvider,
  credentialBindingsEqual,
  openSystemCredentialVault,
} from "../secret/index.js";
import {
  CredentialError,
  type CredentialBinding,
  type CredentialVault,
  type LappProfile,
} from "../types.js";
import {
  ProfileUpdatePartialFailureError,
  writeProfileAtomic,
} from "../write/atomic.js";
import {
  withWriterLock,
  type WriterLockOptions,
} from "../writer/lock.js";
import { computeProfileRevision } from "./revision.js";

export interface ManagerPendingVaultWrite {
  ref: string;
  secret: string;
  binding: CredentialBinding;
  overwrite: boolean;
}

interface CommitManagerTransactionOptions {
  rootDir: string;
  /** Previous persisted profile, or null when the managed profile did not exist. */
  before: LappProfile | null;
  next: LappProfile;
  /** Override comparison when an in-memory empty profile represents an absent root. */
  profileChanged?: boolean;
  vault?: CredentialVault;
  vaultWrite?: ManagerPendingVaultWrite;
  vaultDeleteRef?: string;
  /** Required CAS revision checked after locking and immediately before mutation. */
  expectedRevision: string;
  /** @internal The caller already owns the current-user global writer lock. */
  lockHeld?: boolean;
  /** @internal Advance manager-owned Vault CAS state immediately before mutation. */
  beforeVaultMutation?: () => void;
  lock?: WriterLockOptions;
  /** Test/embedding override. Production callers should use the atomic default. */
  writeProfile?: typeof writeProfileAtomic;
}

export interface CommitManagerTransactionResult {
  profileChanged: boolean;
  vaultChanged: boolean;
}

export type CommitProfileTransactionOptions = Omit<
  CommitManagerTransactionOptions,
  "lockHeld" | "beforeVaultMutation"
>;
export type CommitProfileTransactionResult = CommitManagerTransactionResult;

export class ProfileRevisionConflictError extends Error {
  override name = "ProfileRevisionConflictError";
  readonly code = "PROFILE_CONFLICT" as const;
  constructor(readonly currentRevision: string) {
    super("profile changed before the transaction could be committed");
  }
}

/**
 * Commit one semantic profile/Vault mutation. A Vault write happens before the
 * profile write and is restored if the atomic profile update fails.
 */
export async function commitManagerTransaction(
  options: CommitManagerTransactionOptions,
): Promise<CommitManagerTransactionResult> {
  if (typeof options.expectedRevision !== "string") {
    throw new TypeError("expectedRevision is required for every Profile or Vault mutation");
  }
  if (!options.lockHeld) {
    return withWriterLock(
      () => commitManagerTransactionLocked({ ...options, lockHeld: true }),
      options.lock,
    );
  }
  return commitManagerTransactionLocked(options);
}

/** Public SDK name for a locked Profile + Vault coordinated transaction. */
export function commitProfileTransaction(
  options: CommitProfileTransactionOptions,
): Promise<CommitProfileTransactionResult> {
  // TypeScript's Omit is not a runtime security boundary. A JavaScript caller
  // must never be able to smuggle the internal lockHeld capability through the
  // public transaction API.
  return commitManagerTransaction({
    ...(options as CommitManagerTransactionOptions),
    lockHeld: false,
    beforeVaultMutation: undefined,
  });
}

async function commitManagerTransactionLocked(
  options: CommitManagerTransactionOptions,
): Promise<CommitManagerTransactionResult> {
  const writeProfile = options.writeProfile ?? writeProfileAtomic;
  const assertExpectedRevision = (): void => {
    const currentRevision = computeProfileRevision(options.rootDir);
    if (currentRevision !== options.expectedRevision) {
      throw new ProfileRevisionConflictError(currentRevision);
    }
  };
  if (typeof options.expectedRevision !== "string") {
    throw new TypeError("expectedRevision is required for every Profile or Vault mutation");
  }
  assertExpectedRevision();
  if (options.vaultWrite && options.vaultDeleteRef) {
    throw new Error("a transaction cannot write and delete a Vault credential");
  }
  const profileChanged = options.profileChanged
    ?? !isDeepStrictEqual(options.before, options.next);
  if (options.vaultDeleteRef && profileChanged) {
    throw new Error("a Vault delete cannot be combined with a profile mutation");
  }

  if (options.vaultDeleteRef) {
    const vault = options.vault ?? await openSystemCredentialVault();
    assertExpectedRevision();
    options.beforeVaultMutation?.();
    const vaultChanged = await vault.delete(options.vaultDeleteRef);
    return { profileChanged: false, vaultChanged };
  }

  if (!options.vaultWrite) {
    if (profileChanged) {
      assertExpectedRevision();
      await writeProfile(options.next, {
        path: options.rootDir,
        before: options.before,
      });
    }
    return { profileChanged, vaultChanged: false };
  }

  const pending = options.vaultWrite;
  const nextProvider = options.next.providers.find((entry) =>
    entry.config.auth.type !== "none" && entry.config.auth.secret === pending.ref);
  if (!nextProvider) throw new Error("Vault credential is not referenced by the proposed profile");
  const nextBinding = credentialBindingForProvider(nextProvider.config);
  if (!nextBinding || !credentialBindingsEqual(nextBinding, pending.binding)) {
    throw new Error("Vault credential binding does not match the proposed profile");
  }

  const vault = options.vault ?? await openSystemCredentialVault();
  const previousProvider = options.before?.providers.find((entry) =>
    entry.config.id === nextProvider.config.id);
  const previousUsesRef = Boolean(previousProvider
    && previousProvider.config.auth.type !== "none"
    && previousProvider.config.auth.secret === pending.ref);
  const previousBinding = previousUsesRef && previousProvider
    ? credentialBindingForProvider(previousProvider.config) ?? nextBinding
    : nextBinding;
  const previousStatus = await vault.status(pending.ref, previousBinding);
  if (previousStatus.exists && previousStatus.bindingMatches !== true) {
    if (!pending.overwrite || profileChanged) {
      throw new CredentialError(
        "VAULT_BINDING_MISMATCH",
        "Vault credential is bound to different provider settings; save the provider configuration before overwriting the credential",
      );
    }
  }

  let previous: { secret: string; binding: CredentialBinding } | undefined;
  if (
    profileChanged
    && previousStatus.exists
    && previousStatus.bindingMatches === true
    && pending.overwrite
  ) {
    previous = {
      secret: await vault.resolve(pending.ref, previousBinding),
      binding: previousBinding,
    };
  }

  assertExpectedRevision();
  options.beforeVaultMutation?.();
  await vault.put(pending.ref, pending.secret, nextBinding, { overwrite: pending.overwrite });
  if (!profileChanged) return { profileChanged: false, vaultChanged: true };
  try {
    assertExpectedRevision();
    await writeProfile(options.next, {
      path: options.rootDir,
      before: options.before,
    });
  } catch (error) {
    try {
      if (previous) {
        await vault.put(pending.ref, previous.secret, previous.binding, { overwrite: true });
      } else {
        await vault.delete(pending.ref);
      }
    } catch {
      const profilePartialFailure = error instanceof ProfileUpdatePartialFailureError
        || (error instanceof Error && error.name === "ProfileUpdatePartialFailureError");
      throw new CredentialError(
        "CREDENTIAL_UPDATE_PARTIAL_FAILURE",
        "profile update failed and the previous Vault credential could not be restored",
        profilePartialFailure
          ? [{
              code: "PROFILE_UPDATE_PARTIAL_FAILURE",
              message: "profile rollback also failed to restore the previous files",
            }]
          : [],
      );
    }
    if (error instanceof ProfileUpdatePartialFailureError
      || (error instanceof Error && error.name === "ProfileUpdatePartialFailureError")) {
      throw new CredentialError(
        "CREDENTIAL_UPDATE_PARTIAL_FAILURE",
        "profile rollback failed after the Vault credential was mutated",
        [{
          code: "PROFILE_UPDATE_PARTIAL_FAILURE",
          message: "profile rollback failed to restore the previous files",
        }],
      );
    }
    throw error;
  }
  return { profileChanged: true, vaultChanged: true };
}
