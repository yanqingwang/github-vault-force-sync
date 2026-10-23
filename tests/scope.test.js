/**
 * Covers the Nextcloud-style sync-scope controls against real repositories.
 *
 * The rules are simple to state and easy to get subtly wrong:
 *   - folder entries match at a folder boundary, not by substring;
 *   - dotfiles and dotfolders are independent toggles;
 *   - underscore files and folders are independent toggles;
 *   - sync-only is a whitelist, and exclusions still win;
 *   - the legacy `.gitignore` rule must be migrated away, or turning dotfiles
 *     back on silently does nothing.
 *
 * Everything here drives the real `git` binary, because the decisive part is
 * what `git add -A` and `git reset -- <path>` actually do to a real index.
 */

const Module = require("module");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const notices = [];
class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.commands = [];
    this.settingTabs = [];
    this._data = {};
  }
  addCommand(c) {
    this.commands.push(c);
    return c;
  }
  addRibbonIcon() {}
  addSettingTab(t) {
    this.settingTabs.push(t);
  }
  async loadData() {
    return this._data;
  }
  async saveData(d) {
    this._data = d;
  }
  registerEvent() {}
}
class Notice {
  constructor(message) {
    notices.push(String(message));
  }
}
class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = { empty() {} };
  }
}
class Setting {
  constructor() {
    return new Proxy({}, { get: () => () => new Setting() });
  }
}
class Modal {}

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "obsidian") return { Plugin, Notice, PluginSettingTab, Setting, Modal };
  return origLoad.apply(this, arguments);
};

const PluginClass = require(path.join(__dirname, "..", "main.js"));

const BASE_SETTINGS = {
  remoteUrl: "",
  gitLocation: "",
  proxy: "",
  branch: "main",
  pushMode: "incremental",
  syncStrategy: "merge",
  autoSyncOnLoad: false,
  autoSyncIntervalMin: 0,
  autoAbortConflicts: true,
  showSuccessNotice: false,
  enableLogging: false,
  maxFileSizeMB: 100,
  credentialUsername: "",
  credentialSecretId: "",
  excludedFolders: [],
  excludedFiles: [],
  syncOnlyFolders: [],
  excludeHiddenFiles: true,
  excludeDotFolders: true,
  excludeUnderscoreFiles: false,
  excludeUnderscoreFolders: false,
};

const roots = [];
const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function makeRepo(seed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vfs-scope-"));
  roots.push(root);

  const remote = path.join(root, "remote.git");
  fs.mkdirSync(remote);
  git(remote, ["init", "--bare", "-b", "main"]);

  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "scope@test.local"]);
  git(repo, ["config", "user.name", "Scope"]);
  git(repo, ["remote", "add", "origin", remote]);

  if (seed) seed(repo);
  fs.writeFileSync(path.join(repo, "base.md"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["push", "-u", "origin", "main"]);
  return repo;
}

function makePlugin(repo, settings) {
  const app = {
    vault: { adapter: { getBasePath: () => repo }, configDir: ".obsidian" },
    workspace: { onLayoutReady: () => {} },
  };
  const plugin = new PluginClass(app, { id: "vault-force-sync", dir: null });
  plugin.settings = Object.assign({}, BASE_SETTINGS, settings);
  plugin._data = plugin.settings;
  plugin.syncing = false;
  plugin.syncTimer = null;
  const messages = [];
  plugin.notify = () => {};
  plugin.report = (message, error) => messages.push({ message: String(message), error: !!error });
  return { plugin, messages };
}

async function sync(repo, settings) {
  const { plugin, messages } = makePlugin(repo, settings);
  await plugin.runSync();
  const errors = messages.filter((m) => m.error);
  if (errors.length) {
    throw new Error("sync reported an error: " + errors.map((m) => m.message).join(" | "));
  }
  return messages;
}

const tracked = (repo) =>
  git(repo, ["ls-files"]).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const has = (repo, file) => tracked(repo).includes(file);
