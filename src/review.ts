import fs from "fs";
import path from "path";
import { CONFIG } from "./config";
import { logger } from "./logger";
import { ghCommandAsync, safeJsonParse, ensureDir } from "./utils";
import type { PRDetails, PRReviewMeta, ReviewVersion } from "./types";

// ========================
// Version Management Helpers
// ========================

/**
 * Get the directory path for a PR's reviews
 */
export function getPRReviewDir(repoFullName: string, prNumber: number): string {
  const repoDir = repoFullName.replace("/", "_");
  return path.join(CONFIG.workDir, "reviews", repoDir, `pr-${prNumber}`);
}

/**
 * Generate a version filename from a timestamp
 */
export function getVersionFilename(timestamp: string): string {
  // Convert ISO timestamp to filename-safe format: v-20260125T143022Z.md
  return `v-${timestamp.replace(/[:.]/g, "").replace(/-/g, "")}.md`;
}

/**
 * Parse timestamp from version filename
 */
export function parseVersionTimestamp(filename: string): string | null {
  const match = filename.match(/^v-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.md$/);
  if (!match) return null;
  const [, year, month, day, hour, min, sec] = match;
  return `${year}-${month}-${day}T${hour}:${min}:${sec}Z`;
}

/**
 * List all versions for a PR, sorted newest first
 */
