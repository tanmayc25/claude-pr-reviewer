import { CONFIG } from "./config";
import { logger } from "./logger";
import { prState, saveState, isPolling, setPolling } from "./state";
import { getOpenPRs } from "./github";
import { cloneOrUpdateRepo, checkoutPRBranch } from "./repo";
import { runReview } from "./review";
import type { PRDetails } from "./types";

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
  const isOwnPR = CONFIG.githubUsername && authorLogin === CONFIG.githubUsername;

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

export interface PendingPR {
  repo: string;
  number: number;
  title: string;
  author: string;
  hasChanges: boolean;
}

export async function getPendingPRs(): Promise<PendingPR[]> {
  const prs = await getOpenPRs();

  // Filter PRs based on config
  const filteredPRs = prs.filter((pr) => {
    const authorLogin = typeof pr.author === "object" ? pr.author?.login : pr.author;
    const isOwnPR = CONFIG.githubUsername && authorLogin === CONFIG.githubUsername;

    if (CONFIG.onlyOwnPRs && !isOwnPR) return false;
    if (!CONFIG.onlyOwnPRs && !CONFIG.reviewOwnPRs && isOwnPR) return false;
    return true;
  });

  return filteredPRs.map((pr) => {
    const prKey = `${pr.repo}#${pr.number}`;
    const lastSha = prState.get(prKey);
    const currentSha = pr.headRefOid;
    const authorLogin = typeof pr.author === "object" ? pr.author?.login : pr.author;

    return {
      repo: pr.repo!,
      number: pr.number,
      title: pr.title,
      author: authorLogin || "unknown",
      hasChanges: !lastSha || lastSha !== currentSha,
    };
  });
}

export async function syncSelectedPRs(
  selectedPRs: Array<{ repo: string; number: number }>
): Promise<{ processed: number; errors: number }> {
  if (isPolling) {
    throw new Error("Sync already in progress");
  }

  setPolling(true);
  logger.info({ count: selectedPRs.length }, "Syncing selected PRs");

  let processed = 0;
  let errors = 0;

  try {
    // Fetch full PR details for each selected PR
    const allPRs = await getOpenPRs();
    const prMap = new Map(allPRs.map((pr) => [`${pr.repo}#${pr.number}`, pr]));

    for (const { repo, number } of selectedPRs) {
      const prKey = `${repo}#${number}`;
      const pr = prMap.get(prKey);

      if (!pr) {
        logger.warn({ pr: prKey }, "PR not found, skipping");
        errors++;
        continue;
      }

      try {
        const result = await processPR(pr);
        if (result) {
          processed++;
        }
      } catch (error) {
        logger.error({ pr: prKey, error: (error as Error).message }, "Error processing PR");
        errors++;
      }
    }

    logger.info({ processed, errors }, "Selected PR sync complete");
    return { processed, errors };
  } finally {
    setPolling(false);
  }
}

export async function poll(): Promise<void> {
  // Prevent concurrent polls
  if (isPolling) {
    logger.warn("Previous poll still running, skipping this cycle");
    return;
  }

  setPolling(true);
  logger.info("Checking for PR updates...");

  try {
    const prs = await getOpenPRs();

    // Filter PRs based on config
    const filteredPRs = prs.filter((pr) => {
      const authorLogin = typeof pr.author === "object" ? pr.author?.login : pr.author;
      const isOwnPR = CONFIG.githubUsername && authorLogin === CONFIG.githubUsername;

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
      const status = cached === pr.headRefOid ? "ok" : cached ? "update" : "new";
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

    // Process PRs in parallel with concurrency limit
    const concurrency = CONFIG.parallelReviews;
    let processed = 0;

    // Filter to only PRs that need processing (new or updated)
    const prsToProcess = filteredPRs.filter((pr) => {
      const prKey = `${pr.repo}#${pr.number}`;
      const lastSha = prState.get(prKey);
      return pr.headRefOid && lastSha !== pr.headRefOid;
    });

    if (prsToProcess.length > 0) {
      logger.info({ count: prsToProcess.length, concurrency }, "Processing PRs in parallel");
    }

    // Process in chunks based on concurrency limit
    for (let i = 0; i < prsToProcess.length; i += concurrency) {
      const chunk = prsToProcess.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map(async (pr) => {
          try {
            return await processPR(pr);
          } catch (error) {
            logger.error({ pr: `${pr.repo}#${pr.number}`, error: (error as Error).message }, "Error processing PR");
            return null;
          }
        })
      );

      for (const reviewPath of results) {
        if (reviewPath) {
          logger.info({ path: reviewPath }, "Review completed");
          processed++;
        }
      }
    }

    if (processed > 0) {
      logger.info({ count: processed }, "Processed PRs");
    }
  } catch (error) {
    logger.error({ error: (error as Error).message }, "Poll error");
  } finally {
    setPolling(false);
  }
}
