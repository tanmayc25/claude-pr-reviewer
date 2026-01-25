import fs from "fs";
import path from "path";
import { marked } from "marked";
import { CONFIG } from "../config";
import { logger } from "../logger";
import { isPolling } from "../state";
import { poll, getPendingPRs, syncSelectedPRs } from "../poll";
import { htmlTemplate } from "./template";
import { homePage, pendingPage, repoPage, reviewPageWithVersions, notFoundPage, settingsPage } from "./pages";
import { getPRReviewDir, getPRMeta, listVersions, readVersion, migrateOldFormat } from "../review";
import { editableConfig, envDefaultConfig, staticConfig, updateSettings, resetSettings, validateSettings } from "../settings";
import { reloadRepoPatterns } from "../github";
import type { PRMetadata, PRReviewMeta, EditableSettings } from "../types";
import type { ReviewItem, VersionTab } from "./pages";

function extractPRMetadataFromMeta(meta: PRReviewMeta, versions: { timestamp: string }[]): PRMetadata {
  let lastSynced = "unknown";
  if (versions.length > 0) {
    lastSynced = new Date(versions[0].timestamp).toLocaleString();
  }
  return {
    title: meta.title,
    author: meta.author,
    lastSynced,
  };
}

function extractPRMetadataFromOldFile(filePath: string): PRMetadata {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const titleMatch = content.match(/^# PR Review: (.+)$/m);
    const authorMatch = content.match(/^\*\*Author:\*\* (.+)$/m);
    const reviewMatches = content.match(/## Review @ (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/g);
    let lastSynced = "unknown";
    if (reviewMatches && reviewMatches.length > 0) {
      const lastMatch = reviewMatches[reviewMatches.length - 1];
      const dateStr = lastMatch.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1];
      if (dateStr) {
        lastSynced = new Date(dateStr).toLocaleString();
      }
    }
    return {
      title: titleMatch?.[1] || "Untitled",
      author: authorMatch?.[1] || "unknown",
      lastSynced,
    };
  } catch {
    return { title: "Untitled", author: "unknown", lastSynced: "unknown" };
  }
}