const write = (repo, file, text = "x\n") => {
  const abs = path.join(repo, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};
const show = (repo, file) => git(repo, ["show", "HEAD:" + file]);

const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Name filters
// ---------------------------------------------------------------------------

check("defaults keep dot content local but sync underscore content", async () => {
  const repo = makeRepo();
  for (const file of [".env", ".obsidian/config.json", ".hidden/inside.md", "_draft.md", "_templates/t.md", "normal.md"]) {
    write(repo, file);
  }

  await sync(repo, {});

  for (const file of ["normal.md", "_draft.md", "_templates/t.md"]) {
    assert(has(repo, file), `${file} should have been committed with the defaults`);
  }
  for (const file of [".env", ".obsidian/config.json", ".hidden/inside.md"]) {
    assert(!has(repo, file), `${file} should have stayed local`);
  }
});

check("dotfiles sync when the hidden-file toggle is off, dotfolders still do not", async () => {
  const repo = makeRepo();
  for (const file of [".env", ".obsidian/config.json", "notes/.nested/file.md", "normal.md"]) {
    write(repo, file);
  }

  await sync(repo, { excludeHiddenFiles: false });

  assert(has(repo, ".env"), "a root dotfile should sync when the file rule is off");
  assert(has(repo, "normal.md"), "normal.md should sync");
  assert(!has(repo, ".obsidian/config.json"), "a dotfolder should still be excluded");
  assert(!has(repo, "notes/.nested/file.md"), "content under a dotfolder should be excluded");
});

check("dotfolders sync when the dotfolder toggle is off, dotfiles still do not", async () => {
  const repo = makeRepo();
  for (const file of [
    ".env",
    ".obsidian/config.json",
    ".obsidian/plugins/other/data.json",
    ".obsidian/plugins/vault-force-sync/state.json",
    "normal.md",
  ]) {
    write(repo, file);
  }

  await sync(repo, { excludeDotFolders: false });

  assert(has(repo, ".obsidian/config.json"), "a dotfolder should sync when its toggle is off");
  assert(has(repo, ".obsidian/plugins/other/data.json"), "other plugin data should sync");
  assert(!has(repo, ".env"), "a dotfile should still be excluded");
  assert(
    !has(repo, ".obsidian/plugins/vault-force-sync/state.json"),
    "the plugin's own folder must stay excluded even with dotfolders enabled"
  );
});

check("underscore files and folders are separate toggles", async () => {
  const files = ["_draft.md", "notes/_draft.md", "_templates/keep.md", "notes/_archive/keep.md", "normal.md"];

  const fileRepo = makeRepo();
  for (const file of files) write(fileRepo, file);
  await sync(fileRepo, { excludeUnderscoreFiles: true });
  assert(!has(fileRepo, "_draft.md"), "a root underscore file should be excluded");
  assert(!has(fileRepo, "notes/_draft.md"), "an underscore file at depth should be excluded");
  assert(has(fileRepo, "_templates/keep.md"), "an underscore folder should still sync");
  assert(has(fileRepo, "notes/_archive/keep.md"), "a nested underscore folder should still sync");

  const folderRepo = makeRepo();
  for (const file of files) write(folderRepo, file);
  await sync(folderRepo, { excludeUnderscoreFolders: true });
  assert(has(folderRepo, "_draft.md"), "an underscore file should still sync");
  assert(!has(folderRepo, "_templates/keep.md"), "an underscore folder should be excluded");
  assert(!has(folderRepo, "notes/_archive/keep.md"), "a nested underscore folder should be excluded");
});

// ---------------------------------------------------------------------------
// Folder lists
// ---------------------------------------------------------------------------

check("excluded folders match at a folder boundary, never by substring", async () => {
  const repo = makeRepo();
  for (const file of [
    "Archive/a.md",
    "Archive-old/b.md",
    "Archive2/d.md",
    "notes/Archive/c.md",
    "normal.md",
  ]) {
    write(repo, file);
  }

  await sync(repo, { excludedFolders: ["Archive"] });

  assert(!has(repo, "Archive/a.md"), "the excluded folder was committed");
  assert(has(repo, "Archive-old/b.md"), "a same-prefix sibling was wrongly excluded");
  assert(has(repo, "Archive2/d.md"), "a same-prefix sibling was wrongly excluded");
  assert(has(repo, "notes/Archive/c.md"), "a nested path was wrongly matched by a root entry");
  assert(has(repo, "normal.md"), "normal.md should sync");
});

check("a nested excluded folder matches only its own subtree", async () => {
  const repo = makeRepo();
  for (const file of ["Notes/Archive/x.md", "Notes/Archive-old/y.md", "Notes/keep.md"]) {
    write(repo, file);
  }

  await sync(repo, { excludedFolders: ["Notes/Archive"] });

  assert(!has(repo, "Notes/Archive/x.md"), "the nested excluded folder was committed");
  assert(has(repo, "Notes/Archive-old/y.md"), "the folder-boundary rule was not respected");
  assert(has(repo, "Notes/keep.md"), "an ordinary sibling was excluded");
});

check("an excluded file is held back while everything around it syncs", async () => {
  const repo = makeRepo();
  for (const file of ["Inbox/secret.md", "Inbox/notes.md", "secret.md", "Other/secret.md"]) {
    write(repo, file);
  }

  await sync(repo, { excludedFiles: ["Inbox/secret.md", "secret.md"] });

  assert(!has(repo, "Inbox/secret.md"), "the excluded file was committed");
  assert(!has(repo, "secret.md"), "the excluded root-level file was committed");
  assert(has(repo, "Inbox/notes.md"), "a sibling in the same folder was excluded");
  assert(has(repo, "Other/secret.md"), "an entry matched beyond its exact path");
});

check("an already-tracked excluded file keeps its remote copy and stops taking edits", async () => {
  const repo = makeRepo((dir) => {
    fs.mkdirSync(path.join(dir, "Inbox"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Inbox", "token.md"), "original\n");
  });
  write(repo, "Inbox/token.md", "changed locally\n");
  write(repo, "Inbox/other.md");

  await sync(repo, { excludedFiles: ["Inbox/token.md"] });

  assert(has(repo, "Inbox/token.md"), "excluding a tracked file untracked it");
  assert(show(repo, "Inbox/token.md").trim() === "original", "the excluded tracked file was updated");
  assert(has(repo, "Inbox/other.md"), "a sibling should still sync");
  assert(
    /Inbox\/token\.md/.test(git(repo, ["status", "--porcelain"])),
    "the excluded local edit should stay in the working tree"
  );

  // A local deletion of an excluded file must not be published either; dropping it
  // from the repository is something the user does on purpose with `git rm`.
  fs.unlinkSync(path.join(repo, "Inbox", "token.md"));
  await sync(repo, { excludedFiles: ["Inbox/token.md"] });
  assert(has(repo, "Inbox/token.md"), "deleting an excluded tracked file locally removed it from the repository");
});

check("excluded files outrank the sync-only whitelist", async () => {
  const repo = makeRepo();
  for (const file of ["Notes/a.md", "Notes/b.md", "Notes/c.md"]) {
    write(repo, file);
  }

  await sync(repo, { syncOnlyFolders: ["Notes"], excludedFiles: ["Notes/b.md"] });

  assert(has(repo, "Notes/a.md"), "a whitelisted file was lost");
  assert(has(repo, "Notes/c.md"), "a whitelisted file was lost");
  assert(!has(repo, "Notes/b.md"), "the whitelist rescued an explicitly excluded file");
});

check("sync-only restricts staging to the selected folders", async () => {
  const repo = makeRepo();
  for (const file of ["Notes/a.md", "Notes/sub/b.md", "Other/c.md", "root.md", ".env"]) {
    write(repo, file);
  }

  await sync(repo, { syncOnlyFolders: ["Notes"] });

  for (const file of ["Notes/a.md", "Notes/sub/b.md"]) {
    assert(has(repo, file), `${file} should have been inside the whitelist`);
  }
  for (const file of ["Other/c.md", "root.md", ".env"]) {
    assert(!has(repo, file), `${file} should have stayed outside the whitelist`);
  }

  // Deletions inside the selected folder still have to be committed.
  fs.unlinkSync(path.join(repo, "Notes/a.md"));
  write(repo, "root2.md");
  await sync(repo, { syncOnlyFolders: ["Notes"] });
  assert(!has(repo, "Notes/a.md"), "a deletion inside the whitelist was not committed");
  assert(!has(repo, "root2.md"), "a root-level addition slipped into the whitelist");
});

check("a root .gitignore follows sync-only as repository metadata", async () => {
  const repo = makeRepo();
  write(repo, ".gitignore", "*.tmp\n");
  write(repo, "Notes/a.md");
  write(repo, "root.md");

  await sync(repo, { syncOnlyFolders: ["Notes"] });

  assert(has(repo, ".gitignore"), "the root .gitignore should still sync in sync-only mode");
  assert(has(repo, "Notes/a.md"), "the selected folder should sync");
  assert(!has(repo, "root.md"), "ordinary root content should stay out of the whitelist");
});

check("a missing sync-only folder falls back safely and still filters", async () => {
  const repo = makeRepo();
  write(repo, "root.md");

  await sync(repo, { syncOnlyFolders: ["Missing"] });

  assert(!has(repo, "root.md"), "the fallback full add published a file outside the scope");
  assert(has(repo, "base.md"), "the existing repository content should be untouched");
});

check("excluded folders win over a sync-only whitelist", async () => {
  const repo = makeRepo();
  for (const file of ["Notes/Public/a.md", "Notes/Private/b.md", "Other/c.md"]) {
    write(repo, file);
  }

  await sync(repo, {
    syncOnlyFolders: ["Notes"],
    excludedFolders: ["Notes/Private"],
  });

  assert(has(repo, "Notes/Public/a.md"), "a whitelisted, non-excluded file was skipped");
  assert(!has(repo, "Notes/Private/b.md"), "the exclusion was rescued by the whitelist");
  assert(!has(repo, "Other/c.md"), "a file outside the whitelist was committed");
});

// ---------------------------------------------------------------------------
// Migration and tracked paths
// ---------------------------------------------------------------------------

check("the old generated .gitignore rule is migrated so dotfiles can sync again", async () => {
  const legacy = "# Vault Force Sync: exclude dotfiles / hidden files\n.*\n!/.gitignore\n";
  const repo = makeRepo((dir) => {
    fs.writeFileSync(path.join(dir, ".gitignore"), legacy);
  });
  write(repo, ".env");
  write(repo, ".obsidian/config.json");
  write(repo, "normal.md");

  await sync(repo, { excludeHiddenFiles: false, excludeDotFolders: false });

  assert(has(repo, ".env"), ".env was still suppressed by the legacy .gitignore");
  assert(has(repo, ".obsidian/config.json"), ".obsidian was still suppressed by the legacy .gitignore");
  assert(has(repo, "normal.md"), "normal.md should sync");
  const migrated = show(repo, ".gitignore");
  assert(!/^\.\*$/m.test(migrated), "the legacy `.*` rule survived migration:\n" + migrated);
  assert(/sync-scope filters/.test(migrated), "the migrated file has no explanatory comment");
});

check("deleting a tracked file still publishes the deletion", async () => {
  const repo = makeRepo((dir) => {
    fs.mkdirSync(path.join(dir, "Notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Notes", "a.md"), "note\n");
  });
  fs.unlinkSync(path.join(repo, "Notes", "a.md"));

  await sync(repo, {});

  assert(!has(repo, "Notes/a.md"), "the deletion was not published");
});

check("moving a tracked file to Obsidian's trash still syncs the deletion", async () => {
  for (const [label, body] of [
    ["unchanged", "note\n"],
    ["rewritten", "completely different content\n"],
  ]) {
    const repo = makeRepo((dir) => {
      fs.mkdirSync(path.join(dir, "Notes"), { recursive: true });
      fs.writeFileSync(path.join(dir, "Notes", "a.md"), "note\n");
    });
    const trashed = path.join(repo, ".trash", "a.md");
    fs.mkdirSync(path.dirname(trashed), { recursive: true });
    fs.renameSync(path.join(repo, "Notes", "a.md"), trashed);
    fs.writeFileSync(trashed, body);

    await sync(repo, {});

    assert(!has(repo, "Notes/a.md"), `${label}: the deletion was not published`);
    assert(!has(repo, ".trash/a.md"), `${label}: the trash copy was committed`);
  }
});

check("already-tracked excluded files stay in the repository but stop being updated", async () => {
  const repo = makeRepo((dir) => {
    fs.mkdirSync(path.join(dir, "Archive"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Archive", "old.md"), "original\n");
  });
  write(repo, "Archive/old.md", "changed locally\n");
  write(repo, "Archive/new.md");
  write(repo, "normal.md");

  await sync(repo, { excludedFolders: ["Archive"] });

  assert(has(repo, "Archive/old.md"), "a previously tracked file should not be untracked automatically");
  assert(show(repo, "Archive/old.md").trim() === "original", "an excluded tracked file was updated");
  assert(!has(repo, "Archive/new.md"), "a new file in the excluded folder was committed");
  assert(has(repo, "normal.md"), "normal.md should still sync");

  const status = git(repo, ["status", "--porcelain"]);
  assert(/Archive\/old\.md/.test(status), "the excluded local edit should remain in the working tree");
  assert(
    fs.existsSync(path.join(repo, "Archive", "new.md")),
    "the excluded new file should still exist locally"
  );
});

check("moving a tracked file into an excluded folder does not publish its deletion", async () => {
  const repo = makeRepo((dir) => {
    fs.mkdirSync(path.join(dir, "Notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Notes", "a.md"), "note\n");
  });
  fs.mkdirSync(path.join(repo, "Archive"), { recursive: true });
  fs.renameSync(path.join(repo, "Notes", "a.md"), path.join(repo, "Archive", "a.md"));

  await sync(repo, { excludedFolders: ["Archive"] });

  assert(has(repo, "Notes/a.md"), "the old tracked path was deleted from the repository");
  assert(!has(repo, "Archive/a.md"), "the excluded destination was committed");
  assert(
    fs.existsSync(path.join(repo, "Archive", "a.md")),
    "the local file should remain in the excluded folder"
  );
});

check("a heavily rewritten same-name move still does not publish a deletion", async () => {
  const repo = makeRepo((dir) => {
    fs.mkdirSync(path.join(dir, "Notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Notes", "a.md"), "original\n");
  });
  fs.mkdirSync(path.join(repo, "Archive"), { recursive: true });
  // No shared content at all, so git may see a delete plus an add rather than a
  // rename. The basename fallback must still keep the remote copy.
  fs.writeFileSync(path.join(repo, "Archive", "a.md"), "completely rewritten\n");
  fs.unlinkSync(path.join(repo, "Notes", "a.md"));

  await sync(repo, { excludedFolders: ["Archive"] });

  assert(has(repo, "Notes/a.md"), "the old tracked path was deleted despite the same-name move");
  assert(!has(repo, "Archive/a.md"), "the excluded destination was committed");
});

check("moving a tracked file out of a sync-only folder keeps the old remote copy", async () => {
  const repo = makeRepo((dir) => {
    fs.mkdirSync(path.join(dir, "Notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Notes", "a.md"), "note\n");
  });
  fs.mkdirSync(path.join(repo, "Other"), { recursive: true });
  fs.renameSync(path.join(repo, "Notes", "a.md"), path.join(repo, "Other", "a.md"));

  await sync(repo, { syncOnlyFolders: ["Notes"] });

  assert(has(repo, "Notes/a.md"), "the old tracked path was deleted when the move left the synced set");
  assert(!has(repo, "Other/a.md"), "the out-of-scope destination was committed");
  assert(
    fs.existsSync(path.join(repo, "Other", "a.md")),
    "the local file should remain outside the synced set"
  );
});

check("moving a tracked file out of an excluded folder syncs the new copy", async () => {
  const repo = makeRepo((dir) => {
    fs.mkdirSync(path.join(dir, "Archive"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Archive", "a.md"), "note\n");
  });
  fs.mkdirSync(path.join(repo, "Notes"), { recursive: true });
  fs.renameSync(path.join(repo, "Archive", "a.md"), path.join(repo, "Notes", "a.md"));

  await sync(repo, { excludedFolders: ["Archive"] });

  assert(has(repo, "Notes/a.md"), "the file moved into scope was not committed");
  assert(has(repo, "Archive/a.md"), "the old excluded copy should not be deleted from the repository");
});

// ---------------------------------------------------------------------------
// Managed exclude block
// ---------------------------------------------------------------------------

check("scope patterns are not written into .git/info/exclude", async () => {
  const repo = makeRepo();
  const excludeFile = path.join(repo, ".git", "info", "exclude");
  const mine = "# my own rule\nmy-secret-folder/\n/also-mine.md\n";
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  fs.writeFileSync(excludeFile, mine);
  write(repo, "Archive/a.md");
  write(repo, "_templates/t.md");
  write(repo, "normal.md");

  await sync(repo, { excludedFolders: ["Archive"], excludeUnderscoreFolders: true });

  const text = fs.readFileSync(excludeFile, "utf8");
  for (const line of ["# my own rule", "my-secret-folder/", "/also-mine.md"]) {
    assert(text.includes(line), `the user's line "${line}" was lost:\n${text}`);
  }
  // An ignored destination makes `git add -A` see only the deletion half of a
  // move, so scope rules must stay out of this file entirely.
  assert(!text.includes("/Archive/"), "an excluded folder was written into .git/info/exclude");
  assert(!text.includes("_*/"), "an underscore folder was written into .git/info/exclude");
  assert(!has(repo, "Archive/a.md"), "Archive/a.md was committed");
  assert(!has(repo, "_templates/t.md"), "_templates/t.md was committed");
  assert(has(repo, "normal.md"), "normal.md should sync");
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
(async () => {
  const results = [];
  for (const [name, fn] of checks) {
    try {
      await fn();
      results.push(["PASS", name, ""]);
    } catch (e) {
      results.push(["FAIL", name, e.message]);
    }
  }
  let failed = 0;
  for (const [status, name, error] of results) {
    if (status === "FAIL") failed++;
    console.log(`${status}  ${name}`);
    if (error) console.log(`      ${error}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);

  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("harness crashed:", e);
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
