import path from "path";

export const CONFIG = {
  // Repos to monitor - leave empty to monitor all PRs involving you
  repoPatterns: process.env.REPOS
    ? process.env.REPOS.split(",").map((s) => s.trim()).filter(Boolean)
    : [] as string[],

  // Poll interval in seconds
  pollInterval: parseInt(process.env.POLL_INTERVAL || "60", 10),

  // Directory to clone repos into (defaults to project directory)
  workDir: process.env.WORK_DIR || path.join(import.meta.dir, ".."),

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

  // Sync mode: "auto" (poll automatically) or "manual" (trigger from UI)
  syncMode: (process.env.SYNC_MODE || "auto") as "auto" | "manual",

  // Number of PRs to review in parallel
  parallelReviews: parseInt(process.env.PARALLEL_REVIEWS || "3", 10),
};
