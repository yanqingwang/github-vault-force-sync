# Vault Force Sync

An [Obsidian](https://obsidian.md) plugin that syncs your entire vault to a GitHub repository using the system `git`. It pushes only what changed (incremental sync), can force-push when you need it, automatically skips files larger than 100 MB so a sync never gets stuck, and keeps a local log you can view anytime.

## Features

- **One-click sync** — a ribbon button and a command palette command push all new and changed vault content to your GitHub remote.
- **Incremental sync** — `git add -A` → commit → push. Only the delta since the last sync is uploaded.
- **Three push modes**:
  | Mode | Behavior |
  |------|----------|
  | Incremental | Normal `git push` only; never overwrites the remote. |
  | Auto | Normal push; `--force-with-lease` only when the remote is strictly behind local (e.g. you rewrote local history). Never overwrites diverged remote commits. |
  | Force | Always `git push --force-with-lease`. |
- **Large-file guard** — files over the configured size limit (default 100 MB, GitHub's hard limit) are skipped via `.git/info/exclude` so the rest of the sync continues.
- **Dotfiles stay local** — writes a `.gitignore` (`.*` + `!/.gitignore`) so `.obsidian` and other hidden files/folders are never tracked.
- **Sync log** — every run is recorded to `sync.log` (local only, never committed), viewable from the command palette or Settings.
- **Optional proxy** — configure an HTTP(S) proxy for git if your network needs one to reach GitHub.
- **Auto sync on startup** — optional one-shot sync shortly after Obsidian opens.

## Requirements

- Obsidian **desktop** (the plugin uses Node.js APIs and is marked `isDesktopOnly`).
- `git` installed and reachable (from `PATH`, or set the full path in settings).
- Your vault should be (or will become) a git repository — the plugin runs git inside the vault folder. If there is no repo yet, run `git init` in the vault once; the plugin then sets up `origin` for you.
- A GitHub repository to sync to, with push access configured (HTTPS with a credential helper, or SSH — whatever your local git already uses).

## Install

### From the community directory

> Not yet listed — the plugin is being submitted for review. Until it appears in the community directory, use manual install or BRAT below.

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/yanqingwang/vault-github-with-force/releases).
2. Create `<vault>/.obsidian/plugins/vault-force-sync/` and copy the three files into it.
3. Reload Obsidian and enable **Vault Force Sync** in Settings → Community plugins.

### Beta testing via BRAT

Add `yanqingwang/vault-github-with-force` as a beta plugin in [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## Usage

1. Enable the plugin, then open **Settings → Vault Force Sync**.
2. Set the **Remote URL** to your GitHub repository (e.g. `https://github.com/user/vault-backup.git`). Leave it empty to keep an existing `origin`.
3. Optionally set **Git location** (full path to the git binary), **Proxy**, **Branch**, and **Max file size**.
4. Click the refresh icon in the ribbon, or run one of the commands:

| Command | What it does |
|---------|--------------|
| Sync vault to remote (incremental) | Commit + push using the configured sync mode. |
| Force push all data to remote | Commit + `git push --force-with-lease`. |
| Open sync log | View the last 300 lines of `sync.log`. |

## What the plugin writes to your system

- `<vault>/.gitignore` — only if missing (`.*` / `!/.gitignore`).
- `<vault>/.git/info/exclude` — paths of oversized files (never committed).
- Repo-local git config: `http.postBuffer`, and `http.proxy` / `https.proxy` **only if** you configured a proxy.
- `<vault>/.obsidian/plugins/vault-force-sync/sync.log` — the sync log (`.obsidian` is gitignored).

The plugin never modifies your notes' content — it only stages, commits, and pushes.

## Safety notes

- `--force-with-lease` (not `--force`) is always used for force pushes, so a remote that moved ahead unexpectedly will not be overwritten.
- If local and remote have diverged, incremental/auto modes stop and tell you how many remote commits you are missing instead of discarding them.
- Files larger than the limit are reported in a notice and skipped; everything else syncs normally.

## Settings reference

| Setting | Default | Description |
|---------|---------|-------------|
| Remote URL | *(empty)* | Sync target, kept as git `origin`. Empty = keep existing origin. |
| Git location | *(empty)* | Full path to git. Empty = git from `PATH`. |
| Proxy | *(empty)* | HTTP(S) proxy for git, e.g. `http://127.0.0.1:7890`. Empty = no proxy. |
| Branch | `main` | Remote branch to sync. |
| Sync mode | Incremental | See push modes above. |
| Max file size (MB) | `100` | Larger files are skipped. GitHub hard limit is 100 MB. |
| Auto sync on load | off | Run one sync shortly after Obsidian starts. |
| Show success notice | on | Notice after each successful sync. |
| Enable logging | on | Write sync results to `sync.log`. |

## License

[MIT](./LICENSE)
