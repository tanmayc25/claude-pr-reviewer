import { execSync, exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import { logger } from "./logger";
import { CONFIG } from "./config";

export const execAsync = promisify(exec);

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function ghCommand(args: string, options: { cwd?: string; ignoreError?: boolean } = {}): string | null {
  try {
    return execSync(`gh ${args}`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    if (!options.ignoreError) {
      logger.error({ command: `gh ${args}`, error: (e as Error).message }, "gh command failed");
    }
    return null;
  }
}

export async function ghCommandAsync(args: string, options: { cwd?: string; ignoreError?: boolean } = {}): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`gh ${args}`, {
      cwd: options.cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (e) {
    if (!options.ignoreError) {
      logger.error({ command: `gh ${args}`, error: (e as Error).message }, "gh command failed");
    }
    return null;
  }
}

export function safeJsonParse<T>(str: string | null, fallback: T | null = null): T | null {
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch (e) {
    logger.warn({ error: (e as Error).message }, "JSON parse failed");
    return fallback;
  }
}

// Extract author login from PR object (handles both object and string forms)
export function getAuthorLogin(author: unknown): string {
  if (typeof author === "object" && author !== null) {
    return (author as { login?: string }).login || "unknown";
  }
  return typeof author === "string" ? author : "unknown";
}

// Check if PR should be processed based on config filtering rules
export function shouldProcessPR(authorLogin: string): boolean {
  const isOwnPR = CONFIG.githubUsername && authorLogin === CONFIG.githubUsername;
  if (CONFIG.onlyOwnPRs && !isOwnPR) return false;
  if (!CONFIG.onlyOwnPRs && !CONFIG.reviewOwnPRs && isOwnPR) return false;
  return true;
}
