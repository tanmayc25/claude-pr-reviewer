import { CONFIG } from "./config";
import { logger } from "./logger";
import { ghCommand, safeJsonParse } from "./utils";
import type { PRDetails } from "./types";

// Parse repo patterns into exact matches and regexes
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

// Mutable repo pattern state
let exactRepos: string[] = [];
let repoRegexes: RegExp[] = [];

// Initialize patterns
function initRepoPatterns(): void {
  const parsed = parseRepoPatterns(CONFIG.repoPatterns);
  exactRepos = parsed.exact;
  repoRegexes = parsed.regexes;
}

// Reload patterns (called when settings change)
export function reloadRepoPatterns(): void {
  initRepoPatterns();
}

// Export getters for the patterns
export function getExactRepos(): string[] {
  return exactRepos;
}

export function getRepoRegexes(): RegExp[] {
  return repoRegexes;
}

// Initialize on module load
initRepoPatterns();

export async function getOpenPRs(): Promise<PRDetails[]> {
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

export function isPROpen(repo: string, prNumber: number): boolean {
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
