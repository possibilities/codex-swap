import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensurePrivateDir, refuseSymlink, tightenFileMode } from "./permissions.ts";
import { installSecretPath } from "./paths.ts";

/**
 * A per-install random secret keying the credential-lineage HMAC
 * (handoff §11): the database stores HMAC-SHA256(installSecret, refreshToken)
 * so credential rotation is detectable without persisting a usable token or
 * an unsalted hash.
 */
const SECRET_BYTES = 32;

export function loadOrCreateInstallSecret(root: string): Buffer {
  const secretPath = installSecretPath(root);
  ensurePrivateDir(path.dirname(secretPath));
  refuseSymlink(secretPath);
  try {
    const existing = readFileSync(secretPath);
    if (existing.length >= SECRET_BYTES) return existing;
    // Truncated secret: fail loudly rather than silently weakening the HMAC.
    throw new Error(
      `install secret at ${secretPath} is truncated (${existing.length} bytes); ` +
        "delete it to regenerate (stored lineage fingerprints will reset)",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const secret = randomBytes(SECRET_BYTES);
  try {
    writeFileSync(secretPath, secret, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readFileSync(secretPath);
    }
    throw error;
  }
  tightenFileMode(secretPath);
  return secret;
}

export function lineageHmac(secret: Buffer, refreshToken: string): string {
  return createHmac("sha256", secret).update(refreshToken).digest("hex");
}
