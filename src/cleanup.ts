import fs from "fs";
import path from "path";
import { CONFIG } from "./config";
import { logger } from "./logger";
import { prState, saveState } from "./state";
import { isPROpen } from "./github";
import { pruneVersions } from "./review";
import { cleanupWorktree, cleanupOrphanedWorktrees } from "./repo";

export async function cleanupClosedPRs(): Promise<void> {
  logger.info("Checking for closed PRs to clean up...");
  const keysToRemove: { prKey: string; repo: string; prNumber: number }[] = [];

  for (const [prKey] of prState.entries()) {
    const match = prKey.match(/^(.+)#(\d+)$/);
    if (!match) continue;

    const [, repo, prNumberStr] = match;
    const prNumber = parseInt(prNumberStr, 10);
    if (!isPROpen(repo, prNumber)) {
      keysToRemove.push({ prKey, repo, prNumber });
    }
  }

  for (const { prKey, repo, prNumber } of keysToRemove) {
    logger.info({ pr: prKey }, "PR closed/merged - removing from state");
    prState.delete(prKey);

    // Clean up any lingering worktree for this PR
    await cleanupWorktree(repo, prNumber);
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

  const reposDir = path.join(CONFIG.workDir, "repos");
  if (!fs.existsSync(reposDir)) return;

  const now = Date.now();
  const maxAge = CONFIG.cleanupAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  const entries = fs.readdirSync(reposDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirPath = path.join(reposDir, entry.name);

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

export function cleanupReviewVersions(): void {
  logger.info({ maxVersions: CONFIG.maxReviewVersions }, "Pruning excess review versions...");

  const reviewsDir = path.join(CONFIG.workDir, "reviews");
  if (!fs.existsSync(reviewsDir)) return;

  let prunedCount = 0;

  // Iterate through all repo directories
  const repoDirs = fs.readdirSync(reviewsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const repoEntry of repoDirs) {
    const repoPath = path.join(reviewsDir, repoEntry.name);

    // Find all PR directories (new format: pr-{number})
    const prDirs = fs.readdirSync(repoPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("pr-"));

    for (const prEntry of prDirs) {
      const prReviewDir = path.join(repoPath, prEntry.name);

      // Count versions before pruning
      const versionsBefore = fs.readdirSync(prReviewDir)
        .filter((f) => f.startsWith("v-") && f.endsWith(".md")).length;

      if (versionsBefore > CONFIG.maxReviewVersions) {
        pruneVersions(prReviewDir);
        prunedCount++;
      }
    }
  }

  if (prunedCount > 0) {
    logger.info({ prsProcessed: prunedCount }, "Pruned review versions");
  } else {
    logger.debug("No review versions to prune");
  }
}

export async function cleanupWorktrees(): Promise<void> {
  logger.info("Cleaning up orphaned worktrees...");

  // Get all active PR keys
  const activePRKeys = new Set(prState.keys());

  await cleanupOrphanedWorktrees(activePRKeys);

  logger.info("Worktree cleanup complete");
}

export async function runCleanup(): Promise<void> {
  logger.info("--- Running cleanup ---");
  await cleanupClosedPRs();
  cleanupOldRepos();
  cleanupReviewVersions();
  await cleanupWorktrees();
  logger.info("--- Cleanup complete ---");
}
