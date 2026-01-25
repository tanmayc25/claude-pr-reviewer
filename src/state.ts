import fs from "fs";
import path from "path";
import { logger } from "./logger";

const STATE_FILE = path.join(import.meta.dir, "..", ".pr-state.json");

export const prState = new Map<string, string>();

// Polling lock to prevent concurrent polls
export let isPolling = false;

export function setPolling(value: boolean): void {
  isPolling = value;
}

export function loadState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      Object.entries(data).forEach(([k, v]) => prState.set(k, v as string));
      logger.info({ count: prState.size }, "Loaded PR state");
    }
  } catch (e) {
    logger.error({ error: (e as Error).message }, "Could not load state");
  }
}

export function saveState(): void {
  try {
    const data = Object.fromEntries(prState);
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.error({ error: (e as Error).message }, "Could not save state");
  }
}
