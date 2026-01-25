import fs from "fs";
import path from "path";
import { marked } from "marked";
import { CONFIG } from "../config";
import { logger } from "../logger";
import { isPolling } from "../state";
import { poll, getPendingPRs, syncSelectedPRs } from "../poll";
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

      // API endpoint for getting pending PRs
      if (pathname === "/api/prs") {
        try {
          const prs = await getPendingPRs();
          return Response.json({ prs });
        } catch (error) {
          return Response.json({ error: (error as Error).message }, { status: 500 });
        }
      }

      // API endpoint for manual sync
      if (pathname === "/api/sync" && req.method === "POST") {
        try {
          if (isPolling) {
            return Response.json({ success: false, error: "Sync already in progress" });
          }

          const body = await req.json().catch(() => ({}));
          if (body.selectedPRs?.length > 0) {
            const result = await syncSelectedPRs(body.selectedPRs);
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

        const headerButtons = `
          <div class="header-buttons">
            <a href="/pending" class="sync-btn">
              <svg class="sync-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 11l3 3L22 4"/>
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
              Select PRs
            </a>
            <button id="sync-btn" class="sync-btn">
              <svg class="sync-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c-1.657 0-3-4.03-3-9s1.343-9 3-9m0 18c1.657 0 3-4.03 3-9s-1.343-9-3-9"/>
              </svg>
              Sync All
            </button>
          </div>`;

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
            ${headerButtons}
          </div>
          <div class="sync-status" id="sync-status">${modeLabel}</div>
          ${content}
        `), {
          headers: { "Content-Type": "text/html" },
        });
      }

      // Pending PRs selection page
      if (pathname === "/pending") {
        const pendingContent = `
          <div class="breadcrumb"><a href="/">Home</a> / Select PRs</div>
          <div class="header">
            <h1>Select PRs to Sync</h1>
            <button id="sync-selected-btn" class="sync-btn" disabled>
              <svg class="sync-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c-1.657 0-3-4.03-3-9s1.343-9 3-9m0 18c1.657 0 3-4.03 3-9s-1.343-9-3-9"/>
              </svg>
              Sync Selected
            </button>
          </div>
          <div class="sync-status" id="sync-status">Loading PRs...</div>
          <div class="pending-actions" style="display: none;" id="pending-actions">
            <label class="select-all-label">
              <input type="checkbox" id="select-all" />
              Select all
            </label>
            <span class="selection-count" id="selection-count">0 selected</span>
          </div>
          <ul class="pending-list" id="pending-list"></ul>
          <script>
            (async function() {
              const list = document.getElementById('pending-list');
              const status = document.getElementById('sync-status');
              const syncBtn = document.getElementById('sync-selected-btn');
              const selectAll = document.getElementById('select-all');
              const selectionCount = document.getElementById('selection-count');
              const pendingActions = document.getElementById('pending-actions');

              let prs = [];

              function updateSelectionCount() {
                const checked = document.querySelectorAll('.pr-checkbox:checked');
                selectionCount.textContent = checked.length + ' selected';
                syncBtn.disabled = checked.length === 0;
              }

              function renderPRs() {
                if (prs.length === 0) {
                  list.innerHTML = '<li style="justify-content:center;"><span class="empty">No pending PRs found.</span></li>';
                  pendingActions.style.display = 'none';
                  return;
                }

                pendingActions.style.display = 'flex';
                list.innerHTML = prs.map(pr => \`
                  <li>
                    <input type="checkbox" class="pr-checkbox" data-repo="\${pr.repo}" data-number="\${pr.number}" />
                    <div class="pr-info">
                      <div class="pr-header">
                        <span class="pr-number">PR #\${pr.number}</span>
                        <span class="pr-title">\${pr.title}</span>
                        \${pr.hasChanges ? '<span class="has-changes">New/Updated</span>' : '<span class="no-changes">No changes</span>'}
                      </div>
                      <div class="pr-meta">
                        <span class="pr-repo">\${pr.repo}</span>
                        <span class="pr-author">by \${pr.author}</span>
                      </div>
                    </div>
                  </li>
                \`).join('');

                document.querySelectorAll('.pr-checkbox').forEach(cb => {
                  cb.addEventListener('change', updateSelectionCount);
                });
              }

              try {
                const res = await fetch('/api/prs');
                const data = await res.json();
                prs = data.prs || [];
                status.textContent = prs.length + ' PR(s) found';
                renderPRs();
              } catch (err) {
                status.textContent = 'Error loading PRs: ' + err.message;
              }

              selectAll.addEventListener('change', function() {
                document.querySelectorAll('.pr-checkbox').forEach(cb => {
                  cb.checked = selectAll.checked;
                });
                updateSelectionCount();
              });

              syncBtn.addEventListener('click', async function() {
                const selected = Array.from(document.querySelectorAll('.pr-checkbox:checked')).map(cb => ({
                  repo: cb.dataset.repo,
                  number: parseInt(cb.dataset.number, 10)
                }));

                if (selected.length === 0) return;

                syncBtn.disabled = true;
                syncBtn.classList.add('syncing');
                status.textContent = 'Syncing ' + selected.length + ' PR(s)...';

                try {
                  const res = await fetch('/api/sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selectedPRs: selected })
                  });
                  const data = await res.json();
                  if (data.success) {
                    status.textContent = 'Sync complete: ' + data.message;
                    setTimeout(() => location.href = '/', 1500);
                  } else {
                    status.textContent = 'Sync failed: ' + (data.error || 'Unknown error');
                    syncBtn.disabled = false;
                    syncBtn.classList.remove('syncing');
                  }
                } catch (err) {
                  status.textContent = 'Sync failed: ' + err.message;
                  syncBtn.disabled = false;
                  syncBtn.classList.remove('syncing');
                }
              });
            })();
          </script>
        `;

        return new Response(htmlTemplate("Select PRs", pendingContent), {
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