export function listVersions(prReviewDir: string): ReviewVersion[] {
  if (!fs.existsSync(prReviewDir)) return [];

  const files = fs.readdirSync(prReviewDir)
    .filter((f) => f.startsWith("v-") && f.endsWith(".md"))
    .sort((a, b) => b.localeCompare(a)); // Newest first (reverse lexicographic)

  return files.map((filename) => {
    const content = fs.readFileSync(path.join(prReviewDir, filename), "utf-8");
    const commitMatch = content.match(/^\*\*Commit:\*\* `([^`]+)`/m);
    const timestamp = parseVersionTimestamp(filename) || "unknown";

    return {
      timestamp,
      commitSha: commitMatch?.[1] || "unknown",
      filename,
    };
  });
}

/**
 * Read the content of a specific version
 */
export function readVersion(prReviewDir: string, filename: string): string {
  const filePath = path.join(prReviewDir, filename);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Get PR metadata from meta.json
 */
export function getPRMeta(prReviewDir: string): PRReviewMeta | null {
  const metaPath = path.join(prReviewDir, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Save PR metadata to meta.json
 */
export function savePRMeta(prReviewDir: string, meta: PRReviewMeta): void {
  ensureDir(prReviewDir);
  const metaPath = path.join(prReviewDir, "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Migrate old single-file format to versioned directory
 */
export function migrateOldFormat(repoFullName: string, prNumber: number): void {
  const repoDir = repoFullName.replace("/", "_");
  const oldFilePath = path.join(CONFIG.workDir, "reviews", repoDir, `pr-review-${prNumber}.md`);

  if (!fs.existsSync(oldFilePath)) return;

  logger.info({ prNumber, repoFullName }, "Migrating old review format to versioned directory");

  const content = fs.readFileSync(oldFilePath, "utf-8");
  const prReviewDir = getPRReviewDir(repoFullName, prNumber);
  ensureDir(prReviewDir);

  // Extract header metadata
  const titleMatch = content.match(/^# PR Review: (.+)$/m);
  const authorMatch = content.match(/^\*\*Author:\*\* (.+)$/m);
  const urlMatch = content.match(/^\*\*URL:\*\* (.+)$/m);
  const createdMatch = content.match(/^\*\*Created:\*\* (.+)$/m);

  const meta: PRReviewMeta = {
    title: titleMatch?.[1] || "Untitled",
    repoFullName,
    prNumber,
    author: authorMatch?.[1] || "unknown",
    url: urlMatch?.[1] || `https://github.com/${repoFullName}/pull/${prNumber}`,
    createdAt: createdMatch?.[1] || new Date().toISOString(),
  };
  savePRMeta(prReviewDir, meta);

  // Split content into review sections
  const reviewSections = content.split(/(?=---\s*\n\s*## Review @)/);

  for (const section of reviewSections) {
    // Extract timestamp from each review section
    const timestampMatch = section.match(/## Review @ (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
    if (!timestampMatch) continue;

    const timestamp = timestampMatch[1];
    const commitMatch = section.match(/^\*\*Commit:\*\* `([^`]+)`/m);
    const commitSha = commitMatch?.[1] || "unknown";

    // Extract the review content (everything after the header)
    const reviewContent = section
      .replace(/^---\s*\n/, "") // Remove leading ---
      .trim();

    if (!reviewContent) continue;

    // Write version file
    const versionFilename = getVersionFilename(timestamp);
    const versionPath = path.join(prReviewDir, versionFilename);

    // Create version content with consistent format
    const versionContent = `## Review @ ${timestamp}
**Commit:** \`${commitSha}\`

${reviewContent.replace(/^## Review @ .+\n\*\*Commit:\*\* `.+`\n*/, "").trim()}
`;

    fs.writeFileSync(versionPath, versionContent);
    logger.debug({ timestamp, filename: versionFilename }, "Migrated review version");
  }

  // Delete old file
  fs.unlinkSync(oldFilePath);
  logger.info({ prNumber }, "Migration complete, old file deleted");
}

/**
 * Delete versions beyond the max limit
 */
export function pruneVersions(prReviewDir: string): void {
  const versions = listVersions(prReviewDir);
  if (versions.length <= CONFIG.maxReviewVersions) return;

  const toDelete = versions.slice(CONFIG.maxReviewVersions);
  for (const version of toDelete) {
    const filePath = path.join(prReviewDir, version.filename);
    try {
      fs.unlinkSync(filePath);
      logger.debug({ filename: version.filename }, "Pruned old version");
    } catch (e) {
      logger.error({ filename: version.filename, error: (e as Error).message }, "Failed to prune version");
    }
  }

  if (toDelete.length > 0) {
    logger.info({ count: toDelete.length, prReviewDir }, "Pruned old versions");
  }
}

/**
 * Build context string from previous versions for Claude
 */
export function buildPreviousContext(prReviewDir: string): string {
  const versions = listVersions(prReviewDir);
  if (versions.length === 0) return "";

  const contextVersions = versions.slice(0, CONFIG.contextVersions);
  if (contextVersions.length === 0) return "";

  const contextParts = contextVersions.map((version, index) => {
    const content = readVersion(prReviewDir, version.filename);
    const label = index === 0 ? "most recent" : `${index + 1} reviews ago`;
    const date = new Date(version.timestamp).toLocaleString();

    return `### Review ${contextVersions.length - index} (${label}) - ${version.timestamp}
**Commit:** \`${version.commitSha}\` | ${date}
<previous_review_${contextVersions.length - index}>
${content}
</previous_review_${contextVersions.length - index}>`;
  });

  return `

## Previous Reviews (for context)
Use these to track what issues were raised before and whether they've been addressed.

${contextParts.reverse().join("\n\n")}

`;
}

// ========================
// Main Review Function
// ========================

export async function runReview(
  repoDir: string,
  repoFullName: string,
  prNumber: number,
  prTitle: string,
  commitSha: string,
  customPrompt?: string
): Promise<string | null> {
  logger.info({ pr: prNumber, title: prTitle }, "Preparing review");

  // Get changed files (async to not block event loop)
  let changedFiles: string[] = [];
  try {
    const filesOutput = await ghCommandAsync(
      `pr diff ${prNumber} --repo ${repoFullName} --name-only`
    );
    if (filesOutput) {
      changedFiles = filesOutput.split("\n").filter(Boolean);
    }
  } catch {
    changedFiles = [];
  }

  // Get PR details (async to not block event loop)
  let prDetails: Partial<PRDetails> = {};
  try {
    const detailsOutput = await ghCommandAsync(
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

  // Set up versioned directory structure
  const prReviewDir = getPRReviewDir(repoFullName, prNumber);

  // Check for and migrate old format
  migrateOldFormat(repoFullName, prNumber);

  // Ensure directory exists
  ensureDir(prReviewDir);

  // Get or create PR metadata
  let meta = getPRMeta(prReviewDir);
  const authorLogin = typeof prDetails.author === "object" ? prDetails.author?.login : prDetails.author;
  const prUrl = prDetails.url || `https://github.com/${repoFullName}/pull/${prNumber}`;

  if (!meta) {
    meta = {
      title: prTitle,
      repoFullName,
      prNumber,
      author: authorLogin || "unknown",
      url: prUrl,
      createdAt: new Date().toISOString(),
    };
    savePRMeta(prReviewDir, meta);
  }

  // Build context from previous versions
  const contextSection = buildPreviousContext(prReviewDir);

  logger.info("Running Claude Code review...");

  const reviewPrompt = `You are reviewing a Pull Request. Analyze the changes and provide a thorough code review.

## PR #${prNumber}: ${prTitle}
**Repository:** ${repoFullName}
**Author:** ${authorLogin || "unknown"}
**Branch:** ${prDetails.headRefName || "unknown"} -> ${prDetails.baseRefName || "main"}
**URL:** ${prUrl}
**Commit:** ${shortSha}

## PR Description
${prDetails.body || "(No description provided)"}

## Changed Files (${changedFiles.length})
${changedFiles.map((f) => `- ${f}`).join("\n")}
${contextSection}${customPrompt ? `## Additional Instructions
${customPrompt}

` : ""}## Your Task
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
    // Use Bun.spawn for async execution - doesn't block the event loop
    const proc = Bun.spawn(["claude", "--print"], {
      cwd: repoDir,
      stdin: new Blob([reviewPrompt]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const claudeReview = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    const timestamp = new Date().toISOString();
    const versionFilename = getVersionFilename(timestamp);
    const versionPath = path.join(prReviewDir, versionFilename);

    const versionContent = `## Review @ ${timestamp}
**Commit:** \`${shortSha}\`

${claudeReview}
`;

    fs.writeFileSync(versionPath, versionContent);
    logger.info({ path: versionPath }, "Review saved");

    // Prune old versions
    pruneVersions(prReviewDir);

    return versionPath;
  } catch (error) {
    const shortError = (error as Error).message.slice(0, 500);
    logger.error({ error: shortError }, "Claude review error");

    const timestamp = new Date().toISOString();
    const versionFilename = getVersionFilename(timestamp);
    const versionPath = path.join(prReviewDir, versionFilename);

    const errorContent = `## Review @ ${timestamp} (FAILED)
**Commit:** \`${shortSha}\`
**Error:** ${shortError}

The automated review could not be completed. Will retry on next poll.
`;

    fs.writeFileSync(versionPath, errorContent);
    return null;
  }
}
