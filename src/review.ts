import fs from "fs";
import path from "path";
import { CONFIG } from "./config";
import { logger } from "./logger";
import { ghCommandAsync, safeJsonParse, ensureDir } from "./utils";
import type { PRDetails } from "./types";

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
    const reviewEntry = `
---

## Review @ ${timestamp}
**Commit:** \`${shortSha}\`

${claudeReview}
`;

    if (isFirstReview) {
      const prUrl = prDetails.url || `https://github.com/${repoFullName}/pull/${prNumber}`;
      const header = `# PR Review: ${prTitle}

**Repository:** ${repoFullName}

**PR:** #${prNumber}

**Author:** ${authorLogin || "unknown"}

**URL:** ${prUrl}

**Created:** ${timestamp}
${reviewEntry}`;
      fs.writeFileSync(reviewOutputPath, header);
    } else {
      fs.appendFileSync(reviewOutputPath, reviewEntry);
    }

    logger.info({ path: reviewOutputPath }, "Review saved");
    return reviewOutputPath;
  } catch (error) {
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
