import { editableConfig, staticConfig } from "./settings";

export const CONFIG = {
  // Dynamic settings (read from editableConfig via getters)
  get githubUsername() {
    return editableConfig.githubUsername;
  },
  get repoPatterns() {
    return editableConfig.repoPatterns;
  },
  get pollInterval() {
    return editableConfig.pollInterval;
  },
  get syncMode() {
    return editableConfig.syncMode;
  },
  get onlyOwnPRs() {
    return editableConfig.onlyOwnPRs;
  },
  get reviewOwnPRs() {
    return editableConfig.reviewOwnPRs;
  },
  get parallelReviews() {
    return editableConfig.parallelReviews;
  },
  get maxReviewVersions() {
    return editableConfig.maxReviewVersions;
  },
  get contextVersions() {
    return editableConfig.contextVersions;
  },
  get cleanupIntervalHours() {
    return editableConfig.cleanupIntervalHours;
  },
  get cleanupAgeDays() {
    return editableConfig.cleanupAgeDays;
  },

  // Static settings (require restart)
  webPort: staticConfig.webPort,
  workDir: staticConfig.workDir,
};
