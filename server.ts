import { execSync, type ExecSyncOptions } from "child_process";
import path from "path";
import fs from "fs";
import pino from "pino";
import pinoPretty from "pino-pretty";
import { marked } from "marked";

// =============================================================================
// Logger Setup
// =============================================================================

const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
  },
  pinoPretty({
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
    : [] as string[],

  // Poll interval in seconds
  pollInterval: parseInt(process.env.POLL_INTERVAL || "60", 10),

  // Directory to clone repos into (defaults to daemon directory)
  workDir: process.env.WORK_DIR || import.meta.dir,

  // Your GitHub username
  githubUsername: process.env.GITHUB_USERNAME || "",

  // Set to true to ONLY review your own PRs
  onlyOwnPRs: process.env.ONLY_OWN_PRS === "true",

  // Set to true to include your own PRs (when onlyOwnPRs is false)
  reviewOwnPRs: process.env.REVIEW_OWN_PRS === "true",

  // Cleanup settings
  cleanupIntervalHours: parseInt(process.env.CLEANUP_INTERVAL_HOURS || "24", 10),
  cleanupAgeDays: parseInt(process.env.CLEANUP_AGE_DAYS || "7", 10),

  // Web server port for browsing reviews
  webPort: parseInt(process.env.WEB_PORT || "3456", 10),
};

// =============================================================================
// Types
// =============================================================================

interface PRDetails {
  number: number;
  title: string;
  headRefName?: string;
  headRefOid?: string;
  author?: { login: string } | string;
  updatedAt?: string;
  body?: string;
  baseRefName?: string;
  url?: string;
  repo?: string;
  repository?: {
    nameWithOwner?: string;
    name?: string;
  };
}

interface GhCommandOptions extends ExecSyncOptions {
  ignoreError?: boolean;
}

// =============================================================================
// Repo Pattern Matching
// =============================================================================

function parseRepoPatterns(patterns: string[]): { exact: string[]; regexes: RegExp[] } {
  const exact: string[] = [];
  const regexes: RegExp[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      try {
        const regexStr = pattern.slice(1, -1);
        regexes.push(new RegExp(regexStr));
      } catch (e) {
        logger.error({ pattern, error: (e as Error).message }, "Invalid regex pattern");
      }
    } else {
      exact.push(pattern);
    }
  }

  return { exact, regexes };
}

function matchesRepoPatterns(repoName: string, exact: string[], regexes: RegExp[]): boolean {
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

const prState = new Map<string, string>();
const STATE_FILE = path.join(import.meta.dir, ".pr-state.json");

// Polling lock to prevent concurrent polls
let isPolling = false;

function loadState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      Object.entries(data).forEach(([k, v]) => prState.set(k, v as string));
      logger.info({ count: prState.size }, "Loaded PR state");
    }
  } catch (e) {
    logger.error({ error: (e as Error).message }, "Could not load state");
  }
}

function saveState(): void {
  try {
    const data = Object.fromEntries(prState);
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.error({ error: (e as Error).message }, "Could not save state");
  }
}

// =============================================================================
// Utilities
// =============================================================================

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ghCommand(args: string, options: GhCommandOptions = {}): string | null {
  try {
    return execSync(`gh ${args}`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    }).trim();
  } catch (e) {
    if (!options.ignoreError) {
      logger.error({ command: `gh ${args}`, error: (e as Error).message }, "gh command failed");
    }
    return null;
  }
}

function safeJsonParse<T>(str: string | null, fallback: T | null = null): T | null {
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch (e) {
    logger.warn({ error: (e as Error).message }, "JSON parse failed");
    return fallback;
  }
}

