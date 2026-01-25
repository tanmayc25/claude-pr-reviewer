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
