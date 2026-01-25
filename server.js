const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const pino = require("pino");

// =============================================================================
// Logger Setup
// =============================================================================

const pretty = require("pino-pretty");
const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
  },
  pretty({
    colorize: true,
    translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
    ignore: "pid,hostname",
    sync: true,
  })
);

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
  // Repos to monitor - leave empty to monitor all PRs involving you
  // Exact: "owner/repo,owner/repo2"
  // Regex: "/pattern/" e.g. "/mycompany\/.*/"
  repoPatterns: process.env.REPOS
    ? process.env.REPOS.split(",").map((s) => s.trim()).filter(Boolean)
    : [],

  // Poll interval in seconds
  pollInterval: parseInt(process.env.POLL_INTERVAL || "60", 10),

  // Directory to clone repos into (defaults to daemon directory)
  workDir: process.env.WORK_DIR || __dirname,

  // Your GitHub username
  githubUsername: process.env.GITHUB_USERNAME || "",

  // Set to true to ONLY review your own PRs
  onlyOwnPRs: process.env.ONLY_OWN_PRS === "true",

  // Set to true to include your own PRs (when onlyOwnPRs is false)
  reviewOwnPRs: process.env.REVIEW_OWN_PRS === "true",

  // Cleanup settings
  cleanupIntervalHours: parseInt(process.env.CLEANUP_INTERVAL_HOURS || "24", 10),
  cleanupAgeDays: parseInt(process.env.CLEANUP_AGE_DAYS || "7", 10),
};

// =============================================================================
// Repo Pattern Matching
// =============================================================================

function parseRepoPatterns(patterns) {
  const exact = [];
  const regexes = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      try {
        const regexStr = pattern.slice(1, -1);
        regexes.push(new RegExp(regexStr));
      } catch (e) {
        logger.error({ pattern, error: e.message }, "Invalid regex pattern");
      }
    } else {
      exact.push(pattern);
    }
  }

  return { exact, regexes };
}

function matchesRepoPatterns(repoName, exact, regexes) {
  if (exact.length === 0 && regexes.length === 0) {
    return true;
  }
  if (exact.includes(repoName)) {
    return true;
  }
  for (const regex of regexes) {
    if (regex.test(repoName)) {
      return true;
    }
  }
  return false;
}

const { exact: exactRepos, regexes: repoRegexes } = parseRepoPatterns(CONFIG.repoPatterns);

// =============================================================================
// State Management
// =============================================================================

const prState = new Map();
const STATE_FILE = path.join(__dirname, ".pr-state.json");

// Polling lock to prevent concurrent polls
let isPolling = false;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      Object.entries(data).forEach(([k, v]) => prState.set(k, v));
      logger.info({ count: prState.size }, "Loaded PR state");
    }
  } catch (e) {
    logger.error({ error: e.message }, "Could not load state");
  }
}

function saveState() {
  try {
    const data = Object.fromEntries(prState);
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.error({ error: e.message }, "Could not save state");
  }
}

// =============================================================================
// Utilities
// =============================================================================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ghCommand(args, options = {}) {
  try {
    return execSync(`gh ${args}`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    }).trim();
  } catch (e) {
    if (!options.ignoreError) {
      logger.error({ command: `gh ${args}`, error: e.message }, "gh command failed");
    }
    return null;
  }
}

function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch (e) {
    logger.warn({ error: e.message }, "JSON parse failed");
    return fallback;
  }
}

