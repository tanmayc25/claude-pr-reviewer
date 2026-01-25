import fs from "fs";
import path from "path";
import { marked } from "marked";
import { CONFIG } from "../config";
import { logger } from "../logger";
import { isPolling } from "../state";
import { poll } from "../poll";
import { htmlTemplate } from "./template";
import type { PRMetadata } from "../types";

function extractPRMetadata(filePath: string): PRMetadata {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const titleMatch = content.match(/^# PR Review: (.+)$/m);
    const authorMatch = content.match(/^\*\*Author:\*\* (.+)$/m);
    // Find all review timestamps and get the last one
    const reviewMatches = content.match(/## Review @ (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/g);
    let lastSynced = "unknown";
    if (reviewMatches && reviewMatches.length > 0) {
      const lastMatch = reviewMatches[reviewMatches.length - 1];
      const dateStr = lastMatch.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1];
      if (dateStr) {
        const date = new Date(dateStr);
        lastSynced = date.toLocaleString();
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

export function startWebServer(): void {
  const reviewsBaseDir = path.join(CONFIG.workDir, "reviews");

  Bun.serve({
    port: CONFIG.webPort,
    hostname: "0.0.0.0",
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = decodeURIComponent(url.pathname);

      // API endpoint for manual sync
      if (pathname === "/api/sync" && req.method === "POST") {
        try {
          if (isPolling) {
            return Response.json({ success: false, error: "Sync already in progress" });
          }
          await poll();
          return Response.json({ success: true, message: "Processed PRs" });
        } catch (error) {
          return Response.json({ success: false, error: (error as Error).message });
        }
      }

      // API endpoint for sync status
      if (pathname === "/api/status") {
        return Response.json({
          syncing: isPolling,
          mode: CONFIG.syncMode,
          lastPoll: new Date().toISOString(),
        });
      }

      // Home - list all repos with reviews
      if (pathname === "/" || pathname === "") {
        let repos: string[] = [];
        if (fs.existsSync(reviewsBaseDir)) {
          repos = fs.readdirSync(reviewsBaseDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
        }

        const syncButton = `
          <button id="sync-btn" class="sync-btn">
            <svg class="sync-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c-1.657 0-3-4.03-3-9s1.343-9 3-9m0 18c1.657 0 3-4.03 3-9s-1.343-9-3-9"/>
            </svg>
            Sync PRs
          </button>`;

        const modeLabel = CONFIG.syncMode === "manual" ? "Manual sync mode" : "Auto sync mode";

        const content = repos.length > 0
          ? `<div class="search-container">
              <input type="text" id="search-input" class="search-input" placeholder="Search repositories..." />
            </div>
            <ul class="list">${repos.map((r) =>
              `<li><a href="/repo/${encodeURIComponent(r)}">${r.replace("_", "/")}</a></li>`
            ).join("")}</ul>`
          : `<p class="empty">No reviews yet. Click "Sync PRs" to fetch and review PRs.</p>`;

        return new Response(htmlTemplate("Home", `
          <div class="header">
            <h1>PR Reviews</h1>
            ${syncButton}
          </div>
          <div class="sync-status" id="sync-status">${modeLabel}</div>
          ${content}
        `), {
          headers: { "Content-Type": "text/html" },
        });
      }

      // Repo - list reviews for a repo
      const repoMatch = pathname.match(/^\/repo\/([^/]+)\/?$/);
      if (repoMatch) {
        const repoName = repoMatch[1];
        const repoDir = path.join(reviewsBaseDir, repoName);

        if (!fs.existsSync(repoDir)) {
          return new Response(htmlTemplate("Not Found", `
            <div class="breadcrumb"><a href="/">Home</a></div>
            <h1>Repository Not Found</h1>
            <p class="empty">No reviews found for ${repoName.replace("_", "/")}</p>
          `), {
            status: 404,
            headers: { "Content-Type": "text/html" },
          });
        }

        const reviews = fs.readdirSync(repoDir)
          .filter((f) => f.endsWith(".md"))
          .sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)?.[0] || "0", 10);
            const numB = parseInt(b.match(/\d+/)?.[0] || "0", 10);
            return numB - numA;
          });

        const content = reviews.length > 0
          ? `<div class="search-container">
              <input type="text" id="search-input" class="search-input" placeholder="Search PRs by title, number, or author..." />
            </div>
            <ul class="list">${reviews.map((r) => {
              const prNum = r.match(/pr-review-(\d+)\.md/)?.[1] || r;
              const filePath = path.join(repoDir, r);
              const { title, author, lastSynced } = extractPRMetadata(filePath);
              return `<li><a href="/repo/${encodeURIComponent(repoName)}/${encodeURIComponent(r)}">
                <div class="pr-header"><span class="pr-number">PR #${prNum}</span><span class="pr-title">${title}</span></div>
                <div class="pr-meta"><span class="pr-author">by ${author}</span><span class="pr-synced">synced ${lastSynced}</span></div>
              </a></li>`;
            }).join("")}</ul>`
          : `<p class="empty">No reviews yet for this repository.</p>`;

        return new Response(htmlTemplate(repoName.replace("_", "/"), `
          <div class="breadcrumb"><a href="/">Home</a> / ${repoName.replace("_", "/")}</div>
          <h1>${repoName.replace("_", "/")}</h1>
          ${content}
        `), {
          headers: { "Content-Type": "text/html" },
        });
      }

      // Review file - render markdown
      const reviewMatch = pathname.match(/^\/repo\/([^/]+)\/([^/]+)$/);
      if (reviewMatch) {
        const repoName = reviewMatch[1];
        const fileName = reviewMatch[2];
        const filePath = path.join(reviewsBaseDir, repoName, fileName);

        if (!fs.existsSync(filePath)) {
          return new Response(htmlTemplate("Not Found", `
            <div class="breadcrumb"><a href="/">Home</a> / <a href="/repo/${encodeURIComponent(repoName)}">${repoName.replace("_", "/")}</a></div>
            <h1>Review Not Found</h1>
            <p class="empty">The requested review file does not exist.</p>
          `), {
            status: 404,
            headers: { "Content-Type": "text/html" },
          });
        }

        const markdown = fs.readFileSync(filePath, "utf-8");
        const html = marked(markdown);
        const prNum = fileName.match(/pr-review-(\d+)\.md/)?.[1] || fileName;

        return new Response(htmlTemplate(`PR #${prNum}`, `
          <div class="breadcrumb">
            <a href="/">Home</a> /
            <a href="/repo/${encodeURIComponent(repoName)}">${repoName.replace("_", "/")}</a> /
            PR #${prNum}
          </div>
          <div class="review-content">
            ${html}
          </div>
        `), {
          headers: { "Content-Type": "text/html" },
        });
      }

      // 404
      return new Response(htmlTemplate("Not Found", `
        <div class="breadcrumb"><a href="/">Home</a></div>
        <h1>Page Not Found</h1>
        <p><a href="/">Go back home</a></p>
      `), {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    },
  });

  logger.info({ port: CONFIG.webPort, url: `http://localhost:${CONFIG.webPort}` }, "Review browser started");
}
