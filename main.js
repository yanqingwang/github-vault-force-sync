// Vault Force Sync — sync all vault data to a GitHub remote, excluding
// dotfiles and hidden files.
//
// Desktop only. Uses the system `git` (must be on PATH).
// Conventions:
//   - runs inside the vault repo (the vault itself is the git work tree)
//   - writes `.gitignore` (.* / !/.gitignore) so dotfiles never get tracked
//   - optionally configures an HTTP(S) proxy + large http.postBuffer for big pushes
//   - incremental sync: `git add -A` -> commit (timestamp) -> fetch remote ->
//     push. Only new commits (the delta since last sync) are uploaded.
//   - logs every sync run to `<vault>/.obsidian/plugins/vault-force-sync/sync.log`
//     (local only — `.obsidian` is gitignored), viewable via the "Open sync log"
//     command or the button in settings.
//
// Push modes:
//   incremental : normal `git push` only; never overwrite remote.
//   auto        : normal push; auto force-with-lease only when remote is
//                 strictly behind local (local history rewritten). Never
//                 overwrites diverged remote commits.
//   force       : always `git push --force-with-lease`.

const { Plugin, Notice, PluginSettingTab, Setting, Modal } = require("obsidian");
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

const DEFAULT_SETTINGS = {
  remoteUrl: "",
  gitLocation: "",
  proxy: "",
  branch: "main",
  pushMode: "incremental",
  autoSyncOnLoad: false,
  showSuccessNotice: true,
  enableLogging: true,
  maxFileSizeMB: 100,
};

const GITIGNORE_CONTENT = [
  "# Vault Force Sync: exclude dotfiles / hidden files",
  ".*",
  "!/.gitignore",
].join("\n") + "\n";

function getVaultPath(app) {
  const adapter = app.vault.adapter;
  if (adapter && typeof adapter.getBasePath === "function") {
    return adapter.getBasePath();
  }
  return null;
}

