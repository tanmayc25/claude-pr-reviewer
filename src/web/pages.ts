import { icons } from "./icons";
import type { PRReviewMeta } from "../types";

export interface ReviewItem {
  fileName: string;
  prNum: string;
  title: string;
  author: string;
  lastSynced: string;
  isVersioned?: boolean;
}

export interface VersionTab {
  label: string;
  timestamp: string;
  commitSha: string;
  dateStr: string;
  html: string;
  isLatest: boolean;
}

export function homePage(repos: string[], syncMode: string): string {
  const modeLabel = syncMode === "manual" ? "Manual sync mode" : "Auto sync mode";

  const headerButtons = `
    <div class="header-buttons">
      <a href="/settings" class="sync-btn">
        ${icons.settings}
        Settings
      </a>
      <a href="/pending" class="sync-btn">
        ${icons.checkbox}
        Select PRs
      </a>
      <button id="sync-btn" class="sync-btn">
        ${icons.sync}
        Sync All
      </button>
    </div>`;

  const content = repos.length > 0
    ? `<div class="search-container">
        <input type="text" id="search-input" class="search-input" placeholder="Search repositories..." />
      </div>
      <ul class="list">${repos.map((r) =>
        `<li><a href="/repo/${encodeURIComponent(r)}">${r.replace("_", "/")}</a></li>`
      ).join("")}</ul>`
    : `<p class="empty">No reviews yet. Click "Sync PRs" to fetch and review PRs.</p>`;

  return `
    <div class="header">
      <h1>PR Reviews</h1>
      ${headerButtons}
    </div>
    <div class="sync-status" id="sync-status">${modeLabel}</div>
    ${content}
  `;
}

