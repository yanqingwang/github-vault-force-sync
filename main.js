// Vault Force Sync — two-way sync between the vault and a GitHub remote.
//
// Desktop only. Uses the system `git` (must be on PATH).
// Conventions:
//   - runs inside the vault repo (the vault itself is the git work tree)
//   - writes `.gitignore` (.* / !/.gitignore) so dotfiles never get tracked
//   - optionally configures an HTTP(S) proxy + large http.postBuffer for big pushes
//   - one sync is: stage -> commit -> fetch -> integrate remote -> push. Only
//     the delta since the last sync moves, in both directions.
//   - logs every sync run to `<vault>/.obsidian/plugins/vault-force-sync/sync.log`
//     (local only — `.obsidian` is gitignored), viewable via the "Open sync log"
//     command or the button in settings.
//
// Why commit *before* integrating: `git rebase` refuses to run with unstaged
// changes, and a merge would otherwise have to resolve our own brand-new commit
// against the remote. Staging first means the tree is clean by the time we
// integrate, and the local change is rebased/merged as a whole unit.
//
// Push modes:
//   incremental : normal `git push` only; never overwrite remote. Divergence is
//                 resolved by integrating the remote, not by discarding it.
//   auto        : normal push; auto force-with-lease only when remote is
//                 strictly behind local (local history rewritten). Never
//                 overwrites diverged remote commits.
//   force       : always `git push --force-with-lease`.
//
// Integration strategies (only reached in incremental/auto mode):
//   merge  : `git merge origin/<branch>`. Keeps existing commit hashes, so
//            nothing already on the remote is ever rewritten. One conflict to
//            resolve per sync round.
//   rebase : `git rebase origin/<branch>`. Linear history, nicer to read in a
//            backup repo. Only local (not yet pushed) commits are replayed.

const {
  Plugin,
  Notice,
  PluginSettingTab,
  Setting,
  Modal,
  // Arrived in Obsidian 1.11.4. `undefined` on anything older, which the
  // credentials row checks before trying to render it.
  SecretComponent,
} = require("obsidian");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const GIT_TIMEOUT_MS = 300000;
const POST_BUFFER = "524288000";
const LOG_MAX_BYTES = 1024 * 1024; // rotate when the log exceeds 1 MB
const LOG_MAX_LINES = 500;         // keep this many lines when rotating
const LOG_VIEW_LINES = 300;        // lines shown in the log viewer

const PUSH_MODES = {
  incremental: "Incremental (default)",
  auto: "Auto (force only when safe)",
  force: "Always force",
};

// How the remote is brought into the local branch. Never used in `force` mode,
// where the point is to discard the remote instead.
const SYNC_STRATEGIES = {
  merge: "Merge (default, safest)",
  rebase: "Rebase (linear history)",
};

const DEFAULT_SETTINGS = {
  remoteUrl: "",
  gitLocation: "",
  proxy: "",
  branch: "main",
  pushMode: "incremental",
  syncStrategy: "merge",
  autoSyncOnLoad: false,
  // 0 disables the timer. 5 keeps a vault reasonably current, and every run is
  // guarded against overlapping the one before it.
  autoSyncIntervalMin: 5,
  // Obsidian has no merge UI. Leaving `<<<<<<<` markers sitting in notes that
  // nobody opens is the worst outcome, so a conflicted sync is rolled back to
  // the pre-sync state and reported. Nothing is lost: local commits stay put and
  // the remote is never touched.
  autoAbortConflicts: true,
  // Optional explicit credentials. Empty means "whatever this machine's git
  // already uses", which is the shipped default and the only path that existed
  // before these two keys were added.
  credentialUsername: "",
  credentialSecretId: "",
  showSuccessNotice: true,
  enableLogging: true,
  maxFileSizeMB: 100,
};

// Git calls an askpass program with the prompt as its only argument and reads the
// answer from stdout.
//
// The credential travels in the environment instead of being written into these
// files, so generating them leaves no token on disk. That is the whole reason a
// helper is needed at all: `GIT_ASKPASS` has to be a path, but nothing requires
// the secret to live at it.
const ASKPASS_POSIX = [
  "#!/bin/sh",
  "# Written by Vault Force Sync. Safe to delete: it is rewritten on every sync.",
  "# The credential comes from the environment, so no token is stored here.",
  'case "$1" in',
  "  *sername*) printf '%s\n' \"$VFS_GIT_USERNAME\" ;;",
  "  *)         printf '%s\n' \"$VFS_GIT_TOKEN\" ;;",
  "esac",
  "",
].join("\n");

// The batch version echoes the variables, so a token containing cmd metacharacters
// (& ^ |) would be mangled. GitHub's own tokens are alphanumeric plus underscore,
// which is the case this exists for, so the extra quoting machinery is not earned.
const ASKPASS_WINDOWS = [
  "@echo off",
  "REM Written by Vault Force Sync. Safe to delete: it is rewritten on every sync.",
  "REM The credential comes from the environment, so no token is stored here.",
  'echo %~1 | findstr /I "sername" >nul',
  "if errorlevel 1 (echo %VFS_GIT_TOKEN%) else (echo %VFS_GIT_USERNAME%)",
  "",
].join("\r\n");

// How many force-push backups to keep. Each one pins the commits it points at,
// so the list has to stay bounded.
const MAX_FORCE_BACKUPS = 5;

// Markers around the size-skip list inside `.git/info/exclude`. The block is
// rewritten from scratch on every sync; anything the user wrote around it is
// left exactly as it was.
const EXCLUDE_BEGIN = "# vault-force-sync: files over the size limit are skipped (managed)";
const EXCLUDE_END = "# vault-force-sync: end";

// `.git/info/exclude` is local to the clone and never committed, which is why the
// size-skip list lives there instead of in `.gitignore`.
//
// Splits the file into what came before our block, the block itself, and what
// came after. An unterminated block (hand-edited) is treated as ours to the end.
function splitManagedExclude(text) {
  const before = [];
  const managed = [];
  const after = [];
  let inside = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (t === EXCLUDE_BEGIN) {
      inside = true;
      continue;
    }
    if (inside) {
      if (t === EXCLUDE_END) {
        inside = false;
        continue;
      }
      if (t && !t.startsWith("#")) managed.push(t);
      continue;
    }
    before.push(line);
  }
  return { before, managed, after };
}

