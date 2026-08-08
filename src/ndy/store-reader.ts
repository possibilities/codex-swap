import path from "node:path";
import {
  redactNdyAccount,
  type RedactedNdyAccount,
} from "../accounts/redaction.ts";
import { resolveMultiAuthDir } from "./environment.ts";

/**
 * Read-only access to ndy's account store through the stable
 * `codex-multi-auth/storage` subpath. Raw records (which carry tokens) are
 * redacted before they leave this module; only the credential broker may see
 * token fields, and it has its own boundary.
 *
 * The store path is pinned explicitly (same resolution the containment env
 * pins for children) so in-process reads, wrapper children, and manager
 * children all resolve the one same pool — never a per-project pool, never
 * ndy's fallback discovery.
 */
export const NDY_ACCOUNTS_FILENAME = "openai-codex-accounts.json";

type NdyStorageModule = typeof import("codex-multi-auth/storage");

let storageModulePromise: Promise<NdyStorageModule> | undefined;

async function storageModule(): Promise<NdyStorageModule> {
  storageModulePromise ??= import("codex-multi-auth/storage");
  return storageModulePromise;
}

export function ndyAccountsFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveMultiAuthDir(env), NDY_ACCOUNTS_FILENAME);
}

export class NdyStoreReader {
  private readonly accountsFilePath: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.accountsFilePath = ndyAccountsFilePath(env);
  }

  get storePath(): string {
    return this.accountsFilePath;
  }

  async loadRedactedAccounts(options?: {
    /** Lineage HMAC computed in place; the raw token never leaves ndy's record. */
    lineage?: (refreshToken: string) => string;
  }): Promise<RedactedNdyAccount[]> {
    const storage = await storageModule();
    storage.setStoragePathDirect(this.accountsFilePath);
    const store = await storage.loadAccounts();
    if (store === null) return [];
    return store.accounts.map((record, index) =>
      redactNdyAccount(record, index, options?.lineage),
    );
  }
}