function notify(title, message, subtitle = "") {
  // macOS Notification Center
  try {
    const safeMessage = message.replace(/["'\\]/g, " ");
    const safeTitle = title.replace(/["'\\]/g, " ");
    const safeSubtitle = subtitle.replace(/["'\\]/g, " ");
    const script = `display notification "${safeMessage}" with title "${safeTitle}"${safeSubtitle ? ` subtitle "${safeSubtitle}"` : ""} sound name "Glass"`;
    execSync(`osascript -e '${script}'`, { stdio: "pipe" });
  } catch (e) {
    // Ignore notification errors
  }

  // iTerm2 notification via OSC 9
  process.stdout.write(`\x1b]9;${title}: ${message}\x07`);

  // Terminal bell
  process.stdout.write("\x07");
}

// =============================================================================
// Cleanup
// =============================================================================

function isPROpen(repo, prNumber) {
  const result = ghCommand(`pr view ${prNumber} --repo ${repo} --json state`, {
    ignoreError: true,
  });
  if (result) {
    const parsed = safeJsonParse(result);
    if (parsed) {
      return parsed.state === "OPEN";
    }
  }
  return false;
}

function cleanupClosedPRs() {
  logger.info("Checking for closed PRs to clean up...");
  const keysToRemove = [];

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
        logger.error({ dir: repoDir, error: e.message }, "Could not delete repo");
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

function cleanupOldRepos() {
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
      logger.error({ dir: dirPath, error: e.message }, "Error checking directory");
    }
  }

  if (cleaned > 0) {
    logger.info({ count: cleaned }, "Cleaned up old repos");
  } else {
    logger.debug("No old repos to clean up");
  }
}

async function runCleanup() {
  logger.info("--- Running cleanup ---");
  cleanupClosedPRs();
  cleanupOldRepos();
  logger.info("--- Cleanup complete ---");
}

// =============================================================================
// GitHub PR Fetching
// =============================================================================

async function getOpenPRs() {
  let prs = [];

  const hasPatterns = exactRepos.length > 0 || repoRegexes.length > 0;
  const hasRegexOnly = exactRepos.length === 0 && repoRegexes.length > 0;

  // Fetch from exact repos directly (more efficient)
  if (hasPatterns && !hasRegexOnly) {
    for (const repo of exactRepos) {
      const result = ghCommand(
        `pr list --repo ${repo} --json number,title,headRefName,headRefOid,author,updatedAt --limit 50`
      );
      if (result) {
        const repoPRs = safeJsonParse(result, []);
        prs = prs.concat(repoPRs.map((pr) => ({ ...pr, repo })));
      }
    }
  }

  // For regex patterns or no patterns, search all PRs involving user
  if (repoRegexes.length > 0 || !hasPatterns) {
    const result = ghCommand(
      `search prs --state=open --involves=@me --json repository,number,title,author,updatedAt --limit 100`
    );
    if (result) {
      const searchResults = safeJsonParse(result, []);

      for (const pr of searchResults) {
        const repoName =
          pr.repository?.nameWithOwner || pr.repository?.name || pr.repository;
        if (!repoName) continue;

        if (!matchesRepoPatterns(repoName, exactRepos, repoRegexes)) {
          continue;
        }

        const isDupe = prs.some(
          (p) => p.repo === repoName && p.number === pr.number
        );
        if (isDupe) continue;

        // Fetch full PR details
        const prDetails = ghCommand(
          `pr view ${pr.number} --repo ${repoName} --json number,title,headRefName,headRefOid,author,updatedAt`
        );
        if (prDetails) {
          const fullPR = safeJsonParse(prDetails);
          if (fullPR) {
            prs.push({ ...fullPR, repo: repoName });
          }
        }
      }
    }
  }

  return prs;
}

// =============================================================================
// Repository Management
// =============================================================================

async function cloneOrUpdateRepo(repoFullName) {
  const repoDir = path.join(CONFIG.workDir, repoFullName.replace("/", "_"));
  ensureDir(CONFIG.workDir);

  if (fs.existsSync(path.join(repoDir, ".git"))) {
    logger.info({ repo: repoFullName }, "Fetching updates");
    execSync("git fetch --all --prune", { cwd: repoDir, stdio: "pipe" });
  } else {
    logger.info({ repo: repoFullName }, "Cloning repo");
    execSync(`gh repo clone ${repoFullName} "${repoDir}"`, { stdio: "pipe" });
  }

  return repoDir;
}

async function checkoutPRBranch(repoDir, repoFullName, prNumber) {
  logger.info({ pr: prNumber }, "Checking out PR");
  // Reset any local changes before checkout
  execSync("git checkout -- .", { cwd: repoDir, stdio: "pipe" });
  execSync(`gh pr checkout ${prNumber} --repo ${repoFullName}`, {
    cwd: repoDir,
    stdio: "pipe",
  });
}

// =============================================================================
// Review Generation
// =============================================================================

async function runReview(repoDir, repoFullName, prNumber, prTitle, commitSha) {
  logger.info({ pr: prNumber, title: prTitle }, "Preparing review");

  // Get changed files
  let changedFiles = [];
  try {
    const filesOutput = ghCommand(
      `pr diff ${prNumber} --repo ${repoFullName} --name-only`
    );
    if (filesOutput) {
      changedFiles = filesOutput.split("\n").filter(Boolean);
    }
  } catch (e) {
    changedFiles = [];
  }

  // Get PR details
  let prDetails = {};
  try {
    const detailsOutput = ghCommand(
      `pr view ${prNumber} --repo ${repoFullName} --json body,author,baseRefName,headRefName,url`
    );
    if (detailsOutput) {
      prDetails = safeJsonParse(detailsOutput, {});
    }
  } catch (e) {
    // Ignore
  }

  const shortSha = commitSha ? commitSha.slice(0, 7) : "unknown";
  logger.info({ files: changedFiles.slice(0, 5), total: changedFiles.length }, "Changed files");

  const reviewsDir = path.join(CONFIG.workDir, "reviews", repoFullName.replace("/", "_"));
  ensureDir(reviewsDir);
  const reviewOutputPath = path.join(reviewsDir, `pr-review-${prNumber}.md`);

  // Check for existing reviews (for context)
  let existingReviews = "";
  let isFirstReview = true;
  if (fs.existsSync(reviewOutputPath)) {
    existingReviews = fs.readFileSync(reviewOutputPath, "utf-8");
    isFirstReview = false;
    logger.debug("Found previous reviews for context");
  }

  logger.info("Running Claude Code review...");

  // Build prompt with context from previous reviews
  let contextSection = "";
  if (existingReviews) {
    contextSection = `

## Previous Reviews (for context)
The following are your previous reviews of this PR. Use them to:
- Track what issues were raised before
- Note if previous concerns have been addressed
- Avoid repeating the same feedback if already fixed
- Reference previous review points if still relevant

<previous_reviews>
${existingReviews}
</previous_reviews>

`;
  }

  const reviewPrompt = `You are reviewing a Pull Request. Analyze the changes and provide a thorough code review.

## PR #${prNumber}: ${prTitle}
**Repository:** ${repoFullName}
**Author:** ${prDetails.author?.login || "unknown"}
**Branch:** ${prDetails.headRefName || "unknown"} -> ${prDetails.baseRefName || "main"}
**URL:** ${prDetails.url || `https://github.com/${repoFullName}/pull/${prNumber}`}
**Commit:** ${shortSha}

## PR Description
${prDetails.body || "(No description provided)"}

## Changed Files (${changedFiles.length})
${changedFiles.map((f) => `- ${f}`).join("\n")}
${contextSection}
## Your Task
1. Read and analyze each changed file in this repository
2. Review the code changes for:
   - Code quality and best practices
   - Potential bugs or edge cases
   - Security concerns
   - Performance implications
   - Test coverage (if applicable)
3. Provide specific, actionable feedback with file paths and line references
4. If there were previous reviews, note which issues have been addressed and which remain
5. Summarize your overall assessment (approve, request changes, or needs discussion)

Start by reading the changed files, then provide your review.`;

  try {
    // Use stdin to pass prompt - avoids all shell escaping issues
    const claudeReview = execSync("claude --print", {
      cwd: repoDir,
      encoding: "utf-8",
      input: reviewPrompt,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 600000,
    });

    const timestamp = new Date().toISOString();
    const reviewEntry = `
---

## Review @ ${timestamp}
**Commit:** \`${shortSha}\`

${claudeReview}
`;

    if (isFirstReview) {
      const header = `# PR Review: ${prTitle}

**Repository:** ${repoFullName}
**PR:** #${prNumber}
**Author:** ${prDetails.author?.login || "unknown"}
**URL:** ${prDetails.url || `https://github.com/${repoFullName}/pull/${prNumber}`}
**Created:** ${timestamp}
${reviewEntry}`;
      fs.writeFileSync(reviewOutputPath, header);
    } else {
      fs.appendFileSync(reviewOutputPath, reviewEntry);
    }

    logger.info({ path: reviewOutputPath }, "Review saved");
    return reviewOutputPath;
  } catch (error) {
    // Truncate error message to avoid bloating the review file
    const shortError = error.message.slice(0, 500);
    logger.error({ error: shortError }, "Claude review error");

    const timestamp = new Date().toISOString();
    const errorEntry = `
---

## Review @ ${timestamp} (FAILED)
**Commit:** \`${shortSha}\`
**Error:** ${shortError}

The automated review could not be completed. Will retry on next poll.
`;

    if (isFirstReview) {
      const header = `# PR Review: ${prTitle}

**Repository:** ${repoFullName}
**PR:** #${prNumber}
**Author:** ${prDetails.author?.login || "unknown"}
**URL:** ${prDetails.url || `https://github.com/${repoFullName}/pull/${prNumber}`}
${errorEntry}`;
      fs.writeFileSync(reviewOutputPath, header);
    } else {
      fs.appendFileSync(reviewOutputPath, errorEntry);
    }

    return null;
  }
}

// =============================================================================
// PR Processing
// =============================================================================

async function processPR(pr) {
  const prKey = `${pr.repo}#${pr.number}`;
  const lastSha = prState.get(prKey);
  const currentSha = pr.headRefOid;

  // Skip if no SHA available
  if (!currentSha) {
    logger.warn({ pr: prKey }, "No commit SHA available, skipping");
    return null;
  }

  // Skip if already processed this SHA
  if (lastSha === currentSha) {
    return null;
  }

  const authorLogin = pr.author?.login || pr.author;
  const isOwnPR =
    CONFIG.githubUsername && authorLogin === CONFIG.githubUsername;

  // Filter based on config
  if (CONFIG.onlyOwnPRs && !isOwnPR) {
    prState.set(prKey, currentSha);
    return null;
  }

  if (!CONFIG.onlyOwnPRs && !CONFIG.reviewOwnPRs && isOwnPR) {
    prState.set(prKey, currentSha);
    return null;
  }

  const isNew = !lastSha;
  const actionType = isNew ? "New PR" : "PR Updated";
  const shortSha = currentSha.slice(0, 7);
  const lastShortSha = lastSha ? lastSha.slice(0, 7) : null;

  logger.info(
    {
      action: actionType,
      pr: prKey,
      title: pr.title,
      author: authorLogin,
      sha: shortSha,
      previousSha: lastShortSha,
    },
    `${actionType} detected`
  );

  notify(
    actionType,
    pr.title,
    `${pr.repo}#${pr.number} by ${authorLogin}`
  );

  try {
    const repoDir = await cloneOrUpdateRepo(pr.repo);
    await checkoutPRBranch(repoDir, pr.repo, pr.number);
    const reviewPath = await runReview(
      repoDir,
      pr.repo,
      pr.number,
      pr.title,
      currentSha
    );

    // Only update state if review succeeded - allows retry on failure
    if (reviewPath) {
      prState.set(prKey, currentSha);
      saveState();
    } else {
      logger.warn({ pr: prKey }, "Review failed, will retry on next poll");
    }
    return reviewPath;
  } catch (error) {
    logger.error({ pr: prKey, error: error.message.slice(0, 200) }, "Error processing PR");
    return null;
  }
}

// =============================================================================
// Polling
// =============================================================================

async function poll() {
  // Prevent concurrent polls
  if (isPolling) {
    logger.warn("Previous poll still running, skipping this cycle");
    return;
  }

  isPolling = true;
  logger.info("Checking for PR updates...");

  try {
    const prs = await getOpenPRs();

    // Filter PRs based on config
    const filteredPRs = prs.filter((pr) => {
      const authorLogin = pr.author?.login || pr.author;
      const isOwnPR =
        CONFIG.githubUsername && authorLogin === CONFIG.githubUsername;

      if (CONFIG.onlyOwnPRs && !isOwnPR) return false;
      if (!CONFIG.onlyOwnPRs && !CONFIG.reviewOwnPRs && isOwnPR) return false;
      return true;
    });

    logger.info({ monitored: filteredPRs.length, total: prs.length }, "PRs found");

    // List filtered PRs
    for (const pr of filteredPRs) {
      const authorLogin = pr.author?.login || pr.author;
      const sha = pr.headRefOid ? pr.headRefOid.slice(0, 7) : "?";
      const cached = prState.get(`${pr.repo}#${pr.number}`);
      const status =
        cached === pr.headRefOid ? "ok" : cached ? "update" : "new";
      logger.debug(
        {
          status,
          pr: `${pr.repo}#${pr.number}`,
          sha,
          author: authorLogin,
          title: pr.title.slice(0, 50),
        },
        "PR status"
      );
    }

    let processed = 0;
    for (const pr of filteredPRs) {
      const reviewPath = await processPR(pr);
      if (reviewPath) {
        logger.info({ path: reviewPath }, "Review completed");
        processed++;
      }
    }

    if (processed > 0) {
      logger.info({ count: processed }, "Processed PRs");
    }
  } catch (error) {
    logger.error({ error: error.message }, "Poll error");
  } finally {
    isPolling = false;
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log(`
+------------------------------------------------------------+
|              PR Review Daemon (Claude Code)                |
+------------------------------------------------------------+
`);

  // Check gh CLI is authenticated
  try {
    execSync("gh auth status", { stdio: "pipe" });
  } catch (e) {
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
    cleanupInterval: `${CONFIG.cleanupIntervalHours}h`,
    cleanupAge: `${CONFIG.cleanupAgeDays} days`,
  }, "Configuration loaded");

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

  // Initial poll
  await poll();

  // Schedule regular polling
  setInterval(poll, CONFIG.pollInterval * 1000);

  // Run cleanup on startup and periodically
  await runCleanup();
  setInterval(runCleanup, CONFIG.cleanupIntervalHours * 60 * 60 * 1000);

  logger.info({ nextCleanup: `${CONFIG.cleanupIntervalHours} hours` }, "Daemon running. Press Ctrl+C to stop.");
}

main().catch((e) => {
  logger.fatal({ error: e.message }, "Fatal error");
  process.exit(1);
});