// Two directories, tolerating symlinks, trailing separators and (on Windows)
// case -- so a legitimate vault is never refused as "the wrong repository".
function samePath(a, b) {
  const norm = (p) => {
    let out;
    try {
      out = fs.realpathSync(p);
    } catch (_) {
      out = path.resolve(p);
    }
    out = path.normalize(out).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? out.toLowerCase() : out;
  };
  return norm(a) === norm(b);
}

// `https://user@host` is a bare username and harmless. `https://user:secret@host`
// is not: git copies the whole URL into `.git/config` verbatim.
function looksLikeUrlCredentials(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/@\s]*)@/i.exec(String(url || "").trim());
  return !!m && m[1].includes(":");
}

const GITIGNORE_CONTENT = [
  "# Vault Force Sync: exclude dotfiles / hidden files",
  ".*",
  "!/.gitignore",
].join("\n") + "\n";

// Obsidian's `Setting.onChange` / `Button.onClick` declare `=> void`. Handing them an
// `async` arrow passes a promise nobody awaits, so a rejected save becomes an
// unhandled rejection: the user clicks, nothing appears to happen, and the setting
// silently reverts on the next launch. This keeps the body async but makes the arrow
// synchronous, and turns a rejected save into a Notice.
function fire(body) {
  return function () {
    let out;
    try {
      out = body.apply(null, arguments);
    } catch (err) {
      reportFailure(err);
      return;
    }
    if (out && typeof out.catch === "function") out.catch(reportFailure);
  };
}

function reportFailure(err) {
  new Notice("Vault Force Sync: " + (err && err.message ? err.message : String(err)), 8000);
  console.error("[Vault Force Sync]", err);
}

function getVaultPath(app) {
  const adapter = app.vault.adapter;
  if (adapter && typeof adapter.getBasePath === "function") {
    return adapter.getBasePath();
  }
  return null;
}

// Absolute path to this plugin's own folder.
//
// `Vault#configDir` is the config folder's *name*, not a path -- Obsidian's own
// docs call it "the path to the config folder. This value is typically .obsidian".
// `fs` resolves a relative path against `process.cwd()`, which is the Obsidian
// install directory and not the vault, so the two must be joined before any `fs`
// call sees it. An already-absolute `configDir` is passed through untouched, so
// either shape lands in the right place.
function configDirPath(app, vaultPath) {
  const configDir = app && app.vault && app.vault.configDir;
  if (!configDir) return null;
  if (path.isAbsolute(configDir)) return configDir;
  if (!vaultPath) return null;
  return path.join(vaultPath, configDir);
}

function pluginDir(app) {
  const base = configDirPath(app, getVaultPath(app));
  return base ? path.join(base, "plugins", "vault-force-sync") : null;
}

