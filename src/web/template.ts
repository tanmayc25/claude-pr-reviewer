export const htmlTemplate = (title: string, content: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - PR Reviews</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <style>
    :root {
      --bg-primary: #09090b;
      --bg-secondary: #18181b;
      --bg-tertiary: #27272a;
      --bg-hover: #1f1f23;
      --border-color: #27272a;
      --border-hover: #3f3f46;
      --text-primary: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #71717a;
      --text-dimmed: #52525b;
      --text-content: #d4d4d8;
      --accent-blue: #3b82f6;
      --accent-green: #22c55e;
      --accent-orange: #f59e0b;
      --accent-red: #dc2626;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 24px; }
    a { color: var(--text-primary); text-decoration: none; }
    a:hover { color: var(--text-secondary); }
    h1 { font-size: 1.875rem; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
    h2 { font-size: 1.5rem; font-weight: 600; color: var(--text-primary); margin: 24px 0 16px; }
    h3 { font-size: 1.25rem; font-weight: 600; color: var(--text-primary); margin: 20px 0 12px; }
    .breadcrumb { margin-bottom: 24px; color: var(--text-muted); font-size: 14px; }
    .breadcrumb a { color: var(--text-secondary); }
    .breadcrumb a:hover { color: var(--text-primary); }
    .search-container { margin-bottom: 20px; }
    /* Shared input styles */
    .input-field {
      width: 100%;
      padding: 10px 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    .input-field::placeholder, .search-input::placeholder { color: var(--text-dimmed); }
    .input-field:focus, .search-input:focus { border-color: var(--border-hover); }
    .search-input {
      width: 100%;
      padding: 10px 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      color: var(--text-primary);
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    /* Shared list item styles */
    .list, .pending-list { list-style: none; }
    .list li, .pending-list li {
      padding: 16px;
      margin: 8px 0;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      transition: border-color 0.2s, background 0.2s;
    }
    .list li:hover, .pending-list li:hover { border-color: var(--border-hover); background: var(--bg-hover); }
    .list li a { display: block; }
    /* Shared PR item styles */
    .pr-header { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .pr-number { font-weight: 600; color: var(--text-primary); }
    .pr-title { color: var(--text-secondary); }
    .pr-meta { display: flex; gap: 16px; color: var(--text-dimmed); font-size: 13px; margin-top: 8px; }
    .review-content {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 24px;
    }
    .review-content h1, .review-content h2, .review-content h3 { border-bottom: 1px solid var(--border-color); padding-bottom: 8px; }
    .review-content p { margin: 12px 0; color: var(--text-content); }
    .review-content ul, .review-content ol { margin: 12px 0; padding-left: 24px; color: var(--text-content); }
    .review-content li { margin: 4px 0; }
    .review-content pre {
      background: var(--bg-primary);
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 16px 0;
      border: 1px solid var(--border-color);
    }
    .review-content code {
      background: var(--bg-tertiary);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
      font-size: 13px;
      color: var(--text-primary);
    }
    .review-content pre code { padding: 0; background: none; border: none; }
    .review-content blockquote {
      border-left: 3px solid var(--border-hover);
      margin: 16px 0;
      padding-left: 16px;
      color: var(--text-muted);
    }
    .review-content table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    .review-content th, .review-content td {
      border: 1px solid var(--border-color);
      padding: 10px 14px;
      text-align: left;
    }
    .review-content th { background: var(--bg-secondary); font-weight: 600; }
    .review-content strong { color: var(--text-primary); }
    .review-content a { color: var(--text-secondary); text-decoration: underline; }
    .review-content a:hover { color: var(--text-primary); }
    .empty { color: var(--text-dimmed); font-style: italic; padding: 40px; text-align: center; }
    hr { border: none; border-top: 1px solid var(--border-color); margin: 24px 0; }
    .code-block-wrapper { position: relative; }
    .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-hover);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      color: var(--text-secondary);
      font-size: 12px;
      opacity: 0;
      transition: all 0.2s;
    }
    .code-block-wrapper:hover .copy-btn { opacity: 1; }
    .copy-btn:hover { background: var(--border-hover); color: var(--text-primary); }
    .copy-btn.copied { background: var(--accent-green); border-color: var(--accent-green); color: #fff; }
    .hidden { display: none !important; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .header h1 { margin-bottom: 0; }
    /* Shared button styles */
    .btn {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-hover);
      border-radius: 8px;
      padding: 10px 16px;
      cursor: pointer;
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn:hover, .sync-btn:hover { background: var(--border-hover); }
    .btn:disabled, .sync-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sync-btn {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-hover);
      border-radius: 8px;
      padding: 10px 16px;
      cursor: pointer;
      color: var(--text-primary);
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sync-btn.syncing { background: var(--border-hover); }
    .sync-icon { display: inline-block; width: 16px; height: 16px; }
    .sync-btn.syncing .sync-icon { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .sync-status { font-size: 13px; color: var(--text-dimmed); margin-top: 8px; }
    .header-buttons { display: flex; gap: 8px; }
    .pending-list li { display: flex; align-items: flex-start; gap: 12px; }
    /* Shared checkbox styles */
    .pending-list input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--accent-blue);
      cursor: pointer;
      margin-top: 4px;
    }
    .pending-list .pr-info { flex: 1; }
    .pending-list .pr-repo { color: var(--text-muted); font-size: 13px; }
    /* Status badges */
    .has-changes, .no-changes {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 8px;
    }
    .has-changes { background: var(--accent-green); color: #fff; }
    .no-changes { background: var(--text-dimmed); color: var(--text-secondary); }
    .pending-actions { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
    .select-all-label {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;
    }
    .select-all-label input {
      width: 16px;
      height: 16px;
      accent-color: var(--accent-blue);
      cursor: pointer;
    }
    .selection-count { color: var(--text-dimmed); font-size: 13px; }
    .custom-prompt-container { margin-bottom: 16px; }
    .custom-prompt-label {
      display: block;
      color: var(--text-secondary);
      font-size: 14px;
      margin-bottom: 8px;
    }
    .custom-prompt-input {
      width: 100%;
      padding: 12px 14px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 14px;
      resize: vertical;
      outline: none;
      transition: border-color 0.2s;
    }
    .custom-prompt-input::placeholder { color: var(--text-dimmed); }
    .custom-prompt-input:focus { border-color: var(--border-hover); }
    .force-review-label {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;
    }
    .force-review-label input {
      width: 16px;
      height: 16px;
      accent-color: var(--accent-orange);
      cursor: pointer;
    }
    .list .pr-item { display: flex; align-items: center; gap: 12px; }
    .list .pr-item .pr-link { flex: 1; display: block; }
    .pr-actions { display: flex; gap: 8px; opacity: 0; transition: opacity 0.2s; }
    .list li:hover .pr-actions { opacity: 1; }
    .action-btn {
      background: var(--bg-tertiary);
      border: 1px solid var(--border-hover);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      color: var(--text-secondary);
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .action-btn:hover { background: var(--border-hover); color: var(--text-primary); }
    .action-btn.delete-btn:hover { background: var(--accent-red); border-color: var(--accent-red); color: #fff; }
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .modal-overlay.hidden { display: none; }
    .modal {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 24px;
      width: 100%;
      max-width: 500px;
      margin: 16px;
    }
    .modal h3 { margin: 0 0 16px 0; font-size: 1.25rem; color: var(--text-primary); }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    ${content}
  </div>
  <script>
    document.addEventListener('DOMContentLoaded', function() {
      // Copy buttons for code blocks
      document.querySelectorAll('.review-content pre').forEach(function(pre) {
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);

        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.onclick = function() {
          const code = pre.querySelector('code') || pre;
          navigator.clipboard.writeText(code.textContent).then(function() {
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(function() {
              btn.textContent = 'Copy';
              btn.classList.remove('copied');
            }, 2000);
          });
        };
        wrapper.appendChild(btn);
      });

      // Syntax highlighting
      document.querySelectorAll('.review-content pre code').forEach((block) => {
        hljs.highlightElement(block);
      });

      // Search functionality
      const searchInput = document.getElementById('search-input');
      if (searchInput) {
        searchInput.addEventListener('input', function(e) {
          const query = e.target.value.toLowerCase();
          document.querySelectorAll('.list li').forEach(function(li) {
            const text = li.textContent.toLowerCase();
            li.classList.toggle('hidden', query && !text.includes(query));
          });
        });
      }

      // Sync button functionality
      const syncBtn = document.getElementById('sync-btn');
      const syncStatus = document.getElementById('sync-status');

      async function checkSyncStatus() {
        try {
          const res = await fetch('/api/status');
          const data = await res.json();
          if (data.syncing && syncBtn) {
            syncBtn.disabled = true;
            syncBtn.classList.add('syncing');
            syncStatus.textContent = 'Sync in progress...';
            setTimeout(checkSyncStatus, 2000);
          } else if (syncBtn) {
            syncBtn.disabled = false;
            syncBtn.classList.remove('syncing');
          }
        } catch (err) {}
      }

      checkSyncStatus();

      if (syncBtn) {
        syncBtn.addEventListener('click', async function() {
          syncBtn.disabled = true;
          syncBtn.classList.add('syncing');
          syncStatus.textContent = 'Syncing PRs...';

          try {
            const res = await fetch('/api/sync', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
              syncStatus.textContent = 'Sync complete: ' + data.message;
              setTimeout(() => location.reload(), 1500);
            } else if (data.error === 'Sync already in progress') {
              syncStatus.textContent = 'Sync already in progress...';
              checkSyncStatus();
            } else {
              syncStatus.textContent = 'Sync failed: ' + (data.error || 'Unknown error');
              syncBtn.disabled = false;
              syncBtn.classList.remove('syncing');
            }
          } catch (err) {
            syncStatus.textContent = 'Sync failed: ' + err.message;
            syncBtn.disabled = false;
            syncBtn.classList.remove('syncing');
          }
        });
      }
    });
  </script>
</body>
</html>`;