function runGit(cwd, gitBin, args) {
  return new Promise((resolve) => {
    execFile(
      gitBin,
      args,
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
      },
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

    this.addCommand({
      id: "sync",
      name: "Sync vault to remote (incremental)",
      callback: () => this.runSync(),
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
  }

  onunload() {}

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

  getLogPath() {
    const vp = getVaultPath(this.app);
    return vp ? path.join(vp, ".obsidian", "plugins", "vault-force-sync", "sync.log") : null;
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

  async runSync(forceMode) {
    const start = Date.now();
    const mode = forceMode || this.settings.pushMode;
    this.log(`=== sync start | mode=${mode} | target=${this.settings.remoteUrl || "origin (existing)"} ===`);
    try {
      const vaultPath = getVaultPath(this.app);
      if (!vaultPath) {
        this.report("Could not determine vault path (desktop only).", true);
        return;
      }

      this.ensureGitignore(vaultPath);

      const ok = await this.git(vaultPath, ["rev-parse", "--is-inside-work-tree"]);
      if (ok.code !== 0) {
        this.report("Not a git repository: " + vaultPath, true);
        return;
      }

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
        // Remote branch does not exist yet (fresh repo) — plain push.
        this.log(`remote branch ${branch} does not exist yet`);
        await this.push(vaultPath, ["push", "-u", "origin", branch], mode, secs);
        return;
      }

      const ahead = await this.git(vaultPath, ["rev-list", "--count", `origin/${branch}..HEAD`]);
      const behind = await this.git(vaultPath, ["rev-list", "--count", `HEAD..origin/${branch}`]);
      if (ahead.code !== 0 || behind.code !== 0) {
        this.report("Could not compare with remote: " + (ahead.stderr + behind.stderr).trim(), true);
        return;
      }
      const aheadN = parseInt(ahead.stdout, 10) || 0;
      const behindN = parseInt(behind.stdout, 10) || 0;
      this.log(`ahead=${aheadN} behind=${behindN}`);

      if (behindN > 0 && aheadN > 0) {
        // Diverged: remote has commits we don't have.
        if (mode === "force") {
          await this.push(vaultPath, ["push", "--force-with-lease", "origin", branch], mode, secs);
        } else {
          this.report(
            `Remote ${branch} has ${behindN} commit(s) you don't have. ` +
              "Incremental/auto sync will not overwrite them. Pull first, or use Force push.",
            true
          );
        }
        return;
      }

      if (behindN > 0) {
        this.report(`Remote ${branch} is ${behindN} commit(s) ahead — nothing to push. Pull to update.`, true);
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
    }
  }

  async push(vaultPath, args, mode, secs) {
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
    this.report(`Pushed ${summary} [${mode}]`, false, secs);
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

    const others = await this.git(vaultPath, ["ls-files", "--others", "--exclude-standard"]);
    const modified = await this.git(vaultPath, ["ls-files", "-m"]);
    const candidates = (others.stdout + "\n" + modified.stdout)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const excludeFile = path.join(vaultPath, ".git", "info", "exclude");
    let existing = "";
    try {
      existing = fs.readFileSync(excludeFile, "utf8");
    } catch (_) {}
    const already = new Set(existing.split(/\r?\n/).map((l) => l.trim()));

    const toAdd = [];
    for (const rel of candidates) {
      const abs = path.join(vaultPath, rel);
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch (_) {
        continue; // file vanished or unreadable
      }
      if (size <= limit) continue;
      const pat = "/" + rel.replace(/\\/g, "/");
      if (already.has(pat)) continue;
      toAdd.push(pat);
      await this.git(vaultPath, ["reset", "--quiet", "--", rel]); // unstage if a prior run staged it
      this.log(`skipped >${maxMB}MB file: ${rel} (${(size / 1048576).toFixed(1)}MB)`);
    }

    if (toAdd.length) {
      const content =
        (existing ? existing.replace(/\s+$/, "\n") : "") + toAdd.join("\n") + "\n";
      fs.writeFileSync(excludeFile, content, "utf8");
      this.notify(`Skipped ${toAdd.length} large file(s) (>${maxMB}MB) — syncing the rest.`, true);
    }
  }

  async git(vaultPath, args) {
    const gitBin = (this.settings.gitLocation || "").trim() || "git";
    const res = await runGit(vaultPath, gitBin, args);
    if (res.code === -1) {
      throw new Error(
        "git failed to start (check the 'Git location' setting, current: " + gitBin + "): " + res.stderr.trim()
      );
    }
    return res;
  }
}

class VaultForceSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Remote URL")
      .setDesc("Sync target repository (kept as the git `origin`). Leave empty to keep the existing origin.")
      .addText((text) =>
        text
          .setPlaceholder("https://github.com/user/repo.git")
          .setValue(this.plugin.settings.remoteUrl)
          .onChange(async (value) => {
            this.plugin.settings.remoteUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Git location")
      .setDesc("Full path to the git executable. Empty = use git from PATH.")
      .addText((text) =>
        text
          .setPlaceholder("C:/Program Files/Git/bin/git.exe")
          .setValue(this.plugin.settings.gitLocation)
          .onChange(async (value) => {
            this.plugin.settings.gitLocation = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Proxy")
      .setDesc("HTTP(S) proxy git uses to reach GitHub. Leave empty for no proxy.")
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:7890")
          .setValue(this.plugin.settings.proxy)
          .onChange(async (value) => {
            this.plugin.settings.proxy = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Remote branch to sync.")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this.plugin.settings.branch)
          .onChange(async (value) => {
            this.plugin.settings.branch = value.trim() || "main";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync mode")
      .setDesc("Incremental: normal push only. Auto: force-with-lease only when remote is behind. Force: always force-with-lease.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(PUSH_MODES)
          .setValue(this.plugin.settings.pushMode)
          .onChange(async (value) => {
            this.plugin.settings.pushMode = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max file size (MB)")
      .setDesc("Files larger than this are skipped (not committed/pushed); the rest of the sync continues. GitHub hard limit is 100 MB.")
      .addText((text) =>
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.maxFileSizeMB))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            this.plugin.settings.maxFileSizeMB = Number.isFinite(n) && n > 0 ? n : 100;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto sync on load")
      .setDesc("Run one sync shortly after Obsidian starts.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncOnLoad)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncOnLoad = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show success notice")
      .setDesc("Show a notice after each successful sync.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showSuccessNotice)
          .onChange(async (value) => {
            this.plugin.settings.showSuccessNotice = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setHeading()
      .setName("Logging")
      .setDesc("Every sync run is recorded to a local log file (stays out of git).");

    new Setting(containerEl)
      .setName("Enable logging")
      .setDesc("Write sync results to sync.log.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableLogging)
          .onChange(async (value) => {
            this.plugin.settings.enableLogging = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("View log")
      .setDesc(this.plugin.getLogPath() || "desktop only")
      .addButton((button) =>
        button
          .setButtonText("Open sync log")
          .onClick(() => this.plugin.openLog())
      )
      .addButton((button) =>
        button
          .setButtonText("Clear log")
          .setWarning()
          .onClick(() => this.plugin.clearLog())
      );
  }
}

module.exports = VaultForceSyncPlugin;
module.exports.default = VaultForceSyncPlugin;