// API handlers
async function handleGetPRs(): Promise<Response> {
  try {
    const prs = await getPendingPRs();
    return Response.json({ prs });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

async function handleSync(req: Request): Promise<Response> {
  try {
    if (isPolling) {
      return Response.json({ success: false, error: "Sync already in progress" });
    }

    const body = await req.json().catch(() => ({}));
    if (body.selectedPRs?.length > 0) {
      const result = await syncSelectedPRs(body.selectedPRs, body.customPrompt, body.forceReview);
      return Response.json({
        success: true,
        message: `Processed ${result.processed} PR(s)${result.errors > 0 ? `, ${result.errors} error(s)` : ""}`,
      });
    } else {
      await poll();
      return Response.json({ success: true, message: "Processed PRs" });
    }
  } catch (error) {
    return Response.json({ success: false, error: (error as Error).message });
  }
}

async function handleDeleteReview(req: Request, reviewsBaseDir: string): Promise<Response> {
  try {
    const body = await req.json();
    const { repo, prNumber } = body;
    if (!repo || !prNumber) {
      return Response.json({ success: false, error: "Missing repo or prNumber" }, { status: 400 });
    }

    const repoDir = repo.replace("/", "_");

    // Check for new versioned directory format first
    const prReviewDir = path.join(reviewsBaseDir, repoDir, `pr-${prNumber}`);
    if (fs.existsSync(prReviewDir)) {
      fs.rmSync(prReviewDir, { recursive: true, force: true });
      logger.info({ repo, prNumber }, "Review directory deleted");
      return Response.json({ success: true, message: "Review deleted" });
    }

    // Fall back to old file format
    const oldFilePath = path.join(reviewsBaseDir, repoDir, `pr-review-${prNumber}.md`);
    if (fs.existsSync(oldFilePath)) {
      fs.unlinkSync(oldFilePath);
      logger.info({ repo, prNumber }, "Review file deleted (old format)");
      return Response.json({ success: true, message: "Review deleted" });
    }

    return Response.json({ success: false, error: "Review not found" }, { status: 404 });
  } catch (error) {
    return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

async function handleReReview(req: Request): Promise<Response> {
  try {
    if (isPolling) {
      return Response.json({ success: false, error: "Sync already in progress" });
    }
    const body = await req.json();
    const { repo, prNumber, customPrompt } = body;
    if (!repo || !prNumber) {
      return Response.json({ success: false, error: "Missing repo or prNumber" }, { status: 400 });
    }
    const result = await syncSelectedPRs([{ repo, number: prNumber }], customPrompt, true);
    return Response.json({
      success: true,
      message: result.processed > 0 ? "Re-review complete" : "No changes processed",
    });
  } catch (error) {
    return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

function handleStatus(): Response {
  return Response.json({
    syncing: isPolling,
    mode: CONFIG.syncMode,
    lastPoll: new Date().toISOString(),
  });
}

// Settings API handlers
function handleGetSettings(): Response {
  return Response.json({
    settings: { ...editableConfig },
    defaults: { ...envDefaultConfig },
    restartRequired: {
      webPort: staticConfig.webPort,
      workDir: staticConfig.workDir,
    },
  });
}

async function handleUpdateSettings(req: Request): Promise<Response> {
  try {
    const updates = await req.json() as Partial<EditableSettings>;
    const errors = updateSettings(updates);

    if (errors.length > 0) {
      return Response.json({ success: false, errors }, { status: 400 });
    }

    // Reload repo patterns if they changed
    if (updates.repoPatterns !== undefined) {
      reloadRepoPatterns();
    }

    logger.info({ updates }, "Settings updated");
    return Response.json({ success: true, settings: { ...editableConfig } });
  } catch (error) {
    return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

function handleResetSettings(): Response {
  resetSettings();
  reloadRepoPatterns();
  logger.info("Settings reset to defaults");
  return Response.json({ success: true, settings: { ...editableConfig } });
}

function handleSettingsPage(): Response {
  return new Response(htmlTemplate("Settings", settingsPage()), {
    headers: { "Content-Type": "text/html" },
  });
}

// Page handlers
function handleHomePage(reviewsBaseDir: string): Response {
  let repos: string[] = [];
  if (fs.existsSync(reviewsBaseDir)) {
    repos = fs.readdirSync(reviewsBaseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }
  return new Response(htmlTemplate("Home", homePage(repos, CONFIG.syncMode)), {
    headers: { "Content-Type": "text/html" },
  });
}

function handlePendingPage(): Response {
  return new Response(htmlTemplate("Select PRs", pendingPage()), {
    headers: { "Content-Type": "text/html" },
  });
}

function handleRepoPage(repoName: string, reviewsBaseDir: string): Response {
  const repoDir = path.join(reviewsBaseDir, repoName);
  const repoFullName = repoName.replace("_", "/");

  if (!fs.existsSync(repoDir)) {
    return new Response(htmlTemplate("Not Found", notFoundPage(
      `No reviews found for ${repoFullName}`
    )), {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  }

  const reviews: ReviewItem[] = [];

  // Get entries in repo directory
  const entries = fs.readdirSync(repoDir, { withFileTypes: true });

  // Process new versioned directories (pr-{number})
  const prDirs = entries
    .filter((d) => d.isDirectory() && d.name.startsWith("pr-"))
    .sort((a, b) => {
      const numA = parseInt(a.name.match(/\d+/)?.[0] || "0", 10);
      const numB = parseInt(b.name.match(/\d+/)?.[0] || "0", 10);
      return numB - numA;
    });

  for (const prDir of prDirs) {
    const prNum = prDir.name.replace("pr-", "");
    const prReviewDir = path.join(repoDir, prDir.name);
    const meta = getPRMeta(prReviewDir);
    const versions = listVersions(prReviewDir);

    if (meta) {
      const { title, author, lastSynced } = extractPRMetadataFromMeta(meta, versions);
      reviews.push({
        fileName: prDir.name, // Use directory name
        prNum,
        title,
        author,
        lastSynced,
        isVersioned: true,
      });
    }
  }

  // Process old format files (pr-review-{number}.md)
  const oldFiles = entries
    .filter((f) => f.isFile() && f.name.endsWith(".md") && f.name.startsWith("pr-review-"))
    .sort((a, b) => {
      const numA = parseInt(a.name.match(/\d+/)?.[0] || "0", 10);
      const numB = parseInt(b.name.match(/\d+/)?.[0] || "0", 10);
      return numB - numA;
    });

  for (const file of oldFiles) {
    const prNum = file.name.match(/pr-review-(\d+)\.md/)?.[1] || file.name;
    const filePath = path.join(repoDir, file.name);
    const { title, author, lastSynced } = extractPRMetadataFromOldFile(filePath);
    reviews.push({
      fileName: file.name,
      prNum,
      title,
      author,
      lastSynced,
      isVersioned: false,
    });
  }

  // Sort all reviews by PR number (highest first)
  reviews.sort((a, b) => parseInt(b.prNum, 10) - parseInt(a.prNum, 10));

  return new Response(htmlTemplate(repoFullName, repoPage(repoName, reviews)), {
    headers: { "Content-Type": "text/html" },
  });
}

function handleReviewPage(repoName: string, identifier: string, reviewsBaseDir: string): Response {
  const repoFullName = repoName.replace("_", "/");
  const breadcrumb = `<a href="/">Home</a> / <a href="/repo/${encodeURIComponent(repoName)}">${repoFullName}</a>`;

  // Check if identifier is a versioned directory (pr-{number}) or old file (pr-review-{number}.md)
  const isVersionedDir = identifier.startsWith("pr-") && !identifier.endsWith(".md");

  if (isVersionedDir) {
    const prNum = identifier.replace("pr-", "");
    const prReviewDir = path.join(reviewsBaseDir, repoName, identifier);

    if (!fs.existsSync(prReviewDir)) {
      return new Response(htmlTemplate("Not Found", notFoundPage(
        "The requested review does not exist.",
        breadcrumb
      )), {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    }

    const meta = getPRMeta(prReviewDir);
    const versions = listVersions(prReviewDir);

    if (versions.length === 0) {
      return new Response(htmlTemplate("Not Found", notFoundPage(
        "No review versions found for this PR.",
        breadcrumb
      )), {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    }

    // Build version tabs
    const versionTabs: VersionTab[] = versions.map((v, index) => {
      const content = readVersion(prReviewDir, v.filename);
      const html = marked(content) as string;
      const date = new Date(v.timestamp);
      const dateStr = date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

      return {
        label: index === 0 ? `v${versions.length} (Latest)` : `v${versions.length - index}`,
        timestamp: v.timestamp,
        commitSha: v.commitSha,
        dateStr,
        html,
        isLatest: index === 0,
      };
    });

    return new Response(
      htmlTemplate(`PR #${prNum}`, reviewPageWithVersions(repoName, prNum, meta, versionTabs)),
      { headers: { "Content-Type": "text/html" } }
    );
  }

  // Old format file handling
  const filePath = path.join(reviewsBaseDir, repoName, identifier);

  if (!fs.existsSync(filePath)) {
    // Try to migrate on access
    const prNumMatch = identifier.match(/pr-review-(\d+)\.md/);
    if (prNumMatch) {
      const prNum = parseInt(prNumMatch[1], 10);
      migrateOldFormat(repoFullName, prNum);

      // Check if migration created the directory
      const prReviewDir = path.join(reviewsBaseDir, repoName, `pr-${prNum}`);
      if (fs.existsSync(prReviewDir)) {
        // Redirect to versioned URL
        return Response.redirect(`/repo/${encodeURIComponent(repoName)}/pr-${prNum}`, 302);
      }
    }

    return new Response(htmlTemplate("Not Found", notFoundPage(
      "The requested review file does not exist.",
      breadcrumb
    )), {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  }

  // For old format, trigger migration and redirect
  const prNumMatch = identifier.match(/pr-review-(\d+)\.md/);
  if (prNumMatch) {
    const prNum = parseInt(prNumMatch[1], 10);
    migrateOldFormat(repoFullName, prNum);

    const prReviewDir = path.join(reviewsBaseDir, repoName, `pr-${prNum}`);
    if (fs.existsSync(prReviewDir)) {
      return Response.redirect(`/repo/${encodeURIComponent(repoName)}/pr-${prNum}`, 302);
    }
  }

  // If migration didn't work, show the old file content as single version
  const markdown = fs.readFileSync(filePath, "utf-8");
  const html = marked(markdown) as string;
  const prNum = identifier.match(/pr-review-(\d+)\.md/)?.[1] || identifier;

  const singleVersionTab: VersionTab = {
    label: "v1 (Latest)",
    timestamp: new Date().toISOString(),
    commitSha: "unknown",
    dateStr: "Unknown",
    html,
    isLatest: true,
  };

  return new Response(
    htmlTemplate(`PR #${prNum}`, reviewPageWithVersions(repoName, prNum, null, [singleVersionTab])),
    { headers: { "Content-Type": "text/html" } }
  );
}

export function startWebServer(): void {
  const reviewsBaseDir = path.join(CONFIG.workDir, "reviews");

  Bun.serve({
    port: CONFIG.webPort,
    hostname: "0.0.0.0",
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = decodeURIComponent(url.pathname);

      // API routes
      if (pathname === "/api/prs") {
        return handleGetPRs();
      }

      if (pathname === "/api/sync" && req.method === "POST") {
        return handleSync(req);
      }

      if (pathname === "/api/review" && req.method === "DELETE") {
        return handleDeleteReview(req, reviewsBaseDir);
      }

      if (pathname === "/api/re-review" && req.method === "POST") {
        return handleReReview(req);
      }

      if (pathname === "/api/status") {
        return handleStatus();
      }

      // Settings API routes
      if (pathname === "/api/settings" && req.method === "GET") {
        return handleGetSettings();
      }

      if (pathname === "/api/settings" && req.method === "POST") {
        return handleUpdateSettings(req);
      }

      if (pathname === "/api/settings/reset" && req.method === "POST") {
        return handleResetSettings();
      }

      // Page routes
      if (pathname === "/" || pathname === "") {
        return handleHomePage(reviewsBaseDir);
      }

      if (pathname === "/pending") {
        return handlePendingPage();
      }

      if (pathname === "/settings") {
        return handleSettingsPage();
      }

      const repoMatch = pathname.match(/^\/repo\/([^/]+)\/?$/);
      if (repoMatch) {
        return handleRepoPage(repoMatch[1], reviewsBaseDir);
      }

      const reviewMatch = pathname.match(/^\/repo\/([^/]+)\/([^/]+)$/);
      if (reviewMatch) {
        return handleReviewPage(reviewMatch[1], reviewMatch[2], reviewsBaseDir);
      }

      // 404
      return new Response(htmlTemplate("Not Found", notFoundPage(
        '<a href="/">Go back home</a>'
      )), {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  logger.info({ port: CONFIG.webPort, url: `http://localhost:${CONFIG.webPort}` }, "Review browser started");
}