export function pendingPage(): string {
  return `
    <div class="breadcrumb"><a href="/">Home</a> / Select PRs</div>
    <div class="header">
      <h1>Select PRs to Sync</h1>
      <button id="sync-selected-btn" class="sync-btn" disabled>
        ${icons.sync}
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
    <div class="custom-prompt-container" id="custom-prompt-container" style="display: none;">
      <label for="custom-prompt" class="custom-prompt-label">Custom Instructions (optional)</label>
      <textarea id="custom-prompt" class="custom-prompt-input" rows="3" placeholder="e.g., Focus on security issues, Check for memory leaks, Review error handling..."></textarea>
      <label class="force-review-label">
        <input type="checkbox" id="force-review" />
        Force re-review (ignore previous review state)
      </label>
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
        const customPromptContainer = document.getElementById('custom-prompt-container');
        const customPromptInput = document.getElementById('custom-prompt');
        const forceReviewCheckbox = document.getElementById('force-review');

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
            customPromptContainer.style.display = 'none';
            return;
          }

          pendingActions.style.display = 'flex';
          customPromptContainer.style.display = 'block';
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
            const customPrompt = customPromptInput.value.trim() || undefined;
            const forceReview = forceReviewCheckbox.checked;
            const res = await fetch('/api/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ selectedPRs: selected, customPrompt, forceReview })
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
}

export function repoPage(repoName: string, reviews: ReviewItem[]): string {
  const repoFullName = repoName.replace("_", "/");

  const content = reviews.length > 0
    ? `<div class="search-container">
        <input type="text" id="search-input" class="search-input" placeholder="Search PRs by title, number, or author..." />
      </div>
      <ul class="list">${reviews.map((r) => `
        <li class="pr-item" data-repo="${repoFullName}" data-pr="${r.prNum}">
          <a href="/repo/${encodeURIComponent(repoName)}/${encodeURIComponent(r.fileName)}" class="pr-link">
            <div class="pr-header"><span class="pr-number">PR #${r.prNum}</span><span class="pr-title">${r.title}</span></div>
            <div class="pr-meta"><span class="pr-author">by ${r.author}</span><span class="pr-synced">synced ${r.lastSynced}</span></div>
          </a>
          <div class="pr-actions">
            <button class="action-btn re-review-btn" title="Re-review with custom prompt">
              ${icons.refresh}
              Re-review
            </button>
            <button class="action-btn delete-btn" title="Delete review">
              ${icons.trash}
              Delete
            </button>
          </div>
        </li>
      `).join("")}</ul>
      ${repoPageModal()}
      ${repoPageScript()}`
    : `<p class="empty">No reviews yet for this repository.</p>`;

  return `
    <div class="breadcrumb"><a href="/">Home</a> / ${repoFullName}</div>
    <h1>${repoFullName}</h1>
    ${content}
  `;
}

function repoPageModal(): string {
  return `
    <div id="modal-overlay" class="modal-overlay hidden">
      <div class="modal">
        <h3 id="modal-title">Re-review PR</h3>
        <label for="modal-prompt" class="custom-prompt-label">Custom Instructions (optional)</label>
        <textarea id="modal-prompt" class="custom-prompt-input" rows="3" placeholder="e.g., Focus on security issues..."></textarea>
        <div class="modal-actions">
          <button id="modal-cancel" class="action-btn">Cancel</button>
          <button id="modal-confirm" class="sync-btn">Start Review</button>
        </div>
        <div id="modal-status" class="sync-status"></div>
      </div>
    </div>
  `;
}

function repoPageScript(): string {
  return `
    <script>
      (function() {
        const modal = document.getElementById('modal-overlay');
        const modalTitle = document.getElementById('modal-title');
        const modalPrompt = document.getElementById('modal-prompt');
        const modalCancel = document.getElementById('modal-cancel');
        const modalConfirm = document.getElementById('modal-confirm');
        const modalStatus = document.getElementById('modal-status');
        let currentPR = null;

        // Re-review buttons
        document.querySelectorAll('.re-review-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const li = btn.closest('.pr-item');
            currentPR = { repo: li.dataset.repo, prNumber: parseInt(li.dataset.pr, 10) };
            modalTitle.textContent = 'Re-review PR #' + currentPR.prNumber;
            modalPrompt.value = '';
            modalStatus.textContent = '';
            modal.classList.remove('hidden');
          });
        });

        // Delete buttons
        document.querySelectorAll('.delete-btn').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const li = btn.closest('.pr-item');
            const repo = li.dataset.repo;
            const prNumber = parseInt(li.dataset.pr, 10);
            if (!confirm('Delete review for PR #' + prNumber + '?')) return;

            try {
              const res = await fetch('/api/review', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ repo, prNumber })
              });
              const data = await res.json();
              if (data.success) {
                li.remove();
              } else {
                alert('Delete failed: ' + (data.error || 'Unknown error'));
              }
            } catch (err) {
              alert('Delete failed: ' + err.message);
            }
          });
        });

        // Modal cancel
        modalCancel.addEventListener('click', () => {
          modal.classList.add('hidden');
          currentPR = null;
        });

        // Modal confirm (re-review)
        modalConfirm.addEventListener('click', async () => {
          if (!currentPR) return;
          modalConfirm.disabled = true;
          modalConfirm.classList.add('syncing');
          modalStatus.textContent = 'Starting re-review...';

          try {
            const res = await fetch('/api/re-review', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                repo: currentPR.repo,
                prNumber: currentPR.prNumber,
                customPrompt: modalPrompt.value.trim() || undefined
              })
            });
            const data = await res.json();
            if (data.success) {
              modalStatus.textContent = data.message;
              setTimeout(() => location.reload(), 1500);
            } else {
              modalStatus.textContent = 'Failed: ' + (data.error || 'Unknown error');
              modalConfirm.disabled = false;
              modalConfirm.classList.remove('syncing');
            }
          } catch (err) {
            modalStatus.textContent = 'Failed: ' + err.message;
            modalConfirm.disabled = false;
            modalConfirm.classList.remove('syncing');
          }
        });

        // Close modal on overlay click
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            modal.classList.add('hidden');
            currentPR = null;
          }
        });
      })();
    </script>
  `;
}

export function reviewPageWithVersions(
  repoName: string,
  prNum: string,
  meta: PRReviewMeta | null,
  versions: VersionTab[]
): string {
  const repoFullName = repoName.replace("_", "/");
  const title = meta?.title || `PR #${prNum}`;
  const prUrl = meta?.url || `https://github.com/${repoFullName}/pull/${prNum}`;

  // Build tabs HTML
  const tabsHtml = versions.map((v, index) => `
    <button class="version-tab${v.isLatest ? " active" : ""}" data-index="${index}">
      ${v.label}
    </button>
  `).join("");

  // Build version contents HTML
  const contentsHtml = versions.map((v, index) => `
    <div class="version-content${v.isLatest ? " active" : ""}" data-index="${index}">
      <div class="version-header">
        <span class="version-commit">Commit: <code>${v.commitSha}</code></span>
        <span class="version-date">${v.dateStr}</span>
      </div>
      <div class="review-content">
        ${v.html}
      </div>
    </div>
  `).join("");

  const versionScript = `
    <script>
      (function() {
        const tabs = document.querySelectorAll('.version-tab');
        const contents = document.querySelectorAll('.version-content');

        tabs.forEach(tab => {
          tab.addEventListener('click', () => {
            const index = tab.dataset.index;

            // Update tab states
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Update content visibility
            contents.forEach(c => c.classList.remove('active'));
            document.querySelector('.version-content[data-index="' + index + '"]').classList.add('active');
          });
        });
      })();
    </script>
  `;

  return `
    <div class="breadcrumb">
      <a href="/">Home</a> /
      <a href="/repo/${encodeURIComponent(repoName)}">${repoFullName}</a> /
      PR #${prNum}
    </div>
    <div class="review-header">
      <h1>${title}</h1>
      <a href="${prUrl}" target="_blank" class="pr-link-external">View on GitHub</a>
    </div>
    ${versions.length > 1 ? `
    <div class="version-tabs">
      ${tabsHtml}
    </div>
    ` : ""}
    <div class="version-contents">
      ${contentsHtml}
    </div>
    ${versions.length > 1 ? versionScript : ""}
  `;
}

