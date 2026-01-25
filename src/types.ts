export interface PRDetails {
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

export interface PRMetadata {
  title: string;
  author: string;
  lastSynced: string;
}

export interface ReviewVersion {
  timestamp: string;       // ISO 8601
  commitSha: string;
  filename: string;
}

export interface PRReviewMeta {
  title: string;
  repoFullName: string;
  prNumber: number;
  author: string;
  url: string;
  createdAt: string;
}

export interface EditableSettings {
  githubUsername: string;
  repoPatterns: string[];
  pollInterval: number;
  syncMode: "auto" | "manual";
  onlyOwnPRs: boolean;
  reviewOwnPRs: boolean;
  parallelReviews: number;
  maxReviewVersions: number;
  contextVersions: number;
  cleanupIntervalHours: number;
  cleanupAgeDays: number;
}
