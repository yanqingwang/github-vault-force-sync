# Vault Force Sync

**English** | [简体中文](README.zh-CN.md)

An [Obsidian](https://obsidian.md) plugin that keeps your entire vault in sync with a GitHub repository using the system `git`. It works **in both directions** — it pulls what changed on another device and pushes what changed on this one — moves only the delta since the last sync, can force-push when you need it, automatically skips files larger than 100 MB so a sync never gets stuck, and keeps a local log you can view anytime.

Your notes are the one thing here that cannot be regenerated, so the design is built around never being the reason you lose them. Everything below is arranged under that constraint — see [what the plugin guarantees](#what-the-plugin-guarantees).

## What the plugin guarantees

Every promise here is covered by a test that drives the real `git` binary against real repositories, because each one is a property of what git actually does to a directory layout — a mocked git would hide all of them.

**It refuses to touch a repository that is not the vault's.**
`git rev-parse --is-inside-work-tree` is true for a vault merely *nested inside* a project, and `git add -A` run from a subdirectory stages the **entire** repository, not the subdirectory. A plugin checking only the first would commit and push a whole project its user never pointed it at — deletions included. So the vault must be the **root** of its repository; anything else is refused with both paths named, before a single file is written.

**A force push cannot silently destroy what it overwrites.**
Before any `--force-with-lease`, the current remote state is saved to a local ref. `--force-with-lease` protects against a remote that moved unexpectedly; it does *not* make the commits you just discarded recoverable. Now they are:

```bash
git -C <vault> for-each-ref refs/vault-force-sync/
git -C <vault> branch recovered refs/vault-force-sync/<timestamp>
```

The last 5 are kept, local only, never pushed. If a backup cannot be written the force push is **aborted** rather than proceeding unprotected.

**A note is never left holding conflict markers.**
Obsidian has no merge UI. A conflicted sync is rolled back to the state it started from and the conflicting files are reported, so an unattended run cannot leave `<<<<<<<` in a note nobody opens. An unresolved merge **blocks** the next sync instead of being committed.

**The remote is never overwritten in incremental or auto mode.**
Divergence is integrated with a real merge or rebase. `--force-with-lease` appears only in Force mode, or in Auto mode when the remote is strictly behind — and even then the lease guard stops it if the remote moved.

**Nothing is written outside the vault's own repository.**
No `reset --hard`, no `git clean`, no `git stash`, no `checkout`. The only writes to your directory are the ones listed under [what the plugin writes](#what-the-plugin-writes-to-your-system), and each is undone by deleting a file.

**A size-skip cannot outlive its reason.**
Files over the limit are listed in `.git/info/exclude` so they do not slow every sync. That list is **rewritten** on each run rather than appended to: raise the limit, shrink the file, or delete it, and the pattern is released. An append-only list would keep that file out of the repository forever, with nothing on screen explaining why it never reached the other device.

**A token does not end up on disk.**
It lives in Obsidian's SecretStorage, reaches git through an environment variable, and is never written into `.git/config`, the remote URL, or the repository. A remote URL that *does* embed credentials is flagged, because git stores that URL in `.git/config` verbatim.

## Features

- **Two-way sync** — one command (or one timer tick) fetches the remote, integrates anything you are missing, and pushes what you have.
- **One-click sync** — a ribbon button and a command palette command do a full pull + push.
- **Automatic sync** — run it every *N* minutes while Obsidian is open, and/or once on startup. `N = 0` turns the timer off.
- **Incremental sync** — only the commits since the last sync move, in both directions.
- **Divergence is integrated, not refused.** When another device pushed while you had local changes, the remote commits are folded in (merge or rebase) and your commits go on top. The plugin used to stop and say "pull first" — you did that by hand, or reached for Force and lost work.
- **Conflicts roll back instead of corrupting notes.** Obsidian has no merge UI, so if the same note changed in both places the sync is undone and the conflicting files are listed. Your notes keep their content either way.
- **Three push modes**:
  | Mode | Behavior |
  |------|----------|
  | Incremental | Normal `git push` only. Divergence is resolved by integrating the remote; the remote is never overwritten. |
  | Auto | Normal push; `--force-with-lease` only when the remote is strictly behind local (e.g. you rewrote local history). Never overwrites diverged remote commits. |
  | Force | Always `git push --force-with-lease`. Discards the remote by request. |
- **Large-file guard** — files over the configured size limit (default 100 MB, GitHub's hard limit) are skipped via `.git/info/exclude` so the rest of the sync continues. That list is rewritten each run, so raising the limit brings the file back.
- **Force pushes are recoverable** — the remote's state is snapshotted to a local ref before a force push, so hitting Force by mistake is undoable.
- **Dotfiles stay local** — writes a `.gitignore` (`.*` + `!/.gitignore`) so `.obsidian` and other hidden files/folders are never tracked.
- **Works without a credential helper** — if the machine has no `gh`/Keychain/Credential Manager set up, select a personal access token (stored in Obsidian's SecretStorage, never in the vault) and the plugin authenticates with that instead.
- **Sync log** — every run is recorded to `sync.log` (local only, never committed), viewable from the command palette or Settings.
- **Optional proxy** — configure an HTTP(S) proxy for git if your network needs one to reach GitHub.

## How one sync runs

The order is deliberate:

```
stage (git add -A) → commit → fetch → integrate remote → push
```

**Commit before integrating.** `git rebase` refuses to run with unstaged changes, and a merge would otherwise have to resolve the commit we just made against the remote. Staging first means the tree is clean before we integrate, and your local change is merged as one unit.

**Integrate before pushing.** Whatever the remote gained is folded into your branch first, so your commits are pushed *on top of* remote history rather than against it.

**Never force in incremental/auto mode.** Divergence is resolved with a real merge or rebase. `--force-with-lease` is only used in `force` mode, or in `auto` mode when the remote is strictly behind (your local history was rewritten).

### Merge or rebase?

| | Merge (default) | Rebase |
|---|---|---|
| History | One merge commit per sync round | Linear |
| Existing commits | Never rewritten, so nothing already on the remote changes | Only your not-yet-pushed commits are replayed |
| Conflicts | One resolution per round | Can re-prompt, once per overlapping commit |
| Best for | Safety, shared remotes | A readable backup history |

Both are reversible and neither touches notes unless a conflict occurs.

### What happens on a conflict

If you edited `note.md` on two devices, a merge leaves `<<<<<<<` markers in it. Obsidian cannot show or resolve that, and a note nobody opens keeps the markers silently. So:

- **Auto-abort on (default)** — the sync is rolled back to exactly the state it started from, and the conflicting files are listed in a notice. Local commits stay, the remote is untouched, your note is byte-for-byte what you wrote.
- **Auto-abort off** — the merge is left in place for you to resolve by hand. Syncing stays paused until you do, so markers can never be committed by a later run.

Either way, an unresolved merge **blocks** the next sync rather than being committed.

## Requirements

- Obsidian **desktop** (the plugin uses Node.js APIs and is marked `isDesktopOnly`).
- `git` installed and reachable (from `PATH`, or set the full path in settings).
- Your vault must **be** a git repository — its own, with the vault at the repository root. If there is no repo yet, run `git init` in the vault once; the plugin then sets up `origin` for you. A vault that is merely *inside* another repository is refused, because syncing it would publish that entire project rather than just the vault.
- A GitHub repository to sync to, with push access configured (HTTPS with a credential helper, or SSH — whatever your local git already uses).

## Authentication

The plugin shells out to your system `git`, so **by default it uses whatever credentials that git already uses** — `gh auth login`, macOS Keychain, Git Credential Manager, libsecret, an SSH remote, anything. There is nothing to configure, and that stays the path unless you opt in to the next paragraph.

The one gap that closes: `git` runs without a terminal here, so it cannot show a login prompt. On a machine with no credential helper, a sync just fails with an authentication error in the log. For that case, Settings → Credentials lets you select a **personal access token**:

- The token is stored in [Obsidian's SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage), **not** in the plugin's `data.json`. Only the secret's *name* is kept in settings.
- It reaches git through a generated askpass helper, passed in the child process's environment. It is never written into `.git/config`, never into the remote URL, and never into this repository.
- Selecting a token clears git's credential-helper list for that one command, so your chosen token is actually the one used. Otherwise a cached credential would be tried first and silently win, making the setting look broken.
- Leave it empty and nothing changes at all.

Create a token under GitHub → Settings → Developer settings → Personal access tokens, with the `repo` scope (classic) or read/write **Contents** permission on the one repository (fine-grained). A GitHub account password will not work: GitHub stopped accepting passwords for Git operations in August 2021.

> **Note** — the *Git username* field is only used alongside a token, and GitHub ignores it entirely over HTTPS; the token is what authenticates. Leave the placeholder as it is unless your host expects a real name.

### Checking which account is in use

```bash
gh auth status                 # if you use the GitHub CLI
git -C <vault> config --get-all credential.helper
git -C <vault> remote -v
```

## Install

### From the community directory

> Not yet listed — the plugin is being submitted for review. Until it appears in the community directory, use manual install or BRAT below.

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/yanqingwang/github-vault-force-sync/releases).
2. Create `<vault>/.obsidian/plugins/vault-force-sync/` and copy the three files into it.
3. Reload Obsidian and enable **Vault Force Sync** in Settings → Community plugins.

### Beta testing via BRAT

Add `yanqingwang/github-vault-force-sync` as a beta plugin in [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## Usage

1. Enable the plugin, then open **Settings → Vault Force Sync**.
2. Set the **Remote URL** to your GitHub repository (e.g. `https://github.com/user/vault-backup.git`). Leave it empty to keep an existing `origin`.
3. Optionally set **Git location** (full path to the git binary), **Proxy**, **Branch**, and **Max file size**.
4. Turn on **Auto sync every N minutes** if you want it to run without you.
5. Click the refresh icon in the ribbon, or run one of the commands:

| Command | What it does |
|---------|--------------|
| Sync vault with remote (pull + push) | Fetch, integrate what you're missing, push what you have. |
| Pull remote changes only | Fetch and integrate; never commits or pushes. Good for seeing what another device did first. |
| Show sync status | Branch, short SHA, how far ahead/behind, uncommitted file count. |
| Force push all data to remote | Commit + `git push --force-with-lease`, discarding the remote's commits. |
| Open sync log | View the last 300 lines of `sync.log`. |

## What the plugin writes to your system

- `<vault>/.gitignore` — only if missing (`.*` / `!/.gitignore`).
- `<vault>/.git/info/exclude` — oversized files go in a marked, managed block so they do not slow every sync. The block is rewritten each run and released as soon as it stops applying; **anything you wrote in that file yourself is left untouched.** Never committed.
- `refs/vault-force-sync/<timestamp>` in your local repository — a snapshot of the remote taken before a force push. Local only, never pushed; the last 5 are kept.
- Repo-local git config: `http.postBuffer`, and `http.proxy` / `https.proxy` **only if** you configured a proxy.
- `<config-dir>/plugins/vault-force-sync/sync.log` — the sync log.
- `<config-dir>/plugins/vault-force-sync/.askpass.sh` (or `.askpass.cmd` on Windows) — **only when a token is configured**. It reads the token from the environment rather than containing it, so no secret is written to disk. It is a dotfile so the plugin's `.*` gitignore rule keeps it untracked whatever your config folder is called, and it is safe to delete — it is rewritten on the next sync.

The config directory is `Vault#configDir`, which is `.obsidian` unless you renamed it. The plugin never assumes that name.

The plugin never rewrites your notes' content except by pulling remote changes and resolving a conflict you asked it to resolve — and even then it rolls back rather than leaving markers.

## Safety notes

The guarantees above are the load-bearing ones. These are the operational details around them.

- **Everything not ignored is committed and pushed.** The plugin stages with `git add -A`, so any file in the vault that is not covered by `.gitignore` or `.git/info/exclude` goes into the commit and reaches the remote. Keep secrets out of the vault, or ignore them — a token in a note is a token on GitHub.
- Two syncs never overlap: a trigger that arrives mid-run is dropped, not queued. Without this a timer and a manual click could race on the same index.
- Files larger than the limit are reported in a notice and skipped; everything else syncs normally.
- The plugin never touches the config folder, so per-device settings (including this plugin's own) are not synced.
- A public remote makes the whole vault public. If you are syncing somewhere anyone can read, check what is in there first.

## Settings reference

| Setting | Default | Description |
|---------|---------|-------------|
| Remote URL | *(empty)* | Sync target, kept as git `origin`. Empty = keep existing origin. |
| Branch | `main` | Remote branch to sync. |
| Git location | *(empty)* | Full path to git. Empty = git from `PATH`. |
| Proxy | *(empty)* | HTTP(S) proxy for git, e.g. `http://127.0.0.1:7890`. Empty = no proxy. |
| Personal access token | *(empty)* | Optional. Empty = use this machine's git credentials. A selected secret makes the plugin authenticate with that token instead. Stored in SecretStorage, not in `data.json`. |
| Git username | *(empty)* | Only used with a token. Ignored by GitHub over HTTPS; a placeholder is used when empty. |
| Sync mode | Incremental | See push modes above. |
| How to integrate remote changes | Merge | `merge` or `rebase`. Only used when the remote has commits you lack. |
| Auto-abort sync conflicts | on | Roll a conflicted sync back and report it, instead of leaving a merge in place. |
| Auto sync every N minutes | `5` | Pull + push on a timer. `0` = off. |
| Auto sync on load | off | Run one full sync shortly after Obsidian starts. |
| Max file size (MB) | `100` | Larger files are skipped. GitHub hard limit is 100 MB. |
| Show success notice | on | Notice after each successful sync. |
| Enable logging | on | Write sync results to `sync.log`. |

Settings appear in Obsidian's settings **search** on 1.13.0 and later; `display()` is still used on older versions. Both read the same table, so they cannot disagree about what settings exist.

## Development

There is no build step — `main.js` is the source, plain CommonJS, loaded directly by Obsidian.

```bash
node --check main.js   # syntax
sh tests/run.sh        # the whole suite, 57 checks
```

`tests/run.sh` needs nothing installed beyond Node and `git`:

| File | Covers | Checks |
|------|--------|--------|
| `tests/sync.test.js` | Two devices sharing one bare remote: local-only change, remote-only change (fast-forward), clean divergence, conflict rollback, rebase, force, an unresolved merge blocking the next run, re-entrancy | 8 |
| `tests/settings.test.js` | Declarative definitions and search index, read/write, validation, timer lifecycle, log-path resolution | 17 |
| `tests/credentials.test.js` | Credential resolution, missing/empty SecretStorage, the generated helper holding no token, git's own credential lookup, `configDir` shapes | 17 |
| `tests/safety.test.js` | Refusal when the vault is not its repository root (and that the project is left untouched), force-push backups and recovery, backup pruning, credentials in a remote URL, size-skip patterns being released, user lines in `.git/info/exclude` surviving | 15 |

These are not unit tests over a mocked git. A merge that silently conflicts, or a push that runs before the pull, is invisible to a stub — so every scenario creates real repositories, a real bare remote, and drives the real binary. The credential tests run `git credential fill` and assert on what git actually hands back. The safety tests build the exact nested-vault layout that makes the repository-root check necessary, and then assert the parent project was left byte-for-byte untouched.

## License

[MIT](./LICENSE)