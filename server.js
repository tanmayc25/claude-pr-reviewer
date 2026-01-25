const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

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
        log(`Invalid regex pattern: ${pattern} - ${e.message}`);
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

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      Object.entries(data).forEach(([k, v]) => prState.set(k, v));
      log(`Loaded state for ${prState.size} PRs`);
    }
  } catch (e) {
    log(`Could not load state: ${e.message}`);
  }
}

function saveState() {
  try {
    const data = Object.fromEntries(prState);
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log(`Could not save state: ${e.message}`);
  }
}

// =============================================================================
// Utilities
// =============================================================================

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

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
      log(`gh command failed: ${e.message}`);
    }
    return null;
  }
}

function notify(title, message, subtitle = "") {
  // macOS Notification Center
  try {
    const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"${subtitle ? ` subtitle "${subtitle.replace(/"/g, '\\"')}"` : ""} sound name "Glass"`;
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
    try {
      const { state } = JSON.parse(result);
      return state === "OPEN";
    } catch (e) {
      return true;
    }
  }
  return false;
}

function cleanupClosedPRs() {
  log("Checking for closed PRs to clean up...");
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
    log(`PR closed/merged: ${prKey} - removing from state`);
    prState.delete(prKey);

    const repoDir = path.join(CONFIG.workDir, repo.replace("/", "_"));
    if (fs.existsSync(repoDir)) {
      try {
        fs.rmSync(repoDir, { recursive: true, force: true });
        log(`Deleted local clone: ${repoDir}`);
      } catch (e) {
        log(`Could not delete ${repoDir}: ${e.message}`);
      }
    }
  }

  if (keysToRemove.length > 0) {
    saveState();
    log(`Cleaned up ${keysToRemove.length} closed PR(s)`);
  } else {
    log("No closed PRs to clean up");
  }
}

function cleanupOldRepos() {
  log(`Cleaning up repos older than ${CONFIG.cleanupAgeDays} days...`);

  if (!fs.existsSync(CONFIG.workDir)) return;

  const now = Date.now();
  const maxAge = CONFIG.cleanupAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  const entries = fs.readdirSync(CONFIG.workDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirPath = path.join(CONFIG.workDir, entry.name);
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
          log(`Deleted old repo: ${dirPath} (${Math.floor(age / (24 * 60 * 60 * 1000))} days old)`);
          cleaned++;
        }
      }
    } catch (e) {
      log(`Error checking ${dirPath}: ${e.message}`);
    }
  }

  if (cleaned > 0) {
    log(`Cleaned up ${cleaned} old repo(s)`);
  } else {
    log("No old repos to clean up");
  }
}

async function runCleanup() {
  log("\n--- Running cleanup ---");
  cleanupClosedPRs();
  cleanupOldRepos();
  log("--- Cleanup complete ---\n");
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
        const repoPRs = JSON.parse(result).map((pr) => ({ ...pr, repo }));
        prs = prs.concat(repoPRs);
      }
    }
  }

  // For regex patterns or no patterns, search all PRs involving user
  if (repoRegexes.length > 0 || !hasPatterns) {
    const result = ghCommand(
      `search prs --state=open --involves=@me --json repository,number,title,author,updatedAt --limit 100`
    );
    if (result) {
      const searchResults = JSON.parse(result);

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
          const fullPR = JSON.parse(prDetails);
          prs.push({ ...fullPR, repo: repoName });
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
    log(`Fetching updates: ${repoFullName}`);
    execSync("git fetch --all --prune", { cwd: repoDir, stdio: "pipe" });
  } else {
    log(`Cloning repo: ${repoFullName}`);
    execSync(`gh repo clone ${repoFullName} "${repoDir}"`, { stdio: "pipe" });
  }

  // Add review files to .gitignore
  const gitignorePath = path.join(repoDir, ".gitignore");
  const reviewIgnorePattern = "pr-review-*.md";

  try {
    let gitignoreContent = "";
    if (fs.existsSync(gitignorePath)) {
      gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
    }
    if (!gitignoreContent.includes(reviewIgnorePattern)) {
      fs.appendFileSync(
        gitignorePath,
        `\n# PR Review Daemon\n${reviewIgnorePattern}\n`
      );
    }
  } catch (e) {
    // Ignore gitignore errors
  }

  return repoDir;
}

async function checkoutPRBranch(repoDir, repoFullName, prNumber) {
  log(`Checking out PR #${prNumber}`);
  execSync(`gh pr checkout ${prNumber} --repo ${repoFullName}`, {
    cwd: repoDir,
    stdio: "pipe",
  });
}

// =============================================================================
// Review Generation
// =============================================================================

