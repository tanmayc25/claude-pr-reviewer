# PR Review Daemon

A local daemon that monitors GitHub PRs and automatically generates code reviews using Claude Code CLI.

## Features

- Polls GitHub for open PRs at configurable intervals
- Filters PRs by repository (exact match or regex patterns)
- Filters PRs by author (review only your PRs, or exclude your PRs)
- Clones repos locally and checks out PR branches
- Generates reviews using Claude Code CLI
- Appends reviews to a single file per PR (maintains context across updates)
- Desktop notifications (macOS) when new PRs are detected
- Automatic cleanup of closed PRs and old repos

## Prerequisites

- Node.js
- GitHub CLI (`gh`) authenticated
- Claude Code CLI (`claude`)

## Setup

```bash
# Clone/copy the repo
cd pr-review-daemon

# Install dependencies
npm install

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

# Cleanup
CLEANUP_INTERVAL_HOURS=24
CLEANUP_AGE_DAYS=7
```

## Usage

```bash
npm start
```

## Output

Reviews are saved to: `./<org>_<repo>/pr-review-<number>.md` (in the daemon directory)

Each review file accumulates reviews over time as the PR is updated:

```markdown
# PR Review: Fix authentication bug

**Repository:** mycompany/api
**PR:** #42
**Author:** yourname
**URL:** https://github.com/mycompany/api/pull/42

---

## Review @ 2024-01-25T10:30:00.000Z
**Commit:** `abc123f`

<review content>

---

## Review @ 2024-01-25T14:45:00.000Z
**Commit:** `def456a`

<follow-up review with context from previous>
```

## State

- `.pr-state.json` - Tracks processed commit SHAs to avoid re-reviewing
- Delete this file to re-review all PRs

## License

MIT