function notify(title: string, message: string, subtitle: string = ""): void {
  // macOS Notification Center
  try {
    const safeMessage = message.replace(/["'\\]/g, " ");
    const safeTitle = title.replace(/["'\\]/g, " ");
    const safeSubtitle = subtitle.replace(/["'\\]/g, " ");
    const script = `display notification "${safeMessage}" with title "${safeTitle}"${safeSubtitle ? ` subtitle "${safeSubtitle}"` : ""} sound name "Glass"`;
    execSync(`osascript -e '${script}'`, { stdio: "pipe" });
  } catch {
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

function isPROpen(repo: string, prNumber: number): boolean {
  const result = ghCommand(`pr view ${prNumber} --repo ${repo} --json state`, {
    ignoreError: true,
  });
  if (result) {
    const parsed = safeJsonParse<{ state: string }>(result);
    if (parsed) {
      return parsed.state === "OPEN";
    }
  }
  return false;
}

function cleanupClosedPRs(): void {
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

function cleanupOldRepos(): void {
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

async function runCleanup(): Promise<void> {
  logger.info("--- Running cleanup ---");
  cleanupClosedPRs();
  cleanupOldRepos();
  logger.info("--- Cleanup complete ---");
}

// =============================================================================
// GitHub PR Fetching
// =============================================================================

async function getOpenPRs(): Promise<PRDetails[]> {
  let prs: PRDetails[] = [];

  const hasPatterns = exactRepos.length > 0 || repoRegexes.length > 0;
  const hasRegexOnly = exactRepos.length === 0 && repoRegexes.length > 0;

  // Fetch from exact repos directly (more efficient)
  if (hasPatterns && !hasRegexOnly) {
    for (const repo of exactRepos) {
      const result = ghCommand(
        `pr list --repo ${repo} --json number,title,headRefName,headRefOid,author,updatedAt --limit 50`
      );
      if (result) {
        const repoPRs = safeJsonParse<PRDetails[]>(result, []) || [];
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
      const searchResults = safeJsonParse<PRDetails[]>(result, []) || [];

      for (const pr of searchResults) {
        const repoName =
          pr.repository?.nameWithOwner || pr.repository?.name || (pr.repository as unknown as string);
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
          const fullPR = safeJsonParse<PRDetails>(prDetails);
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

async function cloneOrUpdateRepo(repoFullName: string): Promise<string> {
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

async function checkoutPRBranch(repoDir: string, repoFullName: string, prNumber: number): Promise<void> {
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

async function runReview(
  repoDir: string,
  repoFullName: string,
  prNumber: number,
  prTitle: string,
  commitSha: string
): Promise<string | null> {
  logger.info({ pr: prNumber, title: prTitle }, "Preparing review");

  // Get changed files
  let changedFiles: string[] = [];
  try {
    const filesOutput = ghCommand(
      `pr diff ${prNumber} --repo ${repoFullName} --name-only`
    );
    if (filesOutput) {
      changedFiles = filesOutput.split("\n").filter(Boolean);
    }
  } catch {
    changedFiles = [];
  }

  // Get PR details
  let prDetails: Partial<PRDetails> = {};
  try {
    const detailsOutput = ghCommand(
      `pr view ${prNumber} --repo ${repoFullName} --json body,author,baseRefName,headRefName,url`
    );
    if (detailsOutput) {
      prDetails = safeJsonParse<PRDetails>(detailsOutput, {}) || {};
    }
  } catch {
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

  const authorLogin = typeof prDetails.author === "object" ? prDetails.author?.login : prDetails.author;

  const reviewPrompt = `You are reviewing a Pull Request. Analyze the changes and provide a thorough code review.

## PR #${prNumber}: ${prTitle}
**Repository:** ${repoFullName}
**Author:** ${authorLogin || "unknown"}
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
**Author:** ${authorLogin || "unknown"}
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
    const shortError = (error as Error).message.slice(0, 500);
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
**Author:** ${authorLogin || "unknown"}
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

async function processPR(pr: PRDetails): Promise<string | null> {
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

  const authorLogin = typeof pr.author === "object" ? pr.author?.login : pr.author;
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
    const repoDir = await cloneOrUpdateRepo(pr.repo!);
    await checkoutPRBranch(repoDir, pr.repo!, pr.number);
    const reviewPath = await runReview(
      repoDir,
      pr.repo!,
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
    logger.error({ pr: prKey, error: (error as Error).message.slice(0, 200) }, "Error processing PR");
    return null;
  }
}

// =============================================================================
// Polling
// =============================================================================

async function poll(): Promise<void> {
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
      const authorLogin = typeof pr.author === "object" ? pr.author?.login : pr.author;
      const isOwnPR =
        CONFIG.githubUsername && authorLogin === CONFIG.githubUsername;

      if (CONFIG.onlyOwnPRs && !isOwnPR) return false;
      if (!CONFIG.onlyOwnPRs && !CONFIG.reviewOwnPRs && isOwnPR) return false;
      return true;
    });

    logger.info({ monitored: filteredPRs.length, total: prs.length }, "PRs found");

    // List filtered PRs
    for (const pr of filteredPRs) {
      const authorLogin = typeof pr.author === "object" ? pr.author?.login : pr.author;
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
    logger.error({ error: (error as Error).message }, "Poll error");
  } finally {
    isPolling = false;
  }
}

// =============================================================================
// Web Server for Browsing Reviews
// =============================================================================

const HTML_TEMPLATE = (title: string, content: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - PR Reviews</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      background: #09090b;
      color: #fafafa;
      min-height: 100vh;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 24px; }
    a { color: #fafafa; text-decoration: none; }
    a:hover { color: #a1a1aa; }
    h1 { font-size: 1.875rem; font-weight: 600; color: #fafafa; margin-bottom: 8px; }
    h2 { font-size: 1.5rem; font-weight: 600; color: #fafafa; margin: 24px 0 16px; }
    h3 { font-size: 1.25rem; font-weight: 600; color: #fafafa; margin: 20px 0 12px; }
    .breadcrumb { margin-bottom: 24px; color: #71717a; font-size: 14px; }
    .breadcrumb a { color: #a1a1aa; }
    .breadcrumb a:hover { color: #fafafa; }
    .search-container { margin-bottom: 20px; }
    .search-input {
      width: 100%;
      padding: 10px 14px;
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 8px;
      color: #fafafa;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    .search-input::placeholder { color: #52525b; }
    .search-input:focus { border-color: #3f3f46; }
    .list { list-style: none; }
    .list li {
      padding: 16px;
      margin: 8px 0;
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 8px;
      transition: border-color 0.2s, background 0.2s;
    }
    .list li:hover { border-color: #3f3f46; background: #1f1f23; }
    .list li a { display: block; }
    .list .pr-header { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .list .pr-number { font-weight: 600; color: #fafafa; }
    .list .pr-title { color: #a1a1aa; }
    .list .pr-meta { display: flex; gap: 16px; color: #52525b; font-size: 13px; margin-top: 8px; }
    .list .pr-author { }
    .list .pr-synced { }
    .review-content {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 8px;
      padding: 24px;
    }
    .review-content h1, .review-content h2, .review-content h3 { border-bottom: 1px solid #27272a; padding-bottom: 8px; }
    .review-content p { margin: 12px 0; color: #d4d4d8; }
    .review-content ul, .review-content ol { margin: 12px 0; padding-left: 24px; color: #d4d4d8; }
    .review-content li { margin: 4px 0; }
    .review-content pre {
      background: #09090b;
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 16px 0;
      border: 1px solid #27272a;
    }
    .review-content code {
      background: #27272a;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
      font-size: 13px;
      color: #fafafa;
    }
    .review-content pre code { padding: 0; background: none; border: none; }
    .review-content blockquote {
      border-left: 3px solid #3f3f46;
      margin: 16px 0;
      padding-left: 16px;
      color: #71717a;
    }
    .review-content table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    .review-content th, .review-content td {
      border: 1px solid #27272a;
      padding: 10px 14px;
      text-align: left;
    }
    .review-content th { background: #18181b; font-weight: 600; }
    .review-content strong { color: #fafafa; }
    .review-content a { color: #a1a1aa; text-decoration: underline; }
    .review-content a:hover { color: #fafafa; }
    .empty { color: #52525b; font-style: italic; padding: 40px; text-align: center; }
    hr { border: none; border-top: 1px solid #27272a; margin: 24px 0; }
    .code-block-wrapper { position: relative; }
    .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      color: #a1a1aa;
      font-size: 12px;
      opacity: 0;
      transition: all 0.2s;
    }
    .code-block-wrapper:hover .copy-btn { opacity: 1; }
    .copy-btn:hover { background: #3f3f46; color: #fafafa; }
    .copy-btn.copied { background: #22c55e; border-color: #22c55e; color: #fff; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="container">
    ${content}
  </div>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      // Copy buttons for code blocks
      document.querySelectorAll('.review-content pre').forEach(function(pre) {
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);

        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.onclick = function() {
          const code = pre.querySelector('code') || pre;
          navigator.clipboard.writeText(code.textContent).then(function() {
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(function() {
              btn.textContent = 'Copy';
              btn.classList.remove('copied');
            }, 2000);
          });
        };
        wrapper.appendChild(btn);
      });

      // Search functionality
      const searchInput = document.getElementById('search-input');
      if (searchInput) {
        searchInput.addEventListener('input', function(e) {
          const query = e.target.value.toLowerCase();
          document.querySelectorAll('.list li').forEach(function(li) {
            const text = li.textContent.toLowerCase();
            li.classList.toggle('hidden', query && !text.includes(query));
          });
        });
      }
    });
  </script>
</body>
</html>`;

function extractPRMetadata(filePath: string): { title: string; author: string; lastSynced: string } {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const titleMatch = content.match(/^# PR Review: (.+)$/m);
    const authorMatch = content.match(/^\*\*Author:\*\* (.+)$/m);
    // Find all review timestamps and get the last one
    const reviewMatches = content.match(/## Review @ (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/g);
    let lastSynced = "unknown";
    if (reviewMatches && reviewMatches.length > 0) {
      const lastMatch = reviewMatches[reviewMatches.length - 1];
      const dateStr = lastMatch.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1];
      if (dateStr) {
        const date = new Date(dateStr);
        lastSynced = date.toLocaleString();
      }
    }
    return {
      title: titleMatch?.[1] || "Untitled",
      author: authorMatch?.[1] || "unknown",
      lastSynced,
    };
  } catch {
    return { title: "Untitled", author: "unknown", lastSynced: "unknown" };
  }
}

function startWebServer(): void {
  const reviewsBaseDir = path.join(CONFIG.workDir, "reviews");

  Bun.serve({
    port: CONFIG.webPort,
    hostname: "0.0.0.0",
    fetch(req) {
      const url = new URL(req.url);
      const pathname = decodeURIComponent(url.pathname);

      // Home - list all repos with reviews
      if (pathname === "/" || pathname === "") {
        let repos: string[] = [];
        if (fs.existsSync(reviewsBaseDir)) {
          repos = fs.readdirSync(reviewsBaseDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort();
        }

        const content = repos.length > 0
          ? `<div class="search-container">
              <input type="text" id="search-input" class="search-input" placeholder="Search repositories..." />
            </div>
            <ul class="list">${repos.map(r =>
              `<li><a href="/repo/${encodeURIComponent(r)}">${r.replace("_", "/")}</a></li>`
            ).join("")}</ul>`
          : `<p class="empty">No reviews yet. Reviews will appear here once PRs are processed.</p>`;

        return new Response(HTML_TEMPLATE("Home", `
          <h1>PR Reviews</h1>
          ${content}
        `), {
          headers: { "Content-Type": "text/html" },
        });
      }

      // Repo - list reviews for a repo
      const repoMatch = pathname.match(/^\/repo\/([^/]+)\/?$/);
      if (repoMatch) {
        const repoName = repoMatch[1];
        const repoDir = path.join(reviewsBaseDir, repoName);

        if (!fs.existsSync(repoDir)) {
          return new Response(HTML_TEMPLATE("Not Found", `
            <div class="breadcrumb"><a href="/">Home</a></div>
            <h1>Repository Not Found</h1>
            <p class="empty">No reviews found for ${repoName.replace("_", "/")}</p>
          `), {
            status: 404,
            headers: { "Content-Type": "text/html" },
          });
        }

        const reviews = fs.readdirSync(repoDir)
          .filter(f => f.endsWith(".md"))
          .sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)?.[0] || "0", 10);
            const numB = parseInt(b.match(/\d+/)?.[0] || "0", 10);
            return numB - numA;
          });

        const content = reviews.length > 0
          ? `<div class="search-container">
              <input type="text" id="search-input" class="search-input" placeholder="Search PRs by title, number, or author..." />
            </div>
            <ul class="list">${reviews.map(r => {
              const prNum = r.match(/pr-review-(\d+)\.md/)?.[1] || r;
              const filePath = path.join(repoDir, r);
              const { title, author, lastSynced } = extractPRMetadata(filePath);
              return `<li><a href="/repo/${encodeURIComponent(repoName)}/${encodeURIComponent(r)}">
                <div class="pr-header"><span class="pr-number">PR #${prNum}</span><span class="pr-title">${title}</span></div>
                <div class="pr-meta"><span class="pr-author">by ${author}</span><span class="pr-synced">synced ${lastSynced}</span></div>
              </a></li>`;
            }).join("")}</ul>`
          : `<p class="empty">No reviews yet for this repository.</p>`;

        return new Response(HTML_TEMPLATE(repoName.replace("_", "/"), `
          <div class="breadcrumb"><a href="/">Home</a> / ${repoName.replace("_", "/")}</div>
          <h1>${repoName.replace("_", "/")}</h1>
          ${content}
        `), {
          headers: { "Content-Type": "text/html" },
        });
      }

      // Review file - render markdown
      const reviewMatch = pathname.match(/^\/repo\/([^/]+)\/([^/]+)$/);
      if (reviewMatch) {
        const repoName = reviewMatch[1];
        const fileName = reviewMatch[2];
        const filePath = path.join(reviewsBaseDir, repoName, fileName);

        if (!fs.existsSync(filePath)) {
          return new Response(HTML_TEMPLATE("Not Found", `
            <div class="breadcrumb"><a href="/">Home</a> / <a href="/repo/${encodeURIComponent(repoName)}">${repoName.replace("_", "/")}</a></div>
            <h1>Review Not Found</h1>
            <p class="empty">The requested review file does not exist.</p>
          `), {
            status: 404,
            headers: { "Content-Type": "text/html" },
          });
        }

        const markdown = fs.readFileSync(filePath, "utf-8");
        const html = marked(markdown);
        const prNum = fileName.match(/pr-review-(\d+)\.md/)?.[1] || fileName;

        return new Response(HTML_TEMPLATE(`PR #${prNum}`, `
          <div class="breadcrumb">
            <a href="/">Home</a> /
            <a href="/repo/${encodeURIComponent(repoName)}">${repoName.replace("_", "/")}</a> /
            PR #${prNum}
          </div>
          <div class="review-content">
            ${html}
          </div>
        `), {
          headers: { "Content-Type": "text/html" },
        });
      }

      // 404
      return new Response(HTML_TEMPLATE("Not Found", `
        <div class="breadcrumb"><a href="/">Home</a></div>
        <h1>Page Not Found</h1>
        <p><a href="/">Go back home</a></p>
      `), {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  logger.info({ port: CONFIG.webPort, url: `http://localhost:${CONFIG.webPort}` }, "Review browser started");
}

// =============================================================================
// Main
// =============================================================================

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

  // Start web server for browsing reviews
  startWebServer();

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
  logger.fatal({ error: (e as Error).message }, "Fatal error");
  process.exit(1);
});
