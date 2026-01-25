import fs from "fs";
import path from "path";
import { CONFIG } from "./config";
import { logger } from "./logger";
import { prState, saveState } from "./state";
import { isPROpen } from "./github";

export function cleanupClosedPRs(): void {
  logger.info("Checking for closed PRs to clean up...");
  const keysToRemove: { prKey: string; repo: string }[] = [];

  for (const [prKey] of prState.entries()) {
    const match = prKey.match(/^(.+)#(\d+)$/);
    if (!match) continue;

    const [, repo, prNumber] = match;
    if (!isPROpen(repo, parseInt(prNumber, 10))) {
      keysToRemove.push({ prKey, repo });
    }
  }

  for (const { prKey, repo } of keysToRemove) {
    logger.info({ pr: prKey }, "PR closed/merged - removing from state");
    prState.delete(prKey);

    const repoDir = path.join(CONFIG.workDir, repo.replace("/", "_"));
    if (fs.existsSync(repoDir)) {
      try {
        fs.rmSync(repoDir, { recursive: true, force: true });
        logger.info({ dir: repoDir }, "Deleted local clone");
      } catch (e) {
        logger.error({ dir: repoDir, error: (e as Error).message }, "Could not delete repo");
      }
    }
  }

  if (keysToRemove.length > 0) {
    saveState();
    logger.info({ count: keysToRemove.length }, "Cleaned up closed PRs");
  } else {
    logger.debug("No closed PRs to clean up");
  }
}

export function cleanupOldRepos(): void {
  logger.info({ maxAgeDays: CONFIG.cleanupAgeDays }, "Cleaning up old repos...");

  if (!fs.existsSync(CONFIG.workDir)) return;

  const now = Date.now();
  const maxAge = CONFIG.cleanupAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  const entries = fs.readdirSync(CONFIG.workDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirPath = path.join(CONFIG.workDir, entry.name);

    // Only consider directories that look like repo clones (have .git folder)
    if (!fs.existsSync(path.join(dirPath, ".git"))) {
      continue;
    }

    try {
      const stats = fs.statSync(dirPath);
      const age = now - stats.mtimeMs;

      if (age > maxAge) {
        const repoName = entry.name.replace("_", "/");
        const hasActivePR = Array.from(prState.keys()).some((k) =>
          k.startsWith(repoName + "#")
        );

        if (!hasActivePR) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));
          logger.info({ dir: dirPath, ageDays }, "Deleted old repo");
          cleaned++;
        }
      }
    } catch (e) {
      logger.error({ dir: dirPath, error: (e as Error).message }, "Error checking directory");
    }
  }

  if (cleaned > 0) {
    logger.info({ count: cleaned }, "Cleaned up old repos");
  } else {
    logger.debug("No old repos to clean up");
  }
}

export async function runCleanup(): Promise<void> {
  logger.info("--- Running cleanup ---");
  cleanupClosedPRs();
  cleanupOldRepos();
  logger.info("--- Cleanup complete ---");
}
