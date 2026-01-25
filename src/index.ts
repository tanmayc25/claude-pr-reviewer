import { execSync } from "child_process";
import { CONFIG } from "./config";
import { logger } from "./logger";
import { loadState } from "./state";
import { getExactRepos, getRepoRegexes } from "./github";
import { poll } from "./poll";
import { runCleanup } from "./cleanup";
import { startWebServer } from "./web/server";
import { ensureDir } from "./utils";

async function main(): Promise<void> {
  console.log(`
+------------------------------------------------------------+
|              PR Review Daemon (Claude Code)                |
+------------------------------------------------------------+
`);

  // Check gh CLI is authenticated
  try {
    execSync("gh auth status", { stdio: "pipe" });
  } catch {
    logger.fatal("gh CLI is not authenticated. Run: gh auth login");
    process.exit(1);
  }

  ensureDir(CONFIG.workDir);
  loadState();

  logger.info({
    pollInterval: `${CONFIG.pollInterval}s`,
    workDir: CONFIG.workDir,
    githubUsername: CONFIG.githubUsername || "(not set)",
    reviewMode: CONFIG.onlyOwnPRs ? "Only my PRs" : CONFIG.reviewOwnPRs ? "All PRs" : "Others' PRs only",
    syncMode: CONFIG.syncMode,
    cleanupInterval: `${CONFIG.cleanupIntervalHours}h`,
    cleanupAge: `${CONFIG.cleanupAgeDays} days`,
  }, "Configuration loaded");

  const exactRepos = getExactRepos();
  const repoRegexes = getRepoRegexes();
  if (exactRepos.length === 0 && repoRegexes.length === 0) {
    logger.info("Monitoring: All PRs involving you");
  } else {
    if (exactRepos.length > 0) {
      logger.info({ repos: exactRepos }, "Monitoring exact repos");
    }
    if (repoRegexes.length > 0) {
      logger.info({ patterns: repoRegexes.map((r) => `/${r.source}/`) }, "Monitoring patterns");
    }
  }

  // Start web server for browsing reviews
  startWebServer();

  // Polling behavior depends on sync mode
  if (CONFIG.syncMode === "auto") {
    // Initial poll
    await poll();

    // Schedule regular polling
    setInterval(poll, CONFIG.pollInterval * 1000);
    logger.info({ interval: `${CONFIG.pollInterval}s` }, "Auto sync enabled");
  } else {
    logger.info("Manual sync mode - use the web UI to trigger syncs");
  }

  // Run cleanup on startup and periodically (always runs regardless of sync mode)
  await runCleanup();
  setInterval(runCleanup, CONFIG.cleanupIntervalHours * 60 * 60 * 1000);

  logger.info({ nextCleanup: `${CONFIG.cleanupIntervalHours} hours` }, "Daemon running. Press Ctrl+C to stop.");
}

main().catch((e) => {
  logger.fatal({ error: (e as Error).message }, "Fatal error");
  process.exit(1);
});
