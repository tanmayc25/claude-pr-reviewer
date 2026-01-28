import fs from "fs";
import path from "path";
import { CONFIG } from "./config";
import { logger } from "./logger";
import { execAsync, ensureDir } from "./utils";

/**
 * Get the base repository directory (the main clone, not a worktree)
 */
function getBaseRepoDir(repoFullName: string): string {
  return path.join(CONFIG.workDir, "repos", repoFullName.replace("/", "_"));
}

/**
 * Get the worktree directory for a specific PR
 */
export function getWorktreeDir(repoFullName: string, prNumber: number): string {
  return path.join(CONFIG.workDir, "worktrees", repoFullName.replace("/", "_"), `pr-${prNumber}`);
}

/**
 * Clone or update the base repository
 */
export async function cloneOrUpdateRepo(repoFullName: string): Promise<string> {
  const repoDir = getBaseRepoDir(repoFullName);
  ensureDir(path.dirname(repoDir));

  if (fs.existsSync(path.join(repoDir, ".git"))) {
    logger.info({ repo: repoFullName }, "Fetching updates");
    await execAsync("git fetch --all --prune", { cwd: repoDir });
  } else {
    logger.info({ repo: repoFullName }, "Cloning repo");
    await execAsync(`gh repo clone ${repoFullName} "${repoDir}"`);
  }

  return repoDir;
}

/**
 * Create a worktree for a specific PR
 * Each PR gets its own isolated working directory, enabling true parallel reviews
 */
export async function createWorktreeForPR(
  repoFullName: string,
  prNumber: number
): Promise<string> {
  const baseRepoDir = getBaseRepoDir(repoFullName);
  const worktreeDir = getWorktreeDir(repoFullName, prNumber);

  // Clean up existing worktree if it exists (stale from previous run)
  if (fs.existsSync(worktreeDir)) {
    await cleanupWorktree(repoFullName, prNumber);
  }

  ensureDir(path.dirname(worktreeDir));

  // Get the PR's head commit SHA without checking out (avoids race condition)
  logger.info({ pr: prNumber, repo: repoFullName }, "Fetching PR head commit");
  const { stdout: prInfo } = await execAsync(
    `gh pr view ${prNumber} --repo ${repoFullName} --json headRefOid --jq .headRefOid`
  );
  const prCommit = prInfo.trim();

  // Fetch the specific commit (in case it's not in the local repo yet)
  await execAsync(`git fetch origin ${prCommit}`, { cwd: baseRepoDir }).catch(() => {
    // If direct fetch fails, try fetching the PR ref
    return execAsync(`git fetch origin pull/${prNumber}/head`, { cwd: baseRepoDir });
  });

  // Create worktree at the PR's commit
  logger.info({ pr: prNumber, worktree: worktreeDir, commit: prCommit.slice(0, 7) }, "Creating worktree");
  await execAsync(`git worktree add "${worktreeDir}" ${prCommit}`, { cwd: baseRepoDir });

  return worktreeDir;
}

/**
 * Clean up a worktree for a specific PR
 */
export async function cleanupWorktree(repoFullName: string, prNumber: number): Promise<void> {
  const baseRepoDir = getBaseRepoDir(repoFullName);
  const worktreeDir = getWorktreeDir(repoFullName, prNumber);

  if (!fs.existsSync(worktreeDir)) {
    return;
  }

  try {
    // Remove the worktree using git (this updates .git/worktrees)
    if (fs.existsSync(baseRepoDir)) {
      await execAsync(`git worktree remove "${worktreeDir}" --force`, { cwd: baseRepoDir });
    } else {
      // If base repo doesn't exist, just remove the directory
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
    logger.debug({ pr: prNumber, worktree: worktreeDir }, "Cleaned up worktree");
  } catch (e) {
    // If git worktree remove fails, try manual cleanup
    logger.warn({ pr: prNumber, error: (e as Error).message }, "git worktree remove failed, trying manual cleanup");
    try {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    } catch (e2) {
      logger.error({ pr: prNumber, error: (e2 as Error).message }, "Failed to cleanup worktree");
    }
  }
}

/**
 * Clean up all worktrees for a repository
 */
export async function cleanupAllWorktrees(repoFullName: string): Promise<void> {
  const baseRepoDir = getBaseRepoDir(repoFullName);
  const worktreesBaseDir = path.join(CONFIG.workDir, "worktrees", repoFullName.replace("/", "_"));

  if (!fs.existsSync(worktreesBaseDir)) {
    return;
  }

  // Prune any stale worktree references
  if (fs.existsSync(baseRepoDir)) {
    try {
      await execAsync("git worktree prune", { cwd: baseRepoDir });
    } catch (e) {
      logger.warn({ repo: repoFullName, error: (e as Error).message }, "git worktree prune failed");
    }
  }

  // Remove the worktrees directory for this repo
  try {
    fs.rmSync(worktreesBaseDir, { recursive: true, force: true });
    logger.info({ repo: repoFullName }, "Cleaned up all worktrees");
  } catch (e) {
    logger.error({ repo: repoFullName, error: (e as Error).message }, "Failed to cleanup worktrees directory");
  }
}

/**
 * Clean up all orphaned worktrees (worktrees without active PRs)
 */
export async function cleanupOrphanedWorktrees(activePRKeys: Set<string>): Promise<void> {
  const worktreesBaseDir = path.join(CONFIG.workDir, "worktrees");

  if (!fs.existsSync(worktreesBaseDir)) {
    return;
  }

  const repoDirs = fs.readdirSync(worktreesBaseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const repoEntry of repoDirs) {
    const repoName = repoEntry.name.replace("_", "/");
    const repoWorktreesDir = path.join(worktreesBaseDir, repoEntry.name);

    const prDirs = fs.readdirSync(repoWorktreesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("pr-"));

    for (const prDir of prDirs) {
      const prNumber = parseInt(prDir.name.replace("pr-", ""), 10);
      const prKey = `${repoName}#${prNumber}`;

      if (!activePRKeys.has(prKey)) {
        await cleanupWorktree(repoName, prNumber);
      }
    }

    // Remove repo worktree dir if empty
    try {
      const remaining = fs.readdirSync(repoWorktreesDir);
      if (remaining.length === 0) {
        fs.rmSync(repoWorktreesDir, { recursive: true, force: true });
      }
    } catch (e) {
      // Ignore
    }
  }
}
