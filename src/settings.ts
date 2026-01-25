import fs from "fs";
import path from "path";
import type { EditableSettings } from "./types";

// Defaults from environment variables
export const envDefaultConfig: EditableSettings = {
  githubUsername: process.env.GITHUB_USERNAME || "",
  repoPatterns: process.env.REPOS
    ? process.env.REPOS.split(",").map((s) => s.trim()).filter(Boolean)
    : [],
  pollInterval: parseInt(process.env.POLL_INTERVAL || "60", 10),
  syncMode: (process.env.SYNC_MODE || "auto") as "auto" | "manual",
  onlyOwnPRs: process.env.ONLY_OWN_PRS === "true",
  reviewOwnPRs: process.env.REVIEW_OWN_PRS === "true",
  parallelReviews: parseInt(process.env.PARALLEL_REVIEWS || "3", 10),
  maxReviewVersions: parseInt(process.env.MAX_REVIEW_VERSIONS || "10", 10),
  contextVersions: parseInt(process.env.CONTEXT_VERSIONS || "2", 10),
  cleanupIntervalHours: parseInt(process.env.CLEANUP_INTERVAL_HOURS || "24", 10),
  cleanupAgeDays: parseInt(process.env.CLEANUP_AGE_DAYS || "7", 10),
};

// Mutable config that can be updated at runtime
export const editableConfig: EditableSettings = { ...envDefaultConfig };

// Static config values that require restart
export const staticConfig = {
  webPort: parseInt(process.env.WEB_PORT || "3456", 10),
  workDir: process.env.WORK_DIR || path.join(import.meta.dir, ".."),
};

// Settings file path
function getSettingsFilePath(): string {
  return path.join(staticConfig.workDir, ".pr-settings.json");
}

// Validation errors
export interface ValidationError {
  field: string;
  message: string;
}

// Validate settings before saving
export function validateSettings(settings: Partial<EditableSettings>): ValidationError[] {
  const errors: ValidationError[] = [];

  if (settings.pollInterval !== undefined) {
    if (typeof settings.pollInterval !== "number" || settings.pollInterval < 10) {
      errors.push({ field: "pollInterval", message: "Poll interval must be at least 10 seconds" });
    }
    if (settings.pollInterval > 3600) {
      errors.push({ field: "pollInterval", message: "Poll interval cannot exceed 3600 seconds" });
    }
  }

  if (settings.parallelReviews !== undefined) {
    if (typeof settings.parallelReviews !== "number" || settings.parallelReviews < 1) {
      errors.push({ field: "parallelReviews", message: "Parallel reviews must be at least 1" });
    }
    if (settings.parallelReviews > 10) {
      errors.push({ field: "parallelReviews", message: "Parallel reviews cannot exceed 10" });
    }
  }

  if (settings.maxReviewVersions !== undefined) {
    if (typeof settings.maxReviewVersions !== "number" || settings.maxReviewVersions < 1) {
      errors.push({ field: "maxReviewVersions", message: "Max review versions must be at least 1" });
    }
    if (settings.maxReviewVersions > 100) {
      errors.push({ field: "maxReviewVersions", message: "Max review versions cannot exceed 100" });
    }
  }

  if (settings.contextVersions !== undefined) {
    if (typeof settings.contextVersions !== "number" || settings.contextVersions < 0) {
      errors.push({ field: "contextVersions", message: "Context versions cannot be negative" });
    }
    if (settings.contextVersions > 10) {
      errors.push({ field: "contextVersions", message: "Context versions cannot exceed 10" });
    }
  }

  if (settings.cleanupIntervalHours !== undefined) {
    if (typeof settings.cleanupIntervalHours !== "number" || settings.cleanupIntervalHours < 1) {
      errors.push({ field: "cleanupIntervalHours", message: "Cleanup interval must be at least 1 hour" });
    }
  }

  if (settings.cleanupAgeDays !== undefined) {
    if (typeof settings.cleanupAgeDays !== "number" || settings.cleanupAgeDays < 1) {
      errors.push({ field: "cleanupAgeDays", message: "Cleanup age must be at least 1 day" });
    }
  }

  if (settings.syncMode !== undefined) {
    if (settings.syncMode !== "auto" && settings.syncMode !== "manual") {
      errors.push({ field: "syncMode", message: "Sync mode must be 'auto' or 'manual'" });
    }
  }

  if (settings.repoPatterns !== undefined) {
    if (!Array.isArray(settings.repoPatterns)) {
      errors.push({ field: "repoPatterns", message: "Repo patterns must be an array" });
    } else {
      // Validate regex patterns
      for (const pattern of settings.repoPatterns) {
        if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
          try {
            new RegExp(pattern.slice(1, -1));
          } catch {
            errors.push({ field: "repoPatterns", message: `Invalid regex pattern: ${pattern}` });
          }
        }
      }
    }
  }

  return errors;
}

// Load settings from file, merging with env defaults
export function loadSettings(): void {
  const filePath = getSettingsFilePath();

  if (!fs.existsSync(filePath)) {
    // No settings file, use env defaults
    Object.assign(editableConfig, envDefaultConfig);
    return;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const saved = JSON.parse(content) as Partial<EditableSettings>;

    // Start with env defaults and override with saved settings
    Object.assign(editableConfig, envDefaultConfig);

    // Apply saved settings (only valid keys)
    const validKeys: (keyof EditableSettings)[] = [
      "githubUsername",
      "repoPatterns",
      "pollInterval",
      "syncMode",
      "onlyOwnPRs",
      "reviewOwnPRs",
      "parallelReviews",
      "maxReviewVersions",
      "contextVersions",
      "cleanupIntervalHours",
      "cleanupAgeDays",
    ];

    for (const key of validKeys) {
      if (saved[key] !== undefined) {
        (editableConfig as Record<string, unknown>)[key] = saved[key];
      }
    }
  } catch {
    // If file is corrupted, use env defaults
    Object.assign(editableConfig, envDefaultConfig);
  }
}

// Save current settings to file
export function saveSettings(): void {
  const filePath = getSettingsFilePath();
  const content = JSON.stringify(editableConfig, null, 2);
  fs.writeFileSync(filePath, content, "utf-8");
}

// Update settings with partial values
export function updateSettings(updates: Partial<EditableSettings>): ValidationError[] {
  const errors = validateSettings(updates);
  if (errors.length > 0) {
    return errors;
  }

  // Apply updates
  Object.assign(editableConfig, updates);

  // Persist to file
  saveSettings();

  return [];
}

// Reset to env defaults
export function resetSettings(): void {
  Object.assign(editableConfig, envDefaultConfig);
  saveSettings();
}

// Initialize settings on module load
loadSettings();
