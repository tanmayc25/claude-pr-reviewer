import { CONFIG } from "./config";
import { logger } from "./logger";
import { prState, saveState, isPolling, setPolling } from "./state";
import { getOpenPRs } from "./github";
import { cloneOrUpdateRepo, createWorktreeForPR, cleanupWorktree } from "./repo";
import { runReview } from "./review";
import { getAuthorLogin, shouldProcessPR } from "./utils";
import type { PRDetails } from "./types";

async function processPR(pr: PRDetails, customPrompt?: string, force?: boolean): Promise<string | null> {
  const prKey = `${pr.repo}#${pr.number}`;
  const lastSha = prState.get(prKey);
  const currentSha = pr.headRefOid;

  // Skip if no SHA available
  if (!currentSha) {
    logger.warn({ pr: prKey }, "No commit SHA available, skipping");
    return null;
  }

  // Skip if already processed this SHA (unless forced)
  if (lastSha === currentSha && !force) {
    return null;
  }

  const authorLogin = getAuthorLogin(pr.author);

  // Filter based on config
  if (!shouldProcessPR(authorLogin)) {
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

  let worktreeDir: string | null = null;
  try {
    // Ensure base repo is up to date
    await cloneOrUpdateRepo(pr.repo!);

    // Create isolated worktree for this PR (enables true parallel reviews)
    worktreeDir = await createWorktreeForPR(pr.repo!, pr.number);

    const reviewPath = await runReview(
      worktreeDir,
      pr.repo!,
      pr.number,
      pr.title,
      currentSha,
      customPrompt
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
  } finally {
    // Always clean up the worktree after review
    if (worktreeDir) {
      await cleanupWorktree(pr.repo!, pr.number);
    }
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

  // Filter PRs based on config and map to pending format
  return prs
    .filter((pr) => shouldProcessPR(getAuthorLogin(pr.author)))
    .map((pr) => {
      const prKey = `${pr.repo}#${pr.number}`;
      const lastSha = prState.get(prKey);

      return {
        repo: pr.repo!,
        number: pr.number,
        title: pr.title,
        author: getAuthorLogin(pr.author),
        hasChanges: !lastSha || lastSha !== pr.headRefOid,
      };
    });
}

export async function syncSelectedPRs(
  selectedPRs: Array<{ repo: string; number: number }>,
  customPrompt?: string,
  force?: boolean
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
        const result = await processPR(pr, customPrompt, force);
        if (result) {
          processed++;
        }
      } catch (error) {
        logger.error({ pr: prKey, error: (error as Error).message }, "Error processing PR");
        errors++;
      }
    }

    logger.info({ processed, errors, force: !!force }, "Selected PR sync complete");
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
    const filteredPRs = prs.filter((pr) => shouldProcessPR(getAuthorLogin(pr.author)));

    logger.info({ monitored: filteredPRs.length, total: prs.length }, "PRs found");

    // List filtered PRs
    for (const pr of filteredPRs) {
      const sha = pr.headRefOid ? pr.headRefOid.slice(0, 7) : "?";
      const cached = prState.get(`${pr.repo}#${pr.number}`);
      const status = cached === pr.headRefOid ? "ok" : cached ? "update" : "new";
      logger.debug(
        {
          status,
          pr: `${pr.repo}#${pr.number}`,
          sha,
          author: getAuthorLogin(pr.author),
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

    // Process PRs in parallel with concurrency limit
    // Each PR gets its own worktree, so parallel processing is safe
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