function runGit(cwd, gitBin, args, env) {
  return new Promise((resolve) => {
    const options = {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
    };
    // Left unset when there is nothing to inject, so git inherits the ambient
    // environment exactly as it always has.
    if (env) options.env = env;
    execFile(
      gitBin,
      args,
      options,
      (error, stdout, stderr) => {
        // Non-zero exit (e.g. `diff --cached --quiet`) is a normal signal,
        // not a crash. Only unexpected conditions become fatal.
        let code = 0;
        if (error) {
          if (typeof error.code === "number") {
            code = error.code;
          } else {
            code = -1; // ENOENT / ETIMEDOUT / ...
          }
        }
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Log viewer modal
// ---------------------------------------------------------------------------

class SyncLogViewerModal extends Modal {
  constructor(app, logPath) {
    super(app);
    this.logPath = logPath;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vault-force-sync-log");

    contentEl.createEl("h3", { text: "Vault Force Sync — sync log" });
    const meta = contentEl.createEl("div", { cls: "vault-force-sync-log-meta" });
    meta.setText("File: " + this.logPath);

    const pre = contentEl.createEl("pre", { cls: "vault-force-sync-log-pre" });
    try {
      const text = fs.readFileSync(this.logPath, "utf8");
      const lines = text.split(/\r?\n/).filter(Boolean);
      const shown = lines.length > LOG_VIEW_LINES ? lines.slice(-LOG_VIEW_LINES) : lines;
      pre.setText(shown.length ? shown.join("\n") : "(empty log)");
    } catch (err) {
      pre.setText("(no log entries yet — run a sync first)");
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class VaultForceSyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Guards every sync entry point (ribbon, commands, timer). Two concurrent
    // syncs would race on the same index and can leave a half-applied merge
    // behind, so a trigger arriving mid-run is dropped rather than queued.
    this.syncing = false;
    this.syncTimer = null;

    this.addCommand({
      id: "sync",
      name: "Sync vault with remote (pull + push)",
      callback: () => this.runSync(),
    });

    this.addCommand({
      id: "pull",
      name: "Pull remote changes only",
      callback: () => this.runPull(),
    });

    this.addCommand({
      id: "status",
      name: "Show sync status",
      callback: () => this.runStatus(),
    });

    this.addCommand({
      id: "force-sync",
      name: "Force push all data to remote",
      callback: () => this.runSync("force"),
    });

    this.addCommand({
      id: "open-log",
      name: "Open sync log",
      callback: () => this.openLog(),
    });

    this.addRibbonIcon("refresh-cw", "Vault Force Sync", () => this.runSync());

    this.addSettingTab(new VaultForceSyncSettingTab(this.app, this));

    if (this.settings.autoSyncOnLoad) {
      this.app.workspace.onLayoutReady(() => {
        setTimeout(() => this.runSync(), 3000);
      });
    }

    this.startTimer();
  }

  onunload() {
    this.stopTimer();
  }

  // Periodic sync. The handle is swapped rather than reconfigured, because the
  // settings tab calls this after every change and replacing it is the only way
  // to be sure the previous interval was actually cleared.
  startTimer() {
    this.stopTimer();
    const mins = Math.max(0, parseInt(this.settings.autoSyncIntervalMin, 10) || 0);
    if (mins === 0) return;
    this.syncTimer = setInterval(() => this.runSync(), mins * 60 * 1000);
    this.log(`auto sync timer armed: every ${mins} min`);
  }

  stopTimer() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Migrate the old boolean setting to the new push-mode enum.
    if (this.settings.pushMode === undefined) {
      this.settings.pushMode = this.settings.forcePush === false ? "incremental" : "force";
      delete this.settings.forcePush;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // The log lives in the plugin's own folder, which sits under the vault's config
  // directory -- and that directory is not necessarily called `.obsidian`, since the
  // user can point Obsidian anywhere. Hard-coding the name puts the log somewhere the
  // vault never looks, and "Open sync log" then reports an empty file.
  getLogPath() {
    const dir = pluginDir(this.app);
    return dir ? path.join(dir, "sync.log") : null;
  }

  log(message) {
    if (!this.settings.enableLogging) return;
    const logPath = this.getLogPath();
    if (!logPath) return;
    try {
      const ts = new Date().toLocaleString("zh-CN", { hour12: false });
      const clean = String(message).replace(/[\r\n]+/g, " | ").trim();
      const line = `[${ts}] ${clean}\n`;
      fs.appendFileSync(logPath, line, "utf8");
      this.rotateLog(logPath);
    } catch (err) {
      console.error("[Vault Force Sync] failed to write log:", err);
    }
  }

  rotateLog(logPath) {
    try {
      if (fs.statSync(logPath).size <= LOG_MAX_BYTES) return;
      const text = fs.readFileSync(logPath, "utf8");
      const lines = text.split(/\r?\n/).filter(Boolean);
      if (lines.length > LOG_MAX_LINES) {
        fs.writeFileSync(logPath, lines.slice(-LOG_MAX_LINES).join("\n") + "\n", "utf8");
      } else {
        fs.writeFileSync(logPath, "", "utf8");
      }
    } catch (_) {
      /* ignore rotation errors */
    }
  }

  clearLog() {
    const logPath = this.getLogPath();
    if (!logPath) return;
    try {
      if (fs.existsSync(logPath)) fs.writeFileSync(logPath, "", "utf8");
      this.notify("Log cleared.");
    } catch (err) {
      this.notify("Could not clear log: " + err.message, true);
    }
  }

  openLog() {
    const logPath = this.getLogPath();
    if (!logPath) {
      this.notify("Could not determine log path (desktop only).", true);
      return;
    }
    new SyncLogViewerModal(this.app, logPath).open();
  }

  notify(message, error = false) {
    if (error) {
      new Notice("Vault Force Sync: " + message, 8000);
      console.error("[Vault Force Sync]", message);
    } else if (this.settings.showSuccessNotice) {
      new Notice("Vault Force Sync: " + message, 5000);
    }
  }

  report(message, error = false, secs) {
    this.log(`${error ? "ERROR" : "OK"} | ${message}${secs ? ` | ${secs}s` : ""}`);
    this.notify(message, error);
  }

  // True when git is part-way through a merge/rebase it could not finish.
  // Committing or integrating on top of that state would bake conflict markers
  // into the vault's history, so every sync refuses to run until it is resolved
  // or aborted.
  async integrationInProgress(vaultPath) {
    const head = await this.git(vaultPath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    if (head.code === 0) return "merge";
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      if (fs.existsSync(path.join(vaultPath, ".git", dir))) return "rebase";
    }
    return null;
  }

  async conflictedFiles(vaultPath) {
    const res = await this.git(vaultPath, ["diff", "--name-only", "--diff-filter=U"]);
    if (res.code !== 0) return [];
    return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  // Fold the remote branch into the local one.
  //
  // This is the piece that makes sync two-way. In incremental/auto mode it is
  // the *only* way divergence is ever resolved -- the alternative the plugin
  // used to offer was refusing to sync until the user went and pulled by hand.
  // Returns true when the tree is ready to push.
  async integrateRemote(vaultPath, branch, mode) {
    const strategy = this.settings.syncStrategy === "rebase" ? "rebase" : "merge";

    // `force` exists to discard the remote, so integrating would defeat it.
    if (mode === "force") {
      this.log("force mode: skipping remote integration");
      return true;
    }

    const args =
      strategy === "rebase"
        ? ["rebase", `origin/${branch}`]
        : ["merge", "--no-edit", `origin/${branch}`];

    const res = await this.git(vaultPath, args);
    if (res.code === 0) {
      this.log(`integrated remote via ${args[0]} ${args.slice(1).join(" ")}`);
      return true;
    }

    const files = await this.conflictedFiles(vaultPath);
    const kind = await this.integrationInProgress(vaultPath);

    // A non-zero exit with nothing left in progress means git refused for some
    // other reason (dirty tree, bad ref). Do not pretend it was a conflict.
    if (!kind) {
      this.report("Could not integrate remote " + branch + ": " + res.stderr.trim(), true);
      return false;
    }

    if (this.settings.autoAbortConflicts) {
      const abortArgs = kind === "rebase" ? ["rebase", "--abort"] : ["merge", "--abort"];
      await this.git(vaultPath, abortArgs);
      this.log(`aborted ${kind} after conflict on ${files.length} file(s)`);
      const preview = files.slice(0, 8).join(", ") + (files.length > 8 ? " …" : "");
      this.report(
        `Remote ${branch} changed the same notes you did (${files.length} conflict(s)). ` +
          `Nothing was overwritten — the sync was rolled back and your local notes are untouched. ` +
          `Conflicting: ${preview}. ` +
          `Resolve them by hand and commit, or set "Auto-abort sync conflicts" off to stop here and resolve interactively.`,
        true
      );
      return false;
    }

    const preview = files.slice(0, 8).join(", ") + (files.length > 8 ? " …" : "");
    this.report(
      `Sync stopped: ${kind} conflict on ${files.length} note(s): ${preview}. ` +
        `Finish or abort it with git in this vault, then sync again.`,
      true
    );
    return false;
  }

  // Count how far local and remote have drifted. Returns null when the remote
  // branch does not exist yet (a fresh repo), which is a different situation
  // rather than an error.
  async divergence(vaultPath, branch) {
    const ahead = await this.git(vaultPath, ["rev-list", "--count", `origin/${branch}..HEAD`]);
    const behind = await this.git(vaultPath, ["rev-list", "--count", `HEAD..origin/${branch}`]);
    if (ahead.code !== 0 || behind.code !== 0) {
      return { error: (ahead.stderr + behind.stderr).trim() };
    }
    return { ahead: parseInt(ahead.stdout, 10) || 0, behind: parseInt(behind.stdout, 10) || 0 };
  }

  async runSync(forceMode) {
    if (this.syncing) {
      this.log("sync skipped: another sync is already running");
      return;
    }
    this.syncing = true;

    const start = Date.now();
    const mode = forceMode || this.settings.pushMode;
    this.log(`=== sync start | mode=${mode} | target=${this.settings.remoteUrl || "origin (existing)"} ===`);
    try {
      const vaultPath = getVaultPath(this.app);
      if (!vaultPath) {
        this.report("Could not determine vault path (desktop only).", true);
        return;
      }

      const busy = await this.integrationInProgress(vaultPath);
      if (busy) {
        this.report(
          `A ${busy} from a previous sync is still unresolved, so nothing was touched. ` +
            `Finish it with git in this vault, or run "git ${busy === "merge" ? "merge" : "rebase"} --abort".`,
          true
        );
        return;
      }

      // The vault has to *be* the repository, not merely sit inside one. See
      // wrongRepoReason() for why that distinction is worth refusing over.
      //
      // Checked before anything is written, including .gitignore: refusing has to
      // leave the directory exactly as it was found.
      const wrongRepo = await this.wrongRepoReason(vaultPath);
      if (wrongRepo) {
        this.report(wrongRepo, true);
        return;
      }

      this.ensureGitignore(vaultPath);

      // Keep the sync target (remote URL) pointing at the configured repo.
      await this.ensureRemote(vaultPath);

      // Keep the proxy + post-buffer config in the repo so this plugin and
      // other git-based plugins can reach GitHub through restricted networks.
      if (this.settings.proxy) {
        await this.git(vaultPath, ["config", "http.proxy", this.settings.proxy]);
        await this.git(vaultPath, ["config", "https.proxy", this.settings.proxy]);
      }
      await this.git(vaultPath, ["config", "http.postBuffer", POST_BUFFER]);

      // Prevent files over the size limit from being committed/pushed,
      // then stage everything; .gitignore keeps dotfiles / hidden files out.
      await this.excludeLargeFiles(vaultPath);
      await this.git(vaultPath, ["add", "-A"]);

      const staged = await this.git(vaultPath, ["diff", "--cached", "--quiet"]);
      if (staged.code === 1) {
        const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
        await this.git(vaultPath, ["commit", "-m", "sync: " + stamp]);
        this.log(`committed ${stamp}`);
      } else if (staged.code !== 0) {
        this.report("Failed to inspect staged changes: " + staged.stderr.trim(), true);
        return;
      }

      const branch = this.settings.branch;

      // Fetch remote state so we can decide how to push (delta vs force).
      const fetchRes = await this.git(vaultPath, ["fetch", "origin", branch]);
      const refRes = await this.git(vaultPath, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
      const remoteExists = refRes.code === 0;
      if (fetchRes.code !== 0 && remoteExists) {
        this.report("Fetch failed: " + fetchRes.stderr.trim(), true);
        return;
      }

      const secs = ((Date.now() - start) / 1000).toFixed(1);

      if (!remoteExists) {
        // Remote branch does not exist yet (fresh repo) — plain push creates it.
        this.log(`remote branch ${branch} does not exist yet`);
        await this.push(vaultPath, ["push", "-u", "origin", branch], mode, secs);
        return;
      }

      const d = await this.divergence(vaultPath, branch);
      if (d.error !== undefined) {
        this.report("Could not compare with remote: " + d.error, true);
        return;
      }
      const aheadN = d.ahead;
      const behindN = d.behind;
      this.log(`ahead=${aheadN} behind=${behindN}`);

      // The two-way step. Whatever the remote gained is folded into the local
      // branch before anything is uploaded, so local commits are pushed on top
      // of remote history rather than against it.
      if (behindN > 0 && mode !== "force") {
        const clean = await this.integrateRemote(vaultPath, branch, mode);
        if (!clean) return;

        // Re-read: integrating may have introduced commits that also need pushing.
        const after = await this.divergence(vaultPath, branch);
        if (after.error !== undefined) {
          this.report("Pulled, but could not re-check divergence: " + after.error, true);
          return;
        }
        if (after.ahead === 0) {
          this.report(
            `Pulled ${behindN} commit(s) from origin/${branch}. Nothing to push.`,
            false,
            secs
          );
          return;
        }
        await this.push(vaultPath, ["push", "origin", branch], mode, secs, `pulled ${behindN}`);
        return;
      }

      if (behindN > 0 && aheadN > 0) {
        // Diverged and `force` was chosen: overwrite the remote by request.
        await this.push(vaultPath, ["push", "--force-with-lease", "origin", branch], mode, secs);
        return;
      }

      if (behindN > 0) {
        // Diverged in `force` mode with nothing local to lose.
        this.report(`Remote ${branch} is ${behindN} commit(s) ahead — nothing to push.`, true);
        return;
      }

      if (aheadN === 0) {
        this.report(`Already up to date with origin/${branch}`, false, secs);
        return;
      }

      // Local is strictly ahead: upload only the delta.
      if (mode === "force") {
        await this.push(vaultPath, ["push", "--force-with-lease", "origin", branch], mode, secs);
      } else {
        await this.push(vaultPath, ["push", "origin", branch], mode, secs);
      }
    } catch (err) {
      this.report(String(err && err.message ? err.message : err), true);
    } finally {
      // Every early return above lands here, so the guard is released on all
      // paths — including the exceptions. Leaking it would wedge sync forever.
      this.syncing = false;
    }
  }

  // Remote-only: fetch and integrate, never commit or push. Useful when you want
  // to see what the other device did before sending anything back.
  async runPull() {
    if (this.syncing) {
      this.log("pull skipped: a sync is already running");
      return;
    }
    this.syncing = true;
    const start = Date.now();
    try {
      const vaultPath = getVaultPath(this.app);
      if (!vaultPath) {
        this.report("Could not determine vault path (desktop only).", true);
        return;
      }
      const wrongRepo = await this.wrongRepoReason(vaultPath);
      if (wrongRepo) {
        this.report(wrongRepo, true);
        return;
      }
      const busy = await this.integrationInProgress(vaultPath);
      if (busy) {
        this.report(`A ${busy} from a previous sync is still unresolved, so nothing was touched.`, true);
        return;
      }

      const branch = this.settings.branch;
      this.log(`=== pull start | branch=${branch} ===`);
      const fetchRes = await this.git(vaultPath, ["fetch", "origin", branch]);
      const refRes = await this.git(vaultPath, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
      if (refRes.code !== 0) {
        this.report(`Remote branch ${branch} does not exist yet — nothing to pull.`, true);
        return;
      }
      if (fetchRes.code !== 0) {
        this.report("Fetch failed: " + fetchRes.stderr.trim(), true);
        return;
      }

      const d = await this.divergence(vaultPath, branch);
      if (d.error !== undefined) {
        this.report("Could not compare with remote: " + d.error, true);
        return;
      }
      if (d.behind === 0) {
        this.report(`Already up to date with origin/${branch}.`, false);
        return;
      }

      if (!(await this.integrateRemote(vaultPath, branch, this.settings.pushMode))) return;
      this.report(`Pulled ${d.behind} commit(s) from origin/${branch}.`, false, ((Date.now() - start) / 1000).toFixed(1));
    } catch (err) {
      this.report(String(err && err.message ? err.message : err), true);
    } finally {
      this.syncing = false;
    }
  }

  async runStatus() {
    try {
      const vaultPath = getVaultPath(this.app);
      if (!vaultPath) {
        this.report("Could not determine vault path (desktop only).", true);
        return;
      }
      // Read-only, but reporting a foreign repository's branch and drift would be
      // worse than saying nothing.
      const wrongRepo = await this.wrongRepoReason(vaultPath);
      if (wrongRepo) {
        this.report(wrongRepo, true);
        return;
      }
      const branch = this.settings.branch;
      await this.git(vaultPath, ["fetch", "--quiet", "origin", branch]);

      const branchRes = await this.git(vaultPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const head = branchRes.code === 0 ? branchRes.stdout.trim() : "?";
      const headSha = await this.git(vaultPath, ["rev-parse", "--short", "HEAD"]);
      const dirty = await this.git(vaultPath, ["status", "--porcelain"]);

      const refRes = await this.git(vaultPath, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
      let drift = "remote branch not present yet";
      if (refRes.code === 0) {
        const d = await this.divergence(vaultPath, branch);
        if (d.error === undefined) {
          drift = d.ahead === 0 && d.behind === 0
            ? "in sync with remote"
            : `${d.ahead} to push, ${d.behind} to pull`;
        }
      }

      const uncommitted = dirty.stdout.split(/\r?\n/).filter(Boolean).length;
      new Notice(
        `Vault Force Sync\n` +
          `branch: ${head} (${headSha.stdout.trim()})\n` +
          `${drift}\n` +
          `uncommitted files: ${uncommitted}\n` +
          `mode: ${this.settings.pushMode} / ${this.settings.syncStrategy}\n` +
          `auto sync: every ${this.settings.autoSyncIntervalMin || 0} min`,
        12000
      );
      this.log(`status | head=${headSha.stdout.trim()} | ${drift} | uncommitted=${uncommitted}`);
    } catch (err) {
      this.report(String(err && err.message ? err.message : err), true);
    }
  }

  // Returns a refusal message when the vault is not the root of its repository,
  // or null when the layout is safe.
  //
  // This is not pedantry. `rev-parse --is-inside-work-tree` answers true for any
  // directory nested inside a repository, and `git add -A` run from a
  // subdirectory stages the *entire* repository -- not the subdirectory. A vault
  // that merely sits inside another project would therefore have this plugin
  // commit and push that project: files the user never pointed it at, deletions
  // among them, published to whatever origin that project happens to have.
  async wrongRepoReason(vaultPath) {
    const top = await this.git(vaultPath, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
      return "Not a git repository: " + vaultPath;
    }
    const root = top.stdout.trim();
    if (!root) {
      return "Could not determine the repository root for: " + vaultPath;
    }
    if (samePath(root, vaultPath)) return null;

    return (
      "Refusing to sync: the vault is not the root of its git repository.\n\n" +
      "  vault:      " + vaultPath + "\n" +
      "  repository: " + root + "\n\n" +
      "This plugin stages and commits the whole repository, so syncing here would " +
      "publish every file in that project -- including files outside the vault. " +
      "Give the vault its own repository (`git init` inside it) and sync that instead."
    );
  }

  // Snapshots the remote-tracking ref before a force push rewrites it.
  //
  // `--force-with-lease` checks that nobody else moved the branch since our fetch;
  // it does not make the commits we are about to discard recoverable. Without a
  // ref, they stay only until git next runs gc.
  async backupRemote(vaultPath) {
    const branch = this.settings.branch;
    const from = `refs/remotes/origin/${branch}`;
    const exists = await this.git(vaultPath, ["rev-parse", "--verify", "--quiet", from]);
    if (exists.code !== 0) return; // nothing fetched yet, so nothing to lose

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `refs/vault-force-sync/${stamp}`;
    const res = await this.git(vaultPath, ["update-ref", name, from]);
    if (res.code !== 0) {
      // A missing backup in front of a destructive push is the one thing worth
      // aborting over: the user can still force-push by hand if they mean it.
      throw new Error(
        "Refusing to force-push: could not record a backup of " + from + ". " + res.stderr.trim()
      );
    }
    this.log(`force-push backup: ${name} -> ${from}`);
    await this.pruneBackups(vaultPath);
  }

  async pruneBackups(vaultPath) {
    const res = await this.git(vaultPath, [
      "for-each-ref",
      // Newest first: the refname is an ISO timestamp, so it sorts chronologically.
      "--sort=-refname",
      "--format=%(refname)",
      "refs/vault-force-sync/",
    ]);
    if (res.code !== 0) return;
    const refs = res.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const old of refs.slice(MAX_FORCE_BACKUPS)) {
      await this.git(vaultPath, ["update-ref", "-d", old]);
      this.log(`pruned force-push backup ${old}`);
    }
  }

  async push(vaultPath, args, mode, secs, prefix) {
    // `--force-with-lease` is the only command here that can drop commits that
    // exist nowhere else, so it is the only one that needs a safety net.
    if (args.includes("--force-with-lease")) await this.backupRemote(vaultPath);

    const res = await this.git(vaultPath, args);
    if (res.code !== 0) {
      let msg = `Push (${mode}) failed: ${res.stderr.trim()}`;
      if (/exceeds GitHub|GH001|Large files detected/i.test(res.stderr)) {
        msg +=
          " A file exceeds the GitHub 100MB limit in the pushed history. New large files are auto-skipped; " +
          "for ones already committed, remove them from the unpushed commits (e.g. `git reset --soft origin/<branch>` then re-commit).";
      }
      this.report(msg, true, secs);
      return;
    }
    const summary = res.stdout.trim().split("\n").pop() || "";
    this.log(`push args=${args.join(" ")} summary=${summary}`);
    this.report(`${prefix ? prefix + ", pushed " : "Pushed "}${summary} [${mode}]`, false, secs);
  }

  ensureGitignore(vaultPath) {
    const file = path.join(vaultPath, ".gitignore");
    if (fs.existsSync(file)) return;
    try {
      fs.writeFileSync(file, GITIGNORE_CONTENT, "utf8");
      this.log("created .gitignore");
    } catch (err) {
      this.notify("Could not write .gitignore: " + err.message, true);
    }
  }

  // Ensure the `origin` remote points at the configured sync target.
  // Empty remoteUrl keeps whatever origin already exists.
  async ensureRemote(vaultPath) {
    const url = (this.settings.remoteUrl || "").trim();
    if (!url) return;

    // A token pasted into the URL is the one way a credential still reaches disk:
    // git copies the remote URL into `.git/config` verbatim. Everything else this
    // plugin does keeps the token out of there, so saying so is worth one notice.
    // Once per session, not once per sync.
    if (looksLikeUrlCredentials(url) && !this.warnedUrlCredentials) {
      this.warnedUrlCredentials = true;
      this.notify(
        "Remote URL contains credentials, which git stores in .git/config as plain text. " +
          "Settings -> Credentials keeps the token in Obsidian's SecretStorage instead.",
        true
      );
      this.log("warning: remote URL embeds credentials");
    }
    const existing = await this.git(vaultPath, ["remote", "get-url", "origin"]);
    if (existing.code === 0) {
      const cur = existing.stdout.trim();
      if (cur !== url) {
        await this.git(vaultPath, ["remote", "set-url", "origin", url]);
        this.log(`sync target updated: ${cur} -> ${url}`);
      }
    } else {
      await this.git(vaultPath, ["remote", "add", "origin", url]);
      this.log(`sync target set: ${url}`);
    }
  }

  // Skip files larger than maxFileSizeMB so the rest of the sync can continue
  // (GitHub rejects any pushed blob over 100 MB). Files are added to the
  // local `.git/info/exclude` (never committed) and unstaged if needed.
  async excludeLargeFiles(vaultPath) {
    const maxMB = Math.max(1, parseInt(this.settings.maxFileSizeMB, 10) || 100);
    const limit = maxMB * 1024 * 1024;

    const excludeFile = path.join(vaultPath, ".git", "info", "exclude");
    let existing = "";
    try {
      existing = fs.readFileSync(excludeFile, "utf8");
    } catch (_) {}
    const { before, managed, after } = splitManagedExclude(existing);

    const sizeOf = (abs) => {
      try {
        return fs.statSync(abs).size;
      } catch (_) {
        return 0; // gone or unreadable
      }
    };

    // Previously skipped files are re-checked rather than trusted. A pattern has
    // to be released the moment it stops being true: raise the size limit, shrink
    // the file, or delete it, and an append-only list would keep that file out of
    // the repository forever, with nothing on screen to explain why it never
    // appears on the other device.
    const keep = new Set();
    for (const pat of managed) {
      if (sizeOf(path.join(vaultPath, pat.replace(/^\/+/, ""))) > limit) keep.add(pat);
    }
    const keptCount = keep.size;

    const others = await this.git(vaultPath, ["ls-files", "--others", "--exclude-standard"]);
    const modified = await this.git(vaultPath, ["ls-files", "-m"]);
    const candidates = (others.stdout + "\n" + modified.stdout)
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);

    for (const rel of candidates) {
      const size = sizeOf(path.join(vaultPath, rel));
      if (size <= limit) continue;
      const pat = "/" + rel.replace(/\\/g, "/");
      if (keep.has(pat)) continue;
      keep.add(pat);
      // `.git/info/exclude` only governs untracked files, so a tracked file that
      // is over the limit still has to be unstaged explicitly, every sync.
      await this.git(vaultPath, ["reset", "--quiet", "--", rel]);
      this.log(`skipped >${maxMB}MB file: ${rel} (${(size / 1048576).toFixed(1)}MB)`);
    }

    const parts = [];
    const head = before.join("\n").replace(/\s+$/, "");
    if (head) parts.push(head);
    if (keep.size) parts.push([EXCLUDE_BEGIN].concat([...keep].sort()).concat(EXCLUDE_END).join("\n"));
    const tail = after.join("\n").replace(/^\s+/, "").replace(/\s+$/, "");
    if (tail) parts.push(tail);
    const next = parts.length ? parts.join("\n\n") + "\n" : "";

    if (next === existing) return;
    try {
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      fs.writeFileSync(excludeFile, next, "utf8");
    } catch (err) {
      this.notify("Could not update .git/info/exclude: " + err.message, true);
      return;
    }

    const added = keep.size - keptCount;
    if (added > 0) this.notify(`Skipped ${added} large file(s) (>${maxMB}MB) - syncing the rest.`, true);
    if (keep.size < managed.length) {
      this.log(`released ${managed.length - keep.size} size-skip pattern(s)`);
    }
  }

  // Reads the token from Obsidian's SecretStorage, never from data.json.
  //
  // Returns { configured: false } when the user has not opted in, so the default
  // path -- whatever the machine's git already uses -- is left completely alone.
  resolveCredentials() {
    const secretId = String(this.settings.credentialSecretId || "").trim();
    if (!secretId) return { configured: false };

    const storage = this.app.secretStorage;
    if (!storage || typeof storage.getSecret !== "function") {
      return {
        configured: true,
        error:
          'A personal access token is selected ("' + secretId + '"), but this Obsidian version has no ' +
          "SecretStorage API -- it arrived in 1.11.4 -- so the token cannot be read. Update Obsidian, " +
          "or clear the token setting to go back to this machine's git credentials.",
      };
    }

    const token = storage.getSecret(secretId);
    if (!token) {
      return {
        configured: true,
        error:
          'The secret "' + secretId + '" is empty or missing, so the token could not be read. ' +
          "Pick or create it again under Credentials, or clear the token setting to use this " +
          "machine's git credentials.",
      };
    }

    // GitHub ignores the username for HTTPS -- the token is what authenticates --
    // but git requires a non-empty one, so this is only a placeholder.
    const username = String(this.settings.credentialUsername || "").trim() || "x-access-token";
    return { configured: true, username, token };
  }

  // Writes the askpass helper git will call for the username and the token.
  // Rewritten every sync so an older version's helper cannot linger.
  //
  // Named as a dotfile on purpose: the plugin's own `.gitignore` rule is `.*`, so
  // this stays untracked no matter what the vault's config folder is called. A
  // plain name would be committed by anyone using a config folder without a
  // leading dot.
  ensureAskpassScript(dir) {
    const win = process.platform === "win32";
    const file = path.join(dir, win ? ".askpass.cmd" : ".askpass.sh");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, win ? ASKPASS_WINDOWS : ASKPASS_POSIX, { encoding: "utf8", mode: 0o700 });
    return file;
  }

  // Git options and environment for a single command.
  //
  // Unconfigured: nothing is added at all.
  // Configured: the helper *list* is cleared first. Without that, a credential
  // already cached by gh / osxkeychain / manager-core would be tried first and
  // silently win, making the setting look broken.
  authFor() {
    const cred = this.resolveCredentials();
    if (!cred.configured) return { args: [], env: null };
    if (cred.error) throw new Error(cred.error);

    const dir = pluginDir(this.app);
    if (!dir) throw new Error("Could not locate the plugin folder to write the askpass helper.");

    return {
      args: ["-c", "credential.helper="],
      env: Object.assign({}, process.env, {
        GIT_ASKPASS: this.ensureAskpassScript(dir),
        // Without a TTY git would otherwise have nothing to prompt on, and on
        // Windows could pop a GUI box from an unattended background sync. Failing
        // fast beats stalling until the 5-minute timeout.
        GIT_TERMINAL_PROMPT: "0",
        VFS_GIT_USERNAME: cred.username,
        VFS_GIT_TOKEN: cred.token,
      }),
    };
  }

  async git(vaultPath, args) {
    const gitBin = (this.settings.gitLocation || "").trim() || "git";
    const auth = this.authFor();
    const res = await runGit(vaultPath, gitBin, auth.args.concat(args), auth.env);
    if (res.code === -1) {
      throw new Error(
        "git failed to start (check the 'Git location' setting, current: " + gitBin + "): " + res.stderr.trim()
      );
    }
    return res;
  }
}

// Normalise a value before it is stored. Text is trimmed, numbers become
// integers, and anything unusable falls back to the shipped default -- so a
// half-typed value in the settings box can never persist as something the next
// sync cannot use.
function coerce(key, value) {
  const fallback = DEFAULT_SETTINGS[key];
  if (typeof fallback === "number") {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    if (key === "maxFileSizeMB") return n > 0 ? n : fallback;
    return n >= 0 ? n : fallback;
  }
  if (typeof fallback === "string") return String(value == null ? "" : value).trim();
  if (typeof fallback === "boolean") return Boolean(value);
  return value;
}

// Values the control's own type cannot constrain. The declarative API renders a
// returned string as an inline error, which is better than the old behaviour of
// silently discarding a keystroke.
function makeValidator(item) {
  if (item.type !== "number") return undefined;
  return (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "请输入一个数字";
    if (item.min !== undefined && n < item.min) return "不能小于 " + item.min;
    return undefined;
  };
}

// Builds the credentials row.
//
// `SecretComponent` is the one Obsidian control with no declarative equivalent, so
// the row is assembled by hand in *both* renderers -- which is also what stops the
// two paths from drifting apart on it.
function renderSecretRow(tab, setting, item) {
  if (typeof SecretComponent !== "function") {
    // Showing a picker that cannot save anything would be worse than saying so.
    setting.setDesc(item.desc + " Unavailable in this Obsidian version -- needs 1.11.4 or later.");
    return;
  }

  setting.setDesc(item.desc).addComponent((el) =>
    new SecretComponent(tab.app, el)
      .setValue(String(tab.getControlValue(item.key) || ""))
      .onChange(
        fire((value) => {
          tab.setControlValue(item.key, value || "");
          // Declarative rows re-read their own predicates after a change, but this
          // one is hand-built, so the dependent username row has to be told.
          // refreshDomState() does not exist before Obsidian 1.13.0.
          if (typeof tab.refreshDomState === "function") tab.refreshDomState();
        })
      )
  );
}

// Every persisted setting, once. Both renderers read this, so the declarative
// path used by Obsidian 1.13.0+ and the imperative path used by every version
// before it cannot drift into disagreeing about what settings exist.
const SETTING_SPEC = [
  {
    heading: "Remote",
    items: [
      {
        key: "remoteUrl",
        name: "Remote URL",
        desc: "Sync target repository (kept as the git `origin`). Leave empty to keep the existing origin.",
        type: "text",
        placeholder: "https://github.com/user/repo.git",
      },
      {
        key: "branch",
        name: "Branch",
        desc: "Remote branch to sync.",
        type: "text",
        placeholder: "main",
      },
      {
        key: "gitLocation",
        name: "Git location",
        desc: "Full path to the git executable. Empty = use git from PATH.",
        type: "text",
        placeholder: "C:/Program Files/Git/bin/git.exe",
      },
      {
        key: "proxy",
        name: "Proxy",
        desc: "HTTP(S) proxy git uses to reach GitHub. Leave empty for no proxy.",
        type: "text",
        placeholder: "http://127.0.0.1:7890",
      },
    ],
  },
  {
    heading: "Credentials",
    items: [
      {
        key: "credentialSecretId",
        name: "Personal access token",
        desc:
          "Optional. Leave empty to use this machine's git credentials, which is the default and needs no setup. " +
          "Selecting a secret makes the plugin authenticate with that token instead -- which is what makes syncing " +
          "work on a machine that has no credential helper configured, since git cannot show a login prompt from here.",
        type: "secret",
      },
      {
        key: "credentialUsername",
        name: "Git username",
        desc:
          "Only used alongside a token. GitHub ignores it over HTTPS -- the token is what authenticates -- " +
          "so the default placeholder is fine unless your host expects a real name.",
        type: "text",
        placeholder: "x-access-token",
        visible: (settings) => !!String(settings.credentialSecretId || "").trim(),
      },
    ],
  },
  {
    heading: "How the remote is integrated",
    items: [
      {
        key: "pushMode",
        name: "Sync mode",
        desc: "Incremental: normal push only. Auto: force-with-lease only when remote is behind. Force: always force-with-lease.",
        type: "dropdown",
        options: PUSH_MODES,
      },
      {
        key: "syncStrategy",
        name: "How to integrate remote changes",
        desc:
          "Used when the remote has commits you don't and you are not force pushing. " +
          "Merge keeps existing commit hashes and never rewrites anything already on the remote - safest. " +
          "Rebase keeps history linear, which reads better in a backup repo, and only replays commits you have not pushed yet.",
        type: "dropdown",
        options: SYNC_STRATEGIES,
      },
      {
        key: "autoAbortConflicts",
        name: "Auto-abort sync conflicts",
        desc:
          "When the same note changed in both places, Obsidian has no merge UI. With this on, the sync is rolled back to the state it started from and the conflicting notes are listed - your notes keep their content either way. " +
          "With this off, the merge is left in place so you can resolve it yourself, and syncing stays paused until you do.",
        type: "toggle",
      },
    ],
  },
  {
    heading: "Automatic sync",
    items: [
      {
        key: "autoSyncIntervalMin",
        name: "Auto sync every N minutes",
        desc:
          "Pull and push on a timer while Obsidian is open. 0 turns the timer off. " +
          "A sync that is still running is never overlapped by the next one.",
        type: "number",
        min: 0,
        placeholder: "5",
      },
      {
        key: "autoSyncOnLoad",
        name: "Auto sync on load",
        desc: "Run one full pull + push shortly after Obsidian starts.",
        type: "toggle",
      },
    ],
  },
  {
    heading: "Limits and notices",
    items: [
      {
        key: "maxFileSizeMB",
        name: "Max file size (MB)",
        desc:
          "Files larger than this are skipped (not committed/pushed); the rest of the sync continues. GitHub hard limit is 100 MB.",
        type: "number",
        min: 1,
        placeholder: "100",
      },
      { key: "showSuccessNotice", name: "Show success notice", desc: "Show a notice after each successful sync.", type: "toggle" },
      { key: "enableLogging", name: "Enable logging", desc: "Write sync results to sync.log.", type: "toggle" },
    ],
  },
];

class VaultForceSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Without these, nothing here appears in Obsidian's settings *search* on 1.13.0
  // and later -- and not implementing them raises no error at all, so the only
  // symptom is a setting that cannot be found.
  getSettingDefinitions() {
    return SETTING_SPEC.map((group) => ({
      type: "group",
      heading: group.heading,
      items: group.items.map((item) => {
        const def = { name: item.name, desc: item.desc };
        if (item.visible) def.visible = () => item.visible(this.plugin.settings);

        if (item.type === "secret") {
          def.render = (setting) => renderSecretRow(this, setting, item);
        } else {
          def.control = {
            type: item.type,
            key: item.key,
            defaultValue: DEFAULT_SETTINGS[item.key],
            placeholder: item.placeholder,
            min: item.min,
            options: item.options,
            validate: makeValidator(item),
          };
        }
        return def;
      }),
    }));
  }

  getControlValue(key) {
    const settings = this.plugin.settings;
    return key in settings ? settings[key] : DEFAULT_SETTINGS[key];
  }

  async setControlValue(key, value) {
    this.plugin.settings[key] = coerce(key, value);
    // Changing the interval only takes effect once the timer is rebuilt.
    if (key === "autoSyncIntervalMin") this.plugin.startTimer();
    // Awaited rather than fired and forgotten: Obsidian waits on this before it
    // re-renders, and a rejected write should surface instead of disappearing.
    await this.plugin.saveSettings();
  }

  // The pre-1.13 renderer. `display()` is abstract, so it stays; 1.13.0 and later
  // render from `getSettingDefinitions()` instead. Both read SETTING_SPEC.
  display() {
    const { containerEl } = this;
    containerEl.empty();

    for (const group of SETTING_SPEC) {
      new Setting(containerEl).setName(group.heading).setHeading();

      for (const item of group.items) {
        if (item.visible && !item.visible(this.plugin.settings)) continue;

        const setting = new Setting(containerEl).setName(item.name).setDesc(item.desc);
        const store = (raw) => this.setControlValue(item.key, raw);

        if (item.type === "secret") {
          renderSecretRow(this, setting, item);
          continue;
        }

        switch (item.type) {
          case "text":
            setting.addText((text) =>
              text
                .setPlaceholder(item.placeholder || "")
                .setValue(String(this.plugin.settings[item.key] ?? ""))
                .onChange(fire((value) => store(value)))
            );
            break;
          case "toggle":
            setting.addToggle((toggle) =>
              toggle
                .setValue(Boolean(this.plugin.settings[item.key]))
                .onChange(fire((value) => store(value)))
            );
            break;
          case "dropdown":
            setting.addDropdown((dropdown) => {
              for (const [value, label] of Object.entries(item.options)) dropdown.addOption(value, label);
              dropdown
                .setValue(String(this.plugin.settings[item.key]))
                .onChange(fire((value) => store(value)));
            });
            break;
          case "number":
            setting.addText((text) =>
              text
                .setPlaceholder(item.placeholder || String(DEFAULT_SETTINGS[item.key]))
                .setValue(String(this.plugin.settings[item.key]))
                .onChange(
                  fire((value) => {
                    const problem = makeValidator(item)(value);
                    if (problem) return;
                    store(value);
                  })
                )
            );
            break;
        }
      }
    }

    new Setting(containerEl).setName("Logging").setHeading();
    new Setting(containerEl)
      .setName("Log file")
      .setDesc(this.plugin.getLogPath() || "desktop only")
      .addButton((button) =>
        button.setButtonText("Open sync log").onClick(() => this.plugin.openLog())
      )
      .addButton((button) =>
        button.setButtonText("Clear log").setWarning().onClick(() => this.plugin.clearLog())
      );
  }
}

module.exports = VaultForceSyncPlugin;
module.exports.default = VaultForceSyncPlugin;
