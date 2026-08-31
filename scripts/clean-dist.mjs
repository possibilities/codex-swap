import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const dist = path.resolve(repositoryRoot, "dist");

// Keep the destructive boundary literal and local. In particular, never let
// an environment variable or caller argument widen this to a checkout root.
if (path.dirname(dist) !== repositoryRoot || path.basename(dist) !== "dist") {
  throw new Error(`refusing to clean unexpected build path: ${dist}`);
}

rmSync(dist, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
