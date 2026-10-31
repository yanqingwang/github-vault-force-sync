# Vault Force Sync

[English](#english) | [中文](#中文)

---

## English

An [Obsidian](https://obsidian.md) plugin that keeps your entire vault — or only the folders you choose — in sync with a GitHub repository using the system `git`. It works **in both directions** — it pulls what changed on another device and pushes what changed on this one — moves only the delta since the last sync, can force-push when you need it, automatically skips files larger than 100 MB so a sync never gets stuck, and keeps a local log you can view anytime.

Your notes are the one thing here that cannot be regenerated, so the design is built around never being the reason you lose them. Everything below is arranged under that constraint — see [what the plugin guarantees](#what-the-plugin-guarantees).

### What the plugin guarantees

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

**Excluding a folder or a file never deletes what is already tracked.**
A file that was already tracked — whether you excluded its folder or the file itself — stays in the repository; the plugin stops staging its edits and resets a local deletion too. A move into an excluded folder is kept as a move when git can pair the two sides — a rename, or a same-name add — so the old remote copy stays. Removing an excluded path from the remote has to be an explicit `git rm --cached` plus a push.

**A token does not end up on disk.**
It lives in Obsidian's SecretStorage, reaches git through an environment variable, and is never written into `.git/config`, the remote URL, or the repository. A remote URL that *does* embed credentials is flagged, because git stores that URL in `.git/config` verbatim.

### Features

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
- **Sync scope controls** — exclude specific folders or individual files, sync only selected folders, and independently control dot-prefixed (hidden) files/folders and underscore-prefixed files/folders. Folder entries match at a folder boundary, so `Archive` never captures `Archive-old`; file entries match their exact path. Exclusions always outrank the sync-only selection. `.git`, `.trash`, and the plugin's own folder are always excluded.
- **No generated `.gitignore`** — the old `.*` rule is migrated away automatically, so turning dotfile sync back on actually works. Scope is applied to the staged file list instead, which lets a move into an excluded folder be paired as a move rather than a deletion.
- **Works without a credential helper** — if the machine has no `gh`/Keychain/Credential Manager set up, select a personal access token (stored in Obsidian's SecretStorage, never in the vault) and the plugin authenticates with that instead.
- **Sync log** — every run is recorded to `sync.log` (local only, never committed), viewable from the command palette or Settings.
- **Optional proxy** — configure an HTTP(S) proxy for git if your network needs one to reach GitHub.

### Sync scope

The scope controls mirror the Nextcloud sync plugin's folder and name filters, adapted to a git-backed vault:

| Control | What it does |
|---------|--------------|
| **Excluded folders** | Folders that are never staged or pushed. Matched by vault-relative folder prefix at a boundary: `Archive` covers `Archive/**` but not `Archive-old` or `notes/Archive`. |
| **Excluded files** | Individual files that are never staged or pushed, matched by their exact vault-relative path: `Inbox/secrets.md`. Pick one with **Choose** or type the path. A folder does not belong in this list — use Excluded folders, which also covers what is inside it. |
| **Sync only these folders** | Empty = the whole vault. When set, only files under those folders are staged (plus the root `.gitignore` control file); everything else stays local. Excluded folders, excluded files and the name filters still win. |
| **Exclude dot-prefixed (hidden) files** | Files whose basename starts with `.` — `.env`, `.DS_Store`. This is the hidden-file rule on macOS/Linux; Windows hidden attributes are not inspected. On by default. |
| **Exclude dot-prefixed (hidden) folders** | Folders whose name starts with `.` and everything inside — `.obsidian`, `.archive`. `.git` and `.trash` stay excluded even when this is off. On by default. |
| **Exclude underscore-prefixed files** | Files whose basename starts with `_` — `_draft.md`, `_template.canvas`. Off by default. |
| **Exclude underscore-prefixed folders** | Folders whose name starts with `_` and everything inside. Off by default. |

The four name toggles are independent. Turning off the dotfile rule syncs `.env` without syncing `.obsidian`; turning off the dotfolder rule syncs `.obsidian/config.json` without syncing `.env`.

The root `.gitignore` is treated as a repository control file and stays syncable in every mode. Nested `.gitignore` files follow the normal hidden-file rule. Only the block this plugin generated is migrated automatically; a `.*` rule you wrote yourself still hides dotfiles from git, so remove that line by hand if you want the toggle to take effect.

### What scope does and does not do

Scope controls decide what **this device stages and pushes**. They are not a history rewrite and not a download filter:

- Files that were already tracked when you exclude them — by folder, or by listing the file itself — stay in the repository. Local edits to them stop being pushed, but they are not deleted from the remote automatically. To remove them on purpose: `git rm --cached -- <path>`, then let the plugin commit and push the deletion.
- Those unstaged edits still make the working tree dirty. If a later pull needs to touch the same file, git can refuse the merge or rebase; the plugin reports that and never discards your edit. Commit it, revert it, or remove the file from the repository to unblock the pull.
- Files already on the remote are still pulled if they are in the branch history. Git merges history, not a filtered view of it. A folder excluded on this device is not erased from another device's clone.
- Moving a tracked file **into** an excluded folder is kept as a move when git can pair the two sides (a rename, or a same-name add). The old remote copy stays and the local move stays local. Moving a tracked file **out of** an excluded folder stages the new copy while the old excluded copy remains in the repository.
- In a sync-only selection, a move out is paired by basename; a move that changes both the folder and the name can look like a plain deletion.
- Obsidian's `.trash` is the exception: moving a note there *is* a deletion, so the tracked path is deleted on the remote. The trash copy itself is never committed.
- Excluded files are still visible to `git add` before the post-stage filter removes them. This is deliberate: hiding the destination in `.git/info/exclude` would make a move look like a deletion. Large untracked files are still handled by the size guard before staging.

### How one sync runs

The order is deliberate:

```
stage (git add -A, or the selected folders) → remove out-of-scope paths → commit → fetch → integrate remote → push
```

**Commit before integrating.** `git rebase` refuses to run with unstaged changes, and a merge would otherwise have to resolve the commit we just made against the remote. Staging first means the in-scope tree is clean before we integrate, and your local change is merged as one unit. Out-of-scope edits are left untouched; if one of them blocks the integration, the plugin reports it rather than discarding it.

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

### Requirements

- Obsidian **desktop** (the plugin uses Node.js APIs and is marked `isDesktopOnly`).
- `git` installed and reachable (from `PATH`, or set the full path in settings).
- Your vault must **be** a git repository — its own, with the vault at the repository root. If there is no repo yet, run `git init` in the vault once; the plugin then sets up `origin` for you. A vault that is merely *inside* another repository is refused, because syncing it would publish that entire project rather than just the vault.
- A GitHub repository to sync to, with push access configured (HTTPS with a credential helper, or SSH — whatever your local git already uses).

### Authentication

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

### Install

### From the community directory

> Not yet listed — the plugin is being submitted for review. Until it appears in the community directory, use manual install or BRAT below.

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/yanqingwang/github-vault-force-sync/releases).
2. Create `<vault>/.obsidian/plugins/vault-force-sync/` and copy the three files into it.
3. Reload Obsidian and enable **Vault Force Sync** in Settings → Community plugins.

### Beta testing via BRAT

Add `yanqingwang/github-vault-force-sync` as a beta plugin in [BRAT](https://github.com/TfTHacker/obsidian42-brat).

### Usage

1. Enable the plugin, then open **Settings → Vault Force Sync**.
2. Set the **Remote URL** to your GitHub repository (e.g. `https://github.com/user/vault-backup.git`). Leave it empty to keep an existing `origin`.
3. Optionally set **Git location** (full path to the git binary), **Proxy**, **Branch**, and **Max file size**. Under **Sync scope**, add excluded folders or files, choose a sync-only whitelist, or adjust the dot/underscore name toggles.
4. Turn on **Auto sync every N minutes** if you want it to run without you.
5. Click the refresh icon in the ribbon, or run one of the commands:

| Command | What it does |
|---------|--------------|
| Sync vault with remote (pull + push) | Fetch, integrate what you're missing, push what you have. |
| Pull remote changes only | Fetch and integrate; never commits or pushes. Good for seeing what another device did first. |
| Show sync status | Branch, short SHA, how far ahead/behind, uncommitted file count. |
| Force push all data to remote | Commit + `git push --force-with-lease`, discarding the remote's commits. |
| Open sync log | View the last 300 lines of `sync.log`. |

### What the plugin writes to your system

- `<vault>/.gitignore` — **no longer created.** If an older version left the generated `.*` / `!/.gitignore` block, it is removed once and replaced with a short comment. Custom lines around it are preserved. The root `.gitignore` remains a normal repository control file.
- `<vault>/.git/info/exclude` — oversized files go in a marked, managed block so they do not slow every sync. The block is rewritten each run and released as soon as it stops applying; **anything you wrote in that file yourself is left untouched.** Sync-scope rules are deliberately *not* written here. Never committed.
- `refs/vault-force-sync/<timestamp>` in your local repository — a snapshot of the remote taken before a force push. Local only, never pushed; the last 5 are kept.
- Repo-local git config: `http.postBuffer`, and `http.proxy` / `https.proxy` **only if** you configured a proxy.
- `<config-dir>/plugins/vault-force-sync/sync.log` — the sync log.
- `<config-dir>/plugins/vault-force-sync/.askpass.sh` (or `.askpass.cmd` on Windows) — **only when a token is configured**. It reads the token from the environment rather than containing it, so no secret is written to disk. The plugin's own folder is a hard exclusion, so the helper stays untracked whatever your config folder is called, and it is safe to delete — it is rewritten on the next sync.

The config directory is `Vault#configDir`, which is `.obsidian` unless you renamed it. The plugin never assumes that name.

The plugin never rewrites your notes' content except by pulling remote changes and resolving a conflict you asked it to resolve — and even then it rolls back rather than leaving markers.

### Safety notes

The guarantees above are the load-bearing ones. These are the operational details around them.

- **Everything not filtered is committed and pushed.** The plugin stages with `git add -A` (or the selected folders), then removes paths rejected by the scope filter. Any file that survives that filter and is not covered by `.gitignore` or `.git/info/exclude` goes into the commit and reaches the remote. Keep secrets out of the vault, or ignore them — a token in a note is a token on GitHub.
- Two syncs never overlap: a trigger that arrives mid-run is dropped, not queued. Without this a timer and a manual click could race on the same index.
- Files larger than the limit are reported in a notice and skipped; everything else syncs normally.
- The plugin's own folder is always excluded, but the rest of the config folder is controlled by the dotfolder toggle. With dotfolders off, `.obsidian` can sync; per-device settings may then conflict between machines. Leave dotfolders on unless you mean to sync config.
- A public remote makes the whole vault public. If you are syncing somewhere anyone can read, check what is in there first.

### Settings reference

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
| Excluded folders | *(empty)* | Never staged or pushed. Folder-boundary matching, vault-relative. `.git`, `.trash`, and the plugin's own folder are always excluded. |
| Excluded files | *(empty)* | Never staged or pushed, matched by exact vault-relative path. Outranks Sync only these folders. |
| Sync only these folders | *(empty)* | Empty = whole vault. Otherwise only files under these folders are staged. Exclusions and name filters still win. |
| Exclude dot-prefixed (hidden) files | on | Files whose basename starts with `.`. On macOS/Linux this is the hidden-file rule; Windows hidden attributes are not inspected. |
| Exclude dot-prefixed (hidden) folders | on | Folders whose name starts with `.` and everything inside. `.git` and `.trash` remain excluded when off. |
| Exclude underscore-prefixed files | off | Files whose basename starts with `_`. |
| Exclude underscore-prefixed folders | off | Folders whose name starts with `_` and everything inside. |
| Max file size (MB) | `100` | Larger files are skipped. GitHub hard limit is 100 MB. |
| Show success notice | on | Notice after each successful sync. |
| Enable logging | on | Write sync results to `sync.log`. |

Settings appear in Obsidian's settings **search** on 1.13.0 and later; `display()` is still used on older versions. Both read the same table, so they cannot disagree about what settings exist.

### Development

There is no build step — `main.js` is the source, plain CommonJS, loaded directly by Obsidian.

```bash
node --check main.js   # syntax
sh tests/run.sh        # the whole suite, 82 checks
```

`tests/run.sh` needs nothing installed beyond Node and `git`:

| File | Covers | Checks |
|------|--------|--------|
| `tests/sync.test.js` | Two devices sharing one bare remote: local-only change, remote-only change (fast-forward), clean divergence, conflict rollback, rebase, force, an unresolved merge blocking the next run, re-entrancy | 8 |
| `tests/settings.test.js` | Declarative definitions and search index, read/write, path-list normalization, the folder and file pickers, validation, timer lifecycle, log-path resolution | 20 |
| `tests/credentials.test.js` | Credential resolution, missing/empty SecretStorage, the generated helper holding no token, git's own credential lookup, `configDir` shapes | 17 |
| `tests/safety.test.js` | Refusal when the vault is not its repository root (and that the project is left untouched), force-push backups and recovery, backup pruning, credentials in a remote URL, size-skip patterns being released, user lines in `.git/info/exclude` surviving | 15 |
| `tests/scope.test.js` | Folder-boundary matching, excluded folders, excluded files, sync-only lists and the rule that exclusions outrank them, independent dotfile/dotfolder and underscore file/folder toggles, legacy `.gitignore` migration, tracked-file and rename behavior | 22 |

These are not unit tests over a mocked git. A merge that silently conflicts, or a push that runs before the pull, is invisible to a stub — so every scenario creates real repositories, a real bare remote, and drives the real binary. The credential tests run `git credential fill` and assert on what git actually hands back. The safety tests build the exact nested-vault layout that makes the repository-root check necessary, and then assert the parent project was left byte-for-byte untouched.

One credential check also probes *this machine*: whether its own git helper answers for `github.com`. That depends on the laptop it runs on, not on the plugin, so when no stored credential exists the check reports `SKIP` with the reason — the assertions on the plugin's behaviour in that same check still run.

### License

[MIT](./LICENSE)

### Issues & Feedback

- GitHub Issues: <https://github.com/yanqingwang/github-vault-force-sync/issues>
- Email: wangyantsing@qq.com

When reporting an issue, please include your Obsidian version, the plugin version, a description or screenshot of the problem, and what you expected to happen.

---

## 中文

一个 [Obsidian](https://obsidian.md) 插件：调用系统 `git`，让整个 vault——或者只让你选择的那部分文件夹——与一个 GitHub 仓库保持同步。它是**双向**的——把另一台设备上的改动拉下来，把本机的改动推上去；只传上次同步以来的增量；需要时可以强推；超过 100 MB 的文件自动跳过，所以同步不会卡死；并且保留一份随时可看的本地日志。

笔记是这里唯一无法重新生成的东西，所以整个设计都围绕一条约束：**绝不让插件成为你丢失笔记的原因**。下文全部服从于这一点，详见[插件保证什么](#插件保证什么)。

### 插件保证什么

下面每一条都有测试覆盖，而且是拿**真实的 `git` 二进制**对着真实仓库跑的——因为每一条都是 git 面对某个真实目录结构时的实际行为，mock 一个 git 会把它们全部掩盖掉。

**仓库不是 vault 自己的，就拒绝动手。**
`git rev-parse --is-inside-work-tree` 对一个**嵌套在项目里**的 vault 同样返回真，而在子目录里执行 `git add -A` 暂存的是**整个仓库**，不是那个子目录。只看前者的插件，会提交并推送一个用户从未指向它的完整项目——连删除记录一起。所以 vault 必须是其仓库的**根**；否则直接拒绝，并把两个路径都摆出来，且在写入任何一个文件之前就停手。

**强推不会悄悄毁掉它覆盖掉的东西。**
任何一次 `--force-with-lease` 之前，先把远端当前状态存进一个本地 ref。`--force-with-lease` 防的是「远端在你不知情时动过了」，它**并不**让你刚丢弃的那些提交变得可恢复。现在可以了：

```bash
git -C <vault> for-each-ref refs/vault-force-sync/
git -C <vault> branch recovered refs/vault-force-sync/<时间戳>
```

保留最近 5 个，只在本地，从不推送。如果备份写不下来，这次强推会**中止**，而不是在没有保护的情况下继续。

**笔记里绝不会留下冲突标记。**
Obsidian 没有合并界面。发生冲突的同步会被回滚到开始前的状态，并列出冲突文件——所以无人值守的一轮同步不可能把 `<<<<<<<` 留在一个没人打开的笔记里。未解决的合并会**阻塞**下一次同步，而不会被提交进去。

**增量模式和自动模式从不覆盖远端。**
分叉由真正的 merge 或 rebase 整合。`--force-with-lease` 只出现在强制模式，或自动模式下远端严格落后时——而且即使在那里，远端一旦动过，lease 守卫也会拦住它。

**vault 自己的仓库之外，什么都不写。**
没有 `reset --hard`，没有 `git clean`，没有 `git stash`，没有 `checkout`。对你目录的写入只有[插件会往系统里写什么](#插件会往系统里写什么)列出的那些，而且每一个都能靠删掉一个文件来撤销。

**跳过大文件的规则不会活得比它的理由更久。**
超限文件会记在 `.git/info/exclude` 里，免得每轮同步都白白拖慢。那份清单每轮是**重写**而不是追加：把上限调高、文件变小、文件被删，规则就释放。追加式的清单会让那个文件永远进不了仓库，而屏幕上没有任何东西解释它为什么从没到过另一台设备。

**排除一个文件夹或一个文件，不会删掉已经跟踪的文件。**
已经跟踪的文件，无论你是排除了它所在的文件夹还是这个文件本身，都会留在仓库里；插件不再暂存它的修改，本地删除也会被撤下。把已跟踪文件移动进被排除文件夹时，只要 git 能把两边配对（rename，或同名的 add），就按移动处理，远端旧副本保留。真要从远端移除一个被排除的路径，必须显式执行 `git rm --cached` 再推送。

**token 不会落到磁盘上。**
它存在 Obsidian 的 SecretStorage 里，通过环境变量交给 git，绝不写进 `.git/config`、remote URL 或仓库。而一个**确实**内嵌了凭证的 remote URL 会被点出来——因为 git 会把那个 URL 原样存进 `.git/config`。

### 功能

- **双向同步**——一条命令（或一次定时触发）拉取远端、整合你缺的东西、推上去你有的东西。
- **一键同步**——侧边栏按钮和命令面板命令，都是完整的「拉 + 推」。
- **自动同步**——Obsidian 开着时每 *N* 分钟跑一次，也可以在启动后跑一次。`N = 0` 关闭定时器。
- **增量同步**——两个方向都只传上次同步以来的提交。
- **分叉是整合掉的，不是拒绝掉的。** 当另一台设备推了东西而本地也有改动时，远端的提交会被折进来（merge 或 rebase），你的提交落在上面。以前它会停下来说「先 pull」——你要么手工处理，要么按强制然后丢工作。
- **冲突时回滚，而不是把笔记搞坏。** Obsidian 没有合并界面，所以同一个笔记在两处都改过时，这一轮同步会被撤销并列出冲突文件。两种情况下你的笔记都保住内容。
- **三种推送模式**：

  | 模式 | 行为 |
  |------|------|
  | 增量 | 只做普通 `git push`。分叉通过整合远端解决；远端永不被覆盖。 |
  | 自动 | 普通推送；仅当远端严格落后于本地时才用 `--force-with-lease`（比如你改写过本地历史）。绝不覆盖已经分叉的远端提交。 |
  | 强制 | 总是 `git push --force-with-lease`。按你要求丢弃远端。 |

- **大文件守卫**——超过设定上限的文件（默认 100 MB，GitHub 的硬限制）通过 `.git/info/exclude` 跳过，让其余部分照常同步。那份清单每轮重写，所以调高上限文件就回来了。
- **强推可恢复**——强推前把远端状态快照进一个本地 ref，所以误按强制是可以撤销的。
- **同步范围控制**——可以排除指定文件夹或指定文件、只同步选中的文件夹，并分别控制点开头（隐藏）文件/文件夹、下划线开头文件/文件夹。文件夹按边界匹配，`Archive` 不会误伤 `Archive-old`；文件按完整路径精确匹配。排除项永远优先于「只同步」白名单。`.git`、`.trash` 和插件自己的文件夹始终排除。
- **不再生成 `.gitignore`**——旧的 `.*` 规则会自动迁移掉，所以重新打开点文件同步时真的会生效。范围规则改在暂存之后应用，这也让「把文件移动进被排除文件夹」可以按移动处理，而不是发布成旧路径的删除。
- **没有 credential helper 也能用**——机器上没配 `gh`/钥匙串/凭据管理器时，选一个 personal access token（存在 Obsidian 的 SecretStorage 里，不在 vault 中），插件就用它认证。
- **同步日志**——每一轮都记进 `sync.log`（仅本地，从不提交），可从命令面板或设置里查看。
- **可选代理**——网络需要的话，给 git 配一个 HTTP(S) 代理。

### 同步范围

这些控制项参考 Nextcloud 同步插件的文件夹与名称过滤，并针对 git 仓库做了调整：

| 控制项 | 作用 |
|--------|------|
| **排除文件夹** | 从不暂存、从不推送的文件夹。按 vault 相对路径做文件夹边界前缀匹配：`Archive` 覆盖 `Archive/**`，但不覆盖 `Archive-old` 或 `notes/Archive`。 |
| **排除文件** | 从不暂存、从不推送的单个文件，按 vault 相对路径精确匹配：`Inbox/secrets.md`。用 **Choose** 选取，或直接手输路径。文件夹不要写在这里——请写「排除文件夹」，它连里面的内容一起覆盖。 |
| **只同步这些文件夹** | 留空 = 整个 vault。设置后只暂存这些文件夹下的文件（以及根目录 `.gitignore` 这个控制文件），其余留在本地。排除文件夹、排除文件和名称开关仍然优先。 |
| **排除点开头（隐藏）文件** | 文件名以 `.` 开头的文件，例如 `.env`、`.DS_Store`。这是 macOS/Linux 上的隐藏文件规则；不检测 Windows 的隐藏属性。默认开。 |
| **排除点开头（隐藏）文件夹** | 名称以 `.` 开头的文件夹及其全部内容，例如 `.obsidian`、`.archive`。即使关闭，`.git` 和 `.trash` 仍然排除。默认开。 |
| **排除下划线开头文件** | 文件名以 `_` 开头的文件，例如 `_draft.md`、`_template.canvas`。默认关。 |
| **排除下划线开头文件夹** | 名称以 `_` 开头的文件夹及其全部内容。默认关。 |

四个名称开关互相独立：关掉点文件规则会同步 `.env`，但不会同步 `.obsidian`；关掉点文件夹规则会同步 `.obsidian/config.json`，但不会同步 `.env`。

根目录的 `.gitignore` 被视为仓库控制文件，在所有模式下都保持可同步。子目录里的 `.gitignore` 仍按普通隐藏文件规则处理。只有插件自己生成的那个块会自动迁移；你自己写的 `.*` 规则仍会让 git 忽略点文件，想让开关生效需要手工删掉那一行。

### 范围控制会做什么、不会做什么

范围控制决定的是**这台设备暂存和推送什么**，它不是历史重写，也不是下载过滤器：

- 排除某个文件夹时，**已经被跟踪**的文件会留在仓库里。它们的本地修改不再被推送，但插件不会自动从远端删除它们。确实要移除时：`git rm -r --cached -- <文件夹>`，然后让插件提交并推送这次删除。
- 这些未暂存的修改会让工作区变脏。之后拉取时如果远端也要改同一个文件，git 可能拒绝 merge 或 rebase；插件会报告这一点，绝不会丢弃你的修改。提交它、还原它，或者把该文件从仓库移除，才能继续拉取。
- 远端分支历史里已经存在的文件仍然会被拉下来。Git 合并的是历史，不是一个过滤后的视图。这台设备排除的文件夹，不会从另一台设备的克隆里消失。
- 把已跟踪文件**移动进**被排除文件夹时，只要 git 能配对（rename，或同名的 add），就按移动处理：远端旧副本保留，本地移动留在本地。把已跟踪文件**移出**被排除文件夹，会暂存新副本，同时仓库里的旧副本保留。
- 只同步模式下，移出的文件按同名配对；如果同时改了文件夹和文件名，可能看起来就是一次普通删除。
- Obsidian 的 `.trash` 是例外：把笔记移进回收站**就是删除**，所以已跟踪路径会在远端被删除；回收站里的副本本身永远不会被提交。
- 被排除的文件在暂存阶段仍然会被 `git add` 看到，随后由暂存后过滤器移除。这是刻意的：如果把目标路径藏进 `.git/info/exclude`，一次移动就会被看成删除。大文件仍由大小守卫在暂存前处理。

### 一轮同步是怎么跑的

顺序是刻意安排的：

```
暂存（git add -A，或只暂存选中的文件夹）→ 移除范围外路径 → 提交 → fetch → 整合远端 → 推送
```

**先提交，再整合。** `git rebase` 在有未暂存改动时会直接拒绝运行；而 merge 则不得不把我们刚做的提交拿去和远端解冲突。先暂存保证整合时**范围内**的工作区是干净的，本地改动作为一个整体被合并。范围外的修改会原样保留；如果它挡住了整合，插件会报告，而不是丢弃它。

**先整合，再推送。** 远端新增的东西先折进你的分支，你的提交就落在远端历史**之上**，而不是和它对抗。

**增量和自动模式下绝不强推。** 分叉由真正的 merge 或 rebase 解决。`--force-with-lease` 只用于强制模式，或自动模式下远端严格落后时（你的本地历史被改写过）。

### merge 还是 rebase？

| | Merge（默认） | Rebase |
|---|---|---|
| 历史 | 每轮同步一个合并提交 | 线性 |
| 已有提交 | 从不重写，所以远端上已有的东西绝不会变 | 只重放尚未推送的提交 |
| 冲突 | 每轮解一次 | 可能反复提问，每个重叠的提交各一次 |
| 适合 | 安全、共享远端 | 可读的备份历史 |

两者都可逆，且不冲突时都不碰笔记内容。

### 发生冲突时会怎样

如果你在两台设备上都改了 `note.md`，merge 会在文件里留下 `<<<<<<<` 标记。Obsidian 既不能显示也不能解决它，而一个没人打开的笔记会一直悄悄带着这些标记。所以：

- **自动回滚开启（默认）**——同步被回滚到开始前**逐字节一致**的状态，并在通知里列出冲突文件。本地提交保留，远端不动，你的笔记还是你写下的样子。
- **自动回滚关闭**——merge 留在原地由你手工解决。在解决之前同步保持暂停，所以标记绝不会被后续某轮提交进去。

两种情况下，未解决的合并都会**阻塞**下一次同步，而不是被提交。

### 环境要求

- Obsidian **桌面版**（插件使用 Node.js API，标注为 `isDesktopOnly`）。
- 已安装 `git` 且可访问（在 `PATH` 里，或在设置里填完整路径）。
- 你的 vault 必须**是**一个 git 仓库——它自己的仓库，且 vault 位于仓库根。还没有仓库的话，在 vault 里跑一次 `git init`，插件随后会替你配好 `origin`。仅仅**位于**另一个仓库**内部**的 vault 会被拒绝：同步它会发布那整个项目，而不只是这个 vault。
- 一个用于同步的 GitHub 仓库，且推送权限已配好（HTTPS 配 credential helper，或 SSH——你本地 git 现在能用的那种就行）。

### 认证

插件是调用系统 `git` 的，所以**默认就用那套 git 已经在用的凭证**——`gh auth login`、macOS 钥匙串、Git Credential Manager、libsecret、SSH remote，什么都行。无需配置，而且除非你启用下一段，否则一直走这条路。

它补上的那个洞是：git 在这里**没有终端**，弹不出登录框。在没配 credential helper 的机器上，同步只会失败，并在日志里留一行认证错误。针对这种情况，设置 → 凭证 里可以选一个 **personal access token**：

- token 存在 [Obsidian 的 SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage) 里，**不是**插件的 `data.json`。设置里只保存 secret 的**名字**。
- 它通过生成的 askpass helper、走子进程环境变量交给 git。绝不写进 `.git/config`，绝不进 remote URL，也绝不进这个仓库。
- 选择 token 时，会**为那一条命令**清空 git 的 credential helper 列表，确保用的是你选的那个 token。否则本机缓存的凭证会被先试到并悄悄胜出，让这个设置看起来像坏的。
- 留空则行为完全不变。

在 GitHub → Settings → Developer settings → Personal access tokens 创建 token，classic 需要 `repo` 权限范围，fine-grained 需要对该仓库的读/写 **Contents** 权限。GitHub 账号密码是不行的：GitHub 自 2021 年 8 月起就不再接受用密码做 Git 操作了。

> **注意**——*Git username* 一栏只在配了 token 时才用到，而且 GitHub 在 HTTPS 下完全忽略它，真正认证的是 token。除非你的托管方要求真实用户名，否则保持占位值即可。

### 查看当前在用哪个账号

```bash
gh auth status                 # 如果你用 GitHub CLI
git -C <vault> config --get-all credential.helper
git -C <vault> remote -v
```

### 安装

### 从社区插件目录

> 尚未上架——插件正在提交审核。在它出现在社区目录之前，请用下面的手动安装或 BRAT。

### 手动安装

1. 从[最新 release](https://github.com/yanqingwang/github-vault-force-sync/releases) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 创建 `<vault>/.obsidian/plugins/vault-force-sync/`，把三个文件拷进去。
3. 重载 Obsidian，在 设置 → 第三方插件 里启用 **Vault Force Sync**。

### 用 BRAT 做 beta 测试

在 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 里把 `yanqingwang/github-vault-force-sync` 添加为 beta 插件。

### 使用

1. 启用插件，然后打开 **设置 → Vault Force Sync**。
2. 把 **Remote URL** 设成你的 GitHub 仓库（例如 `https://github.com/user/vault-backup.git`）。留空则保留已有的 `origin`。
3. 可选地设置 **Git location**（git 可执行文件的完整路径）、**代理**、**分支**、**最大文件大小**。在 **同步范围** 里可以排除文件夹或单个文件、设置只同步的白名单，或调整点/下划线名称开关。
4. 想让它自己跑，就打开 **每 N 分钟自动同步**。
5. 点侧边栏的刷新图标，或运行下列命令之一：

| 命令 | 作用 |
|------|------|
| Sync vault with remote（拉 + 推） | fetch、整合你缺的、推送你有的。 |
| Pull remote changes only | 只 fetch 和整合；从不提交或推送。适合先看看另一台设备做了什么。 |
| Show sync status | 分支、短 SHA、领先/落后多少、未提交文件数。 |
| Force push all data to remote | 提交 + `git push --force-with-lease`，丢弃远端提交。 |
| Open sync log | 查看 `sync.log` 最后 300 行。 |

### 插件会往系统里写什么

- `<vault>/.gitignore`——**不再创建。** 如果旧版本留下过 `.*` / `!/.gitignore` 块，会迁移一次并替换成一段简短注释；块周围你自己写的行原样保留。根目录 `.gitignore` 仍然是普通的仓库控制文件。
- `<vault>/.git/info/exclude`——超限文件记在一个带标记、由插件管理的块里，免得每轮同步都变慢。该块每轮重写，一旦不再适用就释放；**你自己在这个文件里写的内容原封不动。** 同步范围规则**刻意不写在这里**。从不提交。
- 本地仓库里的 `refs/vault-force-sync/<时间戳>`——强推前对远端做的快照。仅本地，从不推送；保留最近 5 个。
- 仓库内的 git 配置：`http.postBuffer`，以及**仅在你配置了代理时**的 `http.proxy` / `https.proxy`。
- `<配置目录>/plugins/vault-force-sync/sync.log`——同步日志。
- `<配置目录>/plugins/vault-force-sync/.askpass.sh`（Windows 上是 `.askpass.cmd`）——**仅在配置了 token 时**。它从环境变量读取 token 而不是把 token 写在自己里面，所以磁盘上没有机密。插件自己的文件夹是硬排除项，所以无论你的配置目录叫什么，它都不会被跟踪；它也可以随手删掉——下次同步会重写。

配置目录就是 `Vault#configDir`，除非你改过名，否则是 `.obsidian`。插件从不假定这个名字。

除了拉取远端改动、以及解决你要求它解决的冲突之外，插件从不改写你笔记的内容——而且即使是后者，它也是回滚，而不是留下标记。

### 安全说明

上面那些保证是承重的。这里是围绕它们的操作细节。

- **没被过滤掉的东西都会被提交并推送。** 插件用 `git add -A`（或只暂存选中的文件夹），然后移除被范围过滤拒绝的路径。任何通过过滤、且没被 `.gitignore` 或 `.git/info/exclude` 覆盖的文件都会进提交并到达远端。机密别放进 vault，或者把它忽略掉——笔记里的 token 就是 GitHub 上的 token。
- 两次同步绝不重叠：同步进行中到来的触发会被**丢弃**而不是排队。没有这个，定时器和手动点击会并发跑在同一个 index 上。
- 超过上限的文件会以通知形式报告并跳过；其余一切照常同步。
- 插件自己的文件夹始终排除，但配置目录的其余部分由点文件夹开关控制。关掉点文件夹后 `.obsidian` 会同步，每台设备各自的设置可能在机器之间冲突。除非你确实想同步配置，否则保持点文件夹排除。
- **公开仓库会让整个 vault 公开。** 如果你同步到任何人都能读的地方，先确认里面有什么。

### 设置参考

| 设置 | 默认值 | 说明 |
|------|--------|------|
| Remote URL | *（空）* | 同步目标，作为 git `origin` 保留。留空 = 保留现有 origin。 |
| Branch | `main` | 要同步的远端分支。 |
| Git location | *（空）* | git 的完整路径。留空 = 用 `PATH` 里的 git。 |
| 代理 | *（空）* | git 用的 HTTP(S) 代理，例如 `http://127.0.0.1:7890`。留空 = 不用代理。 |
| Personal access token | *（空）* | 可选。留空 = 用本机 git 的凭证。选了 secret 则改用该 token 认证。存在 SecretStorage，不在 `data.json` 里。 |
| Git username | *（空）* | 仅在配了 token 时使用。GitHub 在 HTTPS 下忽略它；留空则用一个占位值。 |
| 同步模式 | 增量 | 见上面的推送模式。 |
| 如何整合远端改动 | Merge | `merge` 或 `rebase`。仅当远端有你没有的提交时才用到。 |
| 冲突时自动回滚 | 开 | 把发生冲突的同步回滚并报告，而不是把 merge 留在原地。 |
| 每 N 分钟自动同步 | `5` | 定时拉 + 推。`0` = 关闭。 |
| 启动时自动同步 | 关 | Obsidian 启动后不久跑一次完整同步。 |
| 排除文件夹 | *（空）* | 从不暂存、从不推送。按 vault 相对路径做文件夹边界匹配。`.git`、`.trash` 和插件自己的文件夹始终排除。 |
| 排除文件 | *（空）* | 从不暂存、从不推送，按 vault 相对路径精确匹配。优先于「只同步这些文件夹」。 |
| 只同步这些文件夹 | *（空）* | 留空 = 整个 vault。否则只暂存这些文件夹下的文件（以及根目录 `.gitignore`）。排除项和名称过滤仍然优先。 |
| 排除点开头（隐藏）文件 | 开 | 文件名以 `.` 开头。macOS/Linux 上就是隐藏文件规则；不检测 Windows 隐藏属性。 |
| 排除点开头（隐藏）文件夹 | 开 | 名称以 `.` 开头的文件夹及其全部内容。关闭时 `.git` 和 `.trash` 仍然排除。 |
| 排除下划线开头文件 | 关 | 文件名以 `_` 开头。 |
| 排除下划线开头文件夹 | 关 | 名称以 `_` 开头的文件夹及其全部内容。 |
| 最大文件大小（MB） | `100` | 更大的文件会被跳过。GitHub 的硬限制是 100 MB。 |
| 成功时显示通知 | 开 | 每次成功同步后弹一个通知。 |
| 启用日志 | 开 | 把同步结果写进 `sync.log`。 |

在 Obsidian 1.13.0 及以后，设置会出现在设置的**搜索**里；更老的版本仍走 `display()`。两条路径读同一张表，所以它们不可能对「有哪些设置」产生分歧。

### 开发

没有构建步骤——`main.js` 就是源码，手写的 CommonJS，由 Obsidian 直接加载。

```bash
node --check main.js   # 语法检查
sh tests/run.sh        # 全部测试，82 项
```

`tests/run.sh` 除了 Node 和 `git` 之外不需要安装任何东西：

| 文件 | 覆盖内容 | 项数 |
|------|----------|------|
| `tests/sync.test.js` | 共享一个裸远端的两台设备：仅本地改、仅远端改（fast-forward）、干净分叉、冲突回滚、rebase、强制、未解决 merge 阻塞下一轮、重入 | 8 |
| `tests/settings.test.js` | 声明式定义与搜索索引、读写、路径列表归一化、文件夹与文件选择器、校验、定时器生命周期、日志路径解析 | 20 |
| `tests/credentials.test.js` | 凭证解析、SecretStorage 缺失/为空、生成的 helper 不含 token、git 自己的凭证获取、`configDir` 的各种形态 | 17 |
| `tests/safety.test.js` | vault 不是其仓库根时拒绝（并验证那个项目未被改动）、强推备份与恢复、备份清理、remote URL 内嵌凭证、大小跳过规则的释放、`.git/info/exclude` 里用户自己的行不被破坏 | 15 |
| `tests/scope.test.js` | 文件夹边界匹配、排除文件夹、排除文件、只同步列表以及「排除优先于选择」这条规则、点文件/点文件夹与下划线文件/文件夹独立开关、旧 `.gitignore` 迁移、已跟踪文件与 rename 行为 | 22 |

这些不是对着 mock git 写的单元测试。一个悄悄冲突了的 merge，或者一个跑在 pull 之前的 push，对 stub 来说都是不可见的——所以每个场景都创建真实仓库、真实的裸远端，并驱动真实的二进制。凭证测试会跑 `git credential fill`，对 git 实际交回来的东西做断言。安全测试会构造出那个让「仓库根检查」成为必需的真实嵌套 vault 布局，然后断言父项目逐字节未被改动。

有一项凭证测试探测的是*本机*：这台机器的 git helper 能不能答出 `github.com` 的凭证。这取决于跑测试的那台电脑，与插件无关，所以本机没有存过凭证时，这一项会报 `SKIP` 并说明原因——同一项里针对插件行为的断言照旧执行。

### 许可证

[MIT](./LICENSE)

### 问题与反馈

- GitHub Issues：<https://github.com/yanqingwang/github-vault-force-sync/issues>
- 邮箱：wangyantsing@qq.com

反馈时请尽量附上：Obsidian 版本、插件版本、问题描述或截图、预期结果。
