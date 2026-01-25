import fs from "fs";
import path from "path";
import { marked } from "marked";
import { CONFIG } from "../config";
import { logger } from "../logger";
import { isPolling } from "../state";
import { poll, getPendingPRs, syncSelectedPRs } from "../poll";
import { htmlTemplate } from "./template";
import { homePage, pendingPage, repoPage, reviewPage, notFoundPage } from "./pages";
import type { PRMetadata } from "../types";
import type { ReviewItem } from "./pages";

function extractPRMetadata(filePath: string): PRMetadata {
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
    const filePath = path.join(reviewsBaseDir, repoDir, `pr-review-${prNumber}.md`);
    if (!fs.existsSync(filePath)) {
      return Response.json({ success: false, error: "Review not found" }, { status: 404 });
    }
    fs.unlinkSync(filePath);
    logger.info({ repo, prNumber }, "Review deleted");
    return Response.json({ success: true, message: "Review deleted" });
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

  if (!fs.existsSync(repoDir)) {
    return new Response(htmlTemplate("Not Found", notFoundPage(
      `No reviews found for ${repoName.replace("_", "/")}`
    )), {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  }

  const files = fs.readdirSync(repoDir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || "0", 10);
      const numB = parseInt(b.match(/\d+/)?.[0] || "0", 10);
      return numB - numA;
    });

  const reviews: ReviewItem[] = files.map((fileName) => {
    const prNum = fileName.match(/pr-review-(\d+)\.md/)?.[1] || fileName;
    const filePath = path.join(repoDir, fileName);
    const { title, author, lastSynced } = extractPRMetadata(filePath);
    return { fileName, prNum, title, author, lastSynced };
  });

  return new Response(htmlTemplate(repoName.replace("_", "/"), repoPage(repoName, reviews)), {
    headers: { "Content-Type": "text/html" },
  });
}

function handleReviewPage(repoName: string, fileName: string, reviewsBaseDir: string): Response {
  const filePath = path.join(reviewsBaseDir, repoName, fileName);

  if (!fs.existsSync(filePath)) {
    const breadcrumb = `<a href="/">Home</a> / <a href="/repo/${encodeURIComponent(repoName)}">${repoName.replace("_", "/")}</a>`;
    return new Response(htmlTemplate("Not Found", notFoundPage(
      "The requested review file does not exist.",
      breadcrumb
    )), {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  }

  const markdown = fs.readFileSync(filePath, "utf-8");
  const html = marked(markdown);
  const prNum = fileName.match(/pr-review-(\d+)\.md/)?.[1] || fileName;

  return new Response(htmlTemplate(`PR #${prNum}`, reviewPage(repoName, prNum, html)), {
    headers: { "Content-Type": "text/html" },
  });
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

      // Page routes
      if (pathname === "/" || pathname === "") {
        return handleHomePage(reviewsBaseDir);
      }

      if (pathname === "/pending") {
        return handlePendingPage();
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
