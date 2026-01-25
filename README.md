# PR Review Daemon

A local daemon that monitors GitHub PRs and automatically generates code reviews using Claude Code CLI.

## Features

- Polls GitHub for open PRs at configurable intervals
- Filters PRs by repository (exact match or regex patterns)
- Filters PRs by author (review only your PRs, or exclude your PRs)
- Clones repos locally and checks out PR branches
- Generates reviews using Claude Code CLI
- **Versioned reviews**: Each review is stored as a separate version file
- **Context-aware**: Passes previous reviews to Claude so it can track addressed issues
- **Tabbed UI**: Browse review versions in a tabbed interface (latest to oldest)
- **Web interface** for browsing and reading reviews with rendered markdown
- Automatic cleanup of closed PRs, old repos, and excess review versions

## Prerequisites

- [Bun](https://bun.sh)
- GitHub CLI (`gh`) authenticated
- Claude Code CLI (`claude`)

## Setup

```bash
# Clone/copy the repo
cd pr-review-daemon

# Install dependencies
bun install

# Configure
cp .env.example .env
# Edit .env with your settings
```

## Configuration

Edit `.env`:

```bash
# Your GitHub username
GITHUB_USERNAME=yourname

# Review mode
ONLY_OWN_PRS=true      # Only review your own PRs
REVIEW_OWN_PRS=false   # (ignored when ONLY_OWN_PRS=true)

# Poll interval (seconds)
POLL_INTERVAL=60

# Repos to monitor (leave empty for all PRs involving you)
# Exact: owner/repo
# Regex: /pattern/
REPOS=/mycompany\/.*/

# Work directory (defaults to daemon directory)
# WORK_DIR=~/pr-reviews

# Web server port for browsing reviews
WEB_PORT=3456

# Sync mode: "auto" (poll automatically) or "manual" (trigger from UI)
SYNC_MODE=auto

# Number of PRs to review in parallel (default: 3)
PARALLEL_REVIEWS=3

# Cleanup
CLEANUP_INTERVAL_HOURS=24
CLEANUP_AGE_DAYS=7

# Review versioning
MAX_REVIEW_VERSIONS=10   # Max versions to keep per PR
CONTEXT_VERSIONS=2       # Previous versions passed to Claude for context
```

## Usage

```bash
bun start
```

Then open http://localhost:3456 to browse reviews in your browser.

## Output

Reviews are saved in a versioned directory structure:

```
claude-pr-reviewer/
├── mycompany_repo/              # cloned repo (clean)
│   └── ... (repo files only)
├── reviews/
│   └── mycompany_repo/
│       ├── pr-42/               # Directory per PR
│       │   ├── meta.json        # PR metadata
│       │   ├── v-20240125T143022Z.md   # Version files (newest)
│       │   ├── v-20240125T103000Z.md   # (older)
│       │   └── ...
│       └── pr-43/
│           └── ...
```

Each version file contains a single review:

```markdown
## Review @ 2024-01-25T14:30:22Z
**Commit:** `abc123f`

<review content>
```

The `meta.json` stores PR metadata:

```json
{
  "title": "Fix authentication bug",
  "repoFullName": "mycompany/api",
  "prNumber": 42,
  "author": "yourname",
  "url": "https://github.com/mycompany/api/pull/42",
  "createdAt": "2024-01-25T10:30:00.000Z"
}
```

## Web Interface

The built-in web server at http://localhost:3456 provides:

- List of all repositories with reviews
- PR listing with title, author, and last synced time
- **Tabbed version viewer**: Switch between review versions (latest shown by default)
- Search functionality to filter repos and PRs
- Rendered markdown with syntax highlighting
- Copy buttons on code blocks
- Re-review button with custom prompt support
- Delete button to remove reviews
- Sync button for manual sync mode (or to trigger sync in auto mode)

### Migration

Old single-file reviews (`pr-review-{number}.md`) are automatically migrated to the new versioned directory format when accessed.

## State

- `.pr-state.json` - Tracks processed commit SHAs to avoid re-reviewing
- Delete this file to re-review all PRs

## License

MIT
