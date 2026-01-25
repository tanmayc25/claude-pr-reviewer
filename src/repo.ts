import fs from "fs";
import path from "path";
import { CONFIG } from "./config";
import { logger } from "./logger";
import { execAsync, ensureDir } from "./utils";

export async function cloneOrUpdateRepo(repoFullName: string): Promise<string> {
  const repoDir = path.join(CONFIG.workDir, repoFullName.replace("/", "_"));
  ensureDir(CONFIG.workDir);

  if (fs.existsSync(path.join(repoDir, ".git"))) {
    logger.info({ repo: repoFullName }, "Fetching updates");
    await execAsync("git fetch --all --prune", { cwd: repoDir });
  } else {
    logger.info({ repo: repoFullName }, "Cloning repo");
    await execAsync(`gh repo clone ${repoFullName} "${repoDir}"`);
  }

  return repoDir;
}

export async function checkoutPRBranch(repoDir: string, repoFullName: string, prNumber: number): Promise<void> {
  logger.info({ pr: prNumber }, "Checking out PR");
  // Reset any local changes before checkout
  await execAsync("git checkout -- .", { cwd: repoDir });
  await execAsync(`gh pr checkout ${prNumber} --repo ${repoFullName}`, { cwd: repoDir });
}