export function notFoundPage(message: string, breadcrumb?: string): string {
  const breadcrumbHtml = breadcrumb || `<a href="/">Home</a>`;
  return `
    <div class="breadcrumb">${breadcrumbHtml}</div>
    <h1>Not Found</h1>
    <p class="empty">${message}</p>
  `;
}

export function settingsPage(): string {
  return `
    <div class="breadcrumb"><a href="/">Home</a> / Settings</div>
    <div class="header">
      <h1>Settings</h1>
      <div class="header-buttons">
        <button id="reset-btn" class="btn">Reset to Defaults</button>
        <button id="save-btn" class="sync-btn">
          ${icons.sync}
          Save Settings
        </button>
      </div>
    </div>
    <div class="sync-status" id="settings-status">Loading settings...</div>

    <form id="settings-form" class="settings-form">
      <!-- GitHub Section -->
      <div class="settings-section">
        <h3 class="settings-section-title">GitHub</h3>
        <div class="form-group">
          <label for="githubUsername">Username</label>
          <input type="text" id="githubUsername" name="githubUsername" class="input-field" placeholder="your-username" />
          <span class="form-help">Your GitHub username for filtering PRs</span>
        </div>
        <div class="form-group">
          <label for="repoPatterns">Repository Patterns</label>
          <input type="text" id="repoPatterns" name="repoPatterns" class="input-field" placeholder="owner/repo, /regex-pattern/" />
          <span class="form-help">Comma-separated list. Use /pattern/ for regex. Leave empty to monitor all PRs.</span>
        </div>
      </div>

      <!-- Sync Section -->
      <div class="settings-section">
        <h3 class="settings-section-title">Sync</h3>
        <div class="form-row">
          <div class="form-group">
            <label for="syncMode">Mode</label>
            <select id="syncMode" name="syncMode" class="input-field">
              <option value="auto">Auto</option>
              <option value="manual">Manual</option>
            </select>
          </div>
          <div class="form-group">
            <label for="pollInterval">Interval (seconds)</label>
            <input type="number" id="pollInterval" name="pollInterval" class="input-field" min="10" max="3600" />
            <span class="form-help">10-3600 sec</span>
          </div>
        </div>
      </div>

      <!-- Review Filtering Section -->
      <div class="settings-section">
        <h3 class="settings-section-title">Review Filtering</h3>
        <div class="form-row">
          <div class="form-group checkbox-group">
            <label class="checkbox-label">
              <input type="checkbox" id="onlyOwnPRs" name="onlyOwnPRs" />
              <span>Only review my PRs</span>
            </label>
            <span class="form-help">Only review PRs you authored</span>
          </div>
          <div class="form-group checkbox-group">
            <label class="checkbox-label">
              <input type="checkbox" id="reviewOwnPRs" name="reviewOwnPRs" />
              <span>Include my PRs</span>
            </label>
            <span class="form-help">Include your own PRs in reviews</span>
          </div>
        </div>
      </div>

      <!-- Review Options Section -->
      <div class="settings-section">
        <h3 class="settings-section-title">Review Options</h3>
        <div class="form-row">
          <div class="form-group">
            <label for="parallelReviews">Parallel Reviews</label>
            <input type="number" id="parallelReviews" name="parallelReviews" class="input-field" min="1" max="10" />
            <span class="form-help">1-10 concurrent</span>
          </div>
          <div class="form-group">
            <label for="maxReviewVersions">Max Versions</label>
            <input type="number" id="maxReviewVersions" name="maxReviewVersions" class="input-field" min="1" max="100" />
            <span class="form-help">Max versions per PR</span>
          </div>
          <div class="form-group">
            <label for="contextVersions">Context Versions</label>
            <input type="number" id="contextVersions" name="contextVersions" class="input-field" min="0" max="10" />
            <span class="form-help">Previous versions for Claude</span>
          </div>
        </div>
      </div>

      <!-- Cleanup Section -->
      <div class="settings-section">
        <h3 class="settings-section-title">Cleanup</h3>
        <div class="form-row">
          <div class="form-group">
            <label for="cleanupIntervalHours">Interval (hours)</label>
            <input type="number" id="cleanupIntervalHours" name="cleanupIntervalHours" class="input-field" min="1" />
            <span class="form-help">How often to run cleanup</span>
          </div>
          <div class="form-group">
            <label for="cleanupAgeDays">Age (days)</label>
            <input type="number" id="cleanupAgeDays" name="cleanupAgeDays" class="input-field" min="1" />
            <span class="form-help">Remove closed PRs older than</span>
          </div>
        </div>
      </div>

      <!-- Server Info Section (read-only) -->
      <div class="settings-section settings-section-readonly">
        <h3 class="settings-section-title">Server (requires restart)</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Port</label>
            <div class="readonly-value" id="webPort"></div>
          </div>
          <div class="form-group">
            <label>Work Directory</label>
            <div class="readonly-value" id="workDir"></div>
          </div>
        </div>
      </div>
    </form>

    <script>
      (function() {
        const form = document.getElementById('settings-form');
        const saveBtn = document.getElementById('save-btn');
        const resetBtn = document.getElementById('reset-btn');
        const statusEl = document.getElementById('settings-status');

        let currentSettings = {};
        let defaults = {};

        // Load settings
        async function loadSettings() {
          try {
            const res = await fetch('/api/settings');
            const data = await res.json();
            currentSettings = data.settings;
            defaults = data.defaults;

            // Populate form
            document.getElementById('githubUsername').value = currentSettings.githubUsername || '';
            document.getElementById('repoPatterns').value = (currentSettings.repoPatterns || []).join(', ');
            document.getElementById('pollInterval').value = currentSettings.pollInterval || 60;
            document.getElementById('syncMode').value = currentSettings.syncMode || 'auto';
            document.getElementById('onlyOwnPRs').checked = currentSettings.onlyOwnPRs || false;
            document.getElementById('reviewOwnPRs').checked = currentSettings.reviewOwnPRs || false;
            document.getElementById('parallelReviews').value = currentSettings.parallelReviews || 3;
            document.getElementById('maxReviewVersions').value = currentSettings.maxReviewVersions || 10;
            document.getElementById('contextVersions').value = currentSettings.contextVersions || 2;
            document.getElementById('cleanupIntervalHours').value = currentSettings.cleanupIntervalHours || 24;
            document.getElementById('cleanupAgeDays').value = currentSettings.cleanupAgeDays || 7;

            // Read-only server info
            document.getElementById('webPort').textContent = data.restartRequired.webPort;
            document.getElementById('workDir').textContent = data.restartRequired.workDir;

            statusEl.textContent = 'Settings loaded';
          } catch (err) {
            statusEl.textContent = 'Error loading settings: ' + err.message;
          }
        }

        // Gather form values
        function gatherFormValues() {
          const patternsStr = document.getElementById('repoPatterns').value;
          const repoPatterns = patternsStr
            ? patternsStr.split(',').map(s => s.trim()).filter(Boolean)
            : [];

          return {
            githubUsername: document.getElementById('githubUsername').value.trim(),
            repoPatterns,
            pollInterval: parseInt(document.getElementById('pollInterval').value, 10),
            syncMode: document.getElementById('syncMode').value,
            onlyOwnPRs: document.getElementById('onlyOwnPRs').checked,
            reviewOwnPRs: document.getElementById('reviewOwnPRs').checked,
            parallelReviews: parseInt(document.getElementById('parallelReviews').value, 10),
            maxReviewVersions: parseInt(document.getElementById('maxReviewVersions').value, 10),
            contextVersions: parseInt(document.getElementById('contextVersions').value, 10),
            cleanupIntervalHours: parseInt(document.getElementById('cleanupIntervalHours').value, 10),
            cleanupAgeDays: parseInt(document.getElementById('cleanupAgeDays').value, 10),
          };
        }

        // Save settings
        saveBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          saveBtn.disabled = true;
          saveBtn.classList.add('syncing');
          statusEl.textContent = 'Saving settings...';

          try {
            const values = gatherFormValues();
            const res = await fetch('/api/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(values)
            });
            const data = await res.json();

            if (data.success) {
              currentSettings = data.settings;
              statusEl.textContent = 'Settings saved successfully';
            } else if (data.errors) {
              const errorMessages = data.errors.map(e => e.field + ': ' + e.message).join(', ');
              statusEl.textContent = 'Validation errors: ' + errorMessages;
            } else {
              statusEl.textContent = 'Error: ' + (data.error || 'Unknown error');
            }
          } catch (err) {
            statusEl.textContent = 'Error saving settings: ' + err.message;
          } finally {
            saveBtn.disabled = false;
            saveBtn.classList.remove('syncing');
          }
        });

        // Reset to defaults
        resetBtn.addEventListener('click', async () => {
          if (!confirm('Reset all settings to their default values from .env?')) return;

          resetBtn.disabled = true;
          statusEl.textContent = 'Resetting settings...';

          try {
            const res = await fetch('/api/settings/reset', { method: 'POST' });
            const data = await res.json();

            if (data.success) {
              currentSettings = data.settings;
              // Reload form with new values
              await loadSettings();
              statusEl.textContent = 'Settings reset to defaults';
            } else {
              statusEl.textContent = 'Error: ' + (data.error || 'Unknown error');
            }
          } catch (err) {
            statusEl.textContent = 'Error resetting settings: ' + err.message;
          } finally {
            resetBtn.disabled = false;
          }
        });

        // Initial load
        loadSettings();
      })();
    </script>
  `;
}
