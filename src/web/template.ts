export const htmlTemplate = (title: string, content: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - PR Reviews</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      background: #09090b;
      color: #fafafa;
      min-height: 100vh;
    }
    .container { max-width: 900px; margin: 0 auto; padding: 24px; }
    a { color: #fafafa; text-decoration: none; }
    a:hover { color: #a1a1aa; }
    h1 { font-size: 1.875rem; font-weight: 600; color: #fafafa; margin-bottom: 8px; }
    h2 { font-size: 1.5rem; font-weight: 600; color: #fafafa; margin: 24px 0 16px; }
    h3 { font-size: 1.25rem; font-weight: 600; color: #fafafa; margin: 20px 0 12px; }
    .breadcrumb { margin-bottom: 24px; color: #71717a; font-size: 14px; }
    .breadcrumb a { color: #a1a1aa; }
    .breadcrumb a:hover { color: #fafafa; }
    .search-container { margin-bottom: 20px; }
    .search-input {
      width: 100%;
      padding: 10px 14px;
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 8px;
      color: #fafafa;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    .search-input::placeholder { color: #52525b; }
    .search-input:focus { border-color: #3f3f46; }
    .list { list-style: none; }
    .list li {
      padding: 16px;
      margin: 8px 0;
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 8px;
      transition: border-color 0.2s, background 0.2s;
    }
    .list li:hover { border-color: #3f3f46; background: #1f1f23; }
    .list li a { display: block; }
    .list .pr-header { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .list .pr-number { font-weight: 600; color: #fafafa; }
    .list .pr-title { color: #a1a1aa; }
    .list .pr-meta { display: flex; gap: 16px; color: #52525b; font-size: 13px; margin-top: 8px; }
    .review-content {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 8px;
      padding: 24px;
    }
    .review-content h1, .review-content h2, .review-content h3 { border-bottom: 1px solid #27272a; padding-bottom: 8px; }
    .review-content p { margin: 12px 0; color: #d4d4d8; }
    .review-content ul, .review-content ol { margin: 12px 0; padding-left: 24px; color: #d4d4d8; }
    .review-content li { margin: 4px 0; }
    .review-content pre {
      background: #09090b;
      padding: 16px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 16px 0;
      border: 1px solid #27272a;
    }
    .review-content code {
      background: #27272a;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
      font-size: 13px;
      color: #fafafa;
    }
    .review-content pre code { padding: 0; background: none; border: none; }
    .review-content blockquote {
      border-left: 3px solid #3f3f46;
      margin: 16px 0;
      padding-left: 16px;
      color: #71717a;
    }
    .review-content table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    .review-content th, .review-content td {
      border: 1px solid #27272a;
      padding: 10px 14px;
      text-align: left;
    }
    .review-content th { background: #18181b; font-weight: 600; }
    .review-content strong { color: #fafafa; }
    .review-content a { color: #a1a1aa; text-decoration: underline; }
    .review-content a:hover { color: #fafafa; }
    .empty { color: #52525b; font-style: italic; padding: 40px; text-align: center; }
    hr { border: none; border-top: 1px solid #27272a; margin: 24px 0; }
    .code-block-wrapper { position: relative; }
    .copy-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      color: #a1a1aa;
      font-size: 12px;
      opacity: 0;
      transition: all 0.2s;
    }
    .code-block-wrapper:hover .copy-btn { opacity: 1; }
    .copy-btn:hover { background: #3f3f46; color: #fafafa; }
    .copy-btn.copied { background: #22c55e; border-color: #22c55e; color: #fff; }
    .hidden { display: none !important; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .header h1 { margin-bottom: 0; }
    .sync-btn {
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 8px;
      padding: 10px 16px;
      cursor: pointer;
      color: #fafafa;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sync-btn:hover { background: #3f3f46; }
    .sync-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sync-btn.syncing { background: #3f3f46; }
    .sync-icon { display: inline-block; width: 16px; height: 16px; }
    .sync-btn.syncing .sync-icon { animation: spin 1s linear infinite; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .sync-status { font-size: 13px; color: #52525b; margin-top: 8px; }
    .header-buttons { display: flex; gap: 8px; }
    .pending-list { list-style: none; }
    .pending-list li {
      padding: 16px;
      margin: 8px 0;
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 8px;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .pending-list li:hover { border-color: #3f3f46; background: #1f1f23; }
    .pending-list input[type="checkbox"] {
      width: 18px;
      height: 18px;
      margin-top: 4px;
      accent-color: #3b82f6;
      cursor: pointer;
    }
    .pending-list .pr-info { flex: 1; }
    .pending-list .pr-header { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .pending-list .pr-number { font-weight: 600; color: #fafafa; }
    .pending-list .pr-title { color: #a1a1aa; }
    .pending-list .pr-meta { display: flex; gap: 16px; color: #52525b; font-size: 13px; margin-top: 8px; }
    .pending-list .pr-repo { color: #71717a; font-size: 13px; }
    .has-changes {
      display: inline-block;
      background: #22c55e;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 8px;
    }
    .no-changes {
      display: inline-block;
      background: #52525b;
      color: #a1a1aa;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 8px;
    }
    .pending-actions {
      display: flex;
      gap: 12px;
      align-items: center;
      margin-bottom: 16px;
    }
    .select-all-label {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #a1a1aa;
      font-size: 14px;
      cursor: pointer;
    }
    .select-all-label input {
      width: 16px;
      height: 16px;
      accent-color: #3b82f6;
      cursor: pointer;
    }
    .selection-count { color: #52525b; font-size: 13px; }
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