async function runReview(repoDir, repoFullName, prNumber, prTitle, commitSha) {
  log(`Preparing review for PR #${prNumber}: ${prTitle}`);

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
      prDetails = JSON.parse(detailsOutput);
    }
  } catch (e) {
    // Ignore
  }

  log(`Changed files: ${changedFiles.slice(0, 5).join(", ")}${changedFiles.length > 5 ? "..." : ""}`);

  const reviewOutputPath = path.join(repoDir, `pr-review-${prNumber}.md`);

  // Check for existing reviews (for context)
  let existingReviews = "";
  let isFirstReview = true;
  if (fs.existsSync(reviewOutputPath)) {
    existingReviews = fs.readFileSync(reviewOutputPath, "utf-8");
    isFirstReview = false;
    log("Found previous reviews for context");
  }

  log("Running Claude Code review...");

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
**Commit:** ${commitSha ? commitSha.slice(0, 7) : "unknown"}

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
    const claudeReview = execSync(
      `claude -p "${reviewPrompt.replace(/"/g, '\\"').replace(/\n/g, "\\n")}" --print`,
      {
        cwd: repoDir,
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: 600000,
      }
    );

    const timestamp = new Date().toISOString();
    const reviewEntry = `
---

## Review @ ${timestamp}
**Commit:** \`${commitSha ? commitSha.slice(0, 7) : "unknown"}\`

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

    log(`Review saved to: ${reviewOutputPath}`);
    return reviewOutputPath;
  } catch (error) {
    log(`Claude review error: ${error.message}`);

    const timestamp = new Date().toISOString();
    const errorEntry = `
---

## Review @ ${timestamp} (FAILED)
**Commit:** \`${commitSha ? commitSha.slice(0, 7) : "unknown"}\`
**Error:** ${error.message}

The automated review could not be completed. Please review manually.
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

  log(`\n${"=".repeat(60)}`);
  log(`${actionType}: ${pr.repo}#${pr.number}`);
  log(`Title: ${pr.title}`);
  log(`Author: ${authorLogin}`);
  log(`SHA: ${currentSha.slice(0, 7)}${lastSha ? ` (was: ${lastSha.slice(0, 7)})` : " (new)"}`);
  log(`${"=".repeat(60)}\n`);

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

    prState.set(prKey, currentSha);
    saveState();
    return reviewPath;
  } catch (error) {
    log(`Error processing PR: ${error.message}`);
    return null;
  }
}

// =============================================================================
// Polling
// =============================================================================

async function poll() {
  log("Checking for PR updates...");

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

    log(`Found ${filteredPRs.length} PRs to monitor (${prs.length} total)`);

    // List filtered PRs
    for (const pr of filteredPRs) {
      const authorLogin = pr.author?.login || pr.author;
      const sha = pr.headRefOid ? pr.headRefOid.slice(0, 7) : "?";
      const cached = prState.get(`${pr.repo}#${pr.number}`);
      const status =
        cached === pr.headRefOid ? "[ok]" : cached ? "[update]" : "[new]";
      log(`  ${status} ${pr.repo}#${pr.number} [${sha}] by ${authorLogin}: ${pr.title.slice(0, 50)}${pr.title.length > 50 ? "..." : ""}`);
    }

    let processed = 0;
    for (const pr of filteredPRs) {
      const reviewPath = await processPR(pr);
      if (reviewPath) {
        log(`Review saved: ${reviewPath}`);
        processed++;
      }
    }

    if (processed > 0) {
      log(`Processed ${processed} new/updated PR(s)`);
    }
  } catch (error) {
    log(`Poll error: ${error.message}`);
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
    console.error("ERROR: gh CLI is not authenticated. Run: gh auth login");
    process.exit(1);
  }

  ensureDir(CONFIG.workDir);
  loadState();

  log(`Poll interval: ${CONFIG.pollInterval}s`);
  log(`Work directory: ${CONFIG.workDir}`);
  log(`GitHub username: ${CONFIG.githubUsername || "(not set)"}`);
  log(`Review mode: ${CONFIG.onlyOwnPRs ? "Only my PRs" : CONFIG.reviewOwnPRs ? "All PRs" : "Others' PRs only"}`);
  log(`Cleanup: every ${CONFIG.cleanupIntervalHours}h, delete repos older than ${CONFIG.cleanupAgeDays} days`);

  if (exactRepos.length === 0 && repoRegexes.length === 0) {
    log("Monitoring: All PRs involving you");
  } else {
    if (exactRepos.length > 0) {
      log(`Monitoring repos: ${exactRepos.join(", ")}`);
    }
    if (repoRegexes.length > 0) {
      log(`Monitoring patterns: ${repoRegexes.map((r) => `/${r.source}/`).join(", ")}`);
    }
  }
  log("");

  // Initial poll
  await poll();

  // Schedule regular polling
  setInterval(poll, CONFIG.pollInterval * 1000);

  // Run cleanup on startup and periodically
  await runCleanup();
  setInterval(runCleanup, CONFIG.cleanupIntervalHours * 60 * 60 * 1000);

  log(`\nDaemon running. Press Ctrl+C to stop.`);
  log(`Next cleanup in ${CONFIG.cleanupIntervalHours} hours.\n`);
}

main().catch(console.error);
