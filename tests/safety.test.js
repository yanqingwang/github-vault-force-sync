/**
 * Covers the guarantees that make the plugin safe to point at a real vault.
 *
 * These are the failures that cost data rather than annoy:
 *
 *   - operating on the wrong repository. `rev-parse --is-inside-work-tree` is
 *     true for a vault merely nested inside a project, and `git add -A` from a
 *     subdirectory stages the *whole* repository. That combination publishes a
 *     project the user never pointed the plugin at, deletions included.
 *   - a force push that discards remote commits nothing else points at.
 *   - a size-skip pattern that outlives its reason, so a file silently never
 *     syncs again with nothing on screen explaining why.
 *   - a token pasted into the remote URL, which git stores in `.git/config`.
 *
 * Every test drives the plugin against real repositories, because each of those
 * is a property of what the real git binary does with a real directory layout.
 */

const Module = require("module");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// --- stub `obsidian` ---------------------------------------------------------
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
  constructor(msg) {
    notices.push(String(msg));
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

// --- helpers -----------------------------------------------------------------
const git = (cwd, cmd) =>
  execFileSync("git", cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function gitQuiet(cwd, cmd) {
  try {
    return { ok: true, out: git(cwd, cmd) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

/**
 * One repository, optionally with the vault as a subdirectory of it.
 *
 * `vaultAsSubdir` reproduces the layout that makes the wrong-repository guard
 * necessary -- and that a great many real vaults actually have, since people
 * keep a vault inside a notes/projects repository without a second `git init`.
 */
function makeRepo({ vaultAsSubdir = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vfs-safe-"));
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(remote);
  git(remote, ["init", "--bare", "-b", "main"]);

  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@test.local"]);
  git(repo, ["config", "user.name", "T"]);
  git(repo, ["remote", "add", "origin", remote]);

  const vault = vaultAsSubdir ? path.join(repo, "vault") : repo;
  if (vaultAsSubdir) fs.mkdirSync(vault);

  // A file outside the vault, so a wrong-repository sync has something of the
  // user's to publish that it was never pointed at.
  fs.writeFileSync(path.join(repo, "outside.md"), "outside the vault\n");
  fs.writeFileSync(path.join(vault, "note.md"), "note\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["push", "-u", "origin", "main"]);
  return { root, remote, repo, vault };
}

function makePlugin(vaultPath, settings) {
  const app = {
    vault: { adapter: { getBasePath: () => vaultPath }, configDir: ".obsidian" },
    workspace: { onLayoutReady: () => {} },
  };
  const plugin = new PluginClass(app, { id: "vault-force-sync", dir: null });
  plugin.settings = Object.assign({}, BASE_SETTINGS, settings);
  plugin._data = plugin.settings;
  plugin.syncing = false;
  plugin.syncTimer = null;

  messages.length = 0;
  notices.length = 0;
  plugin.report = (msg) => {
    messages.push(String(msg));
  };
  plugin.notify = (msg) => {
    notices.push(String(msg));
  };
  return plugin;
}

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
};

const messages = [];
const refused = () => messages.some((m) => /Refusing to sync/.test(m));
const logOf = (repo) => git(repo, ["log", "--format=%s", "main"]).trim().split("\n").reverse();

// --- harness -----------------------------------------------------------------
const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function runOne(name, fn) {
  try {
    await fn();
    return ["PASS", name, ""];
  } catch (e) {
    return ["FAIL", name, e.message];
  }
}

// ============================================================================
// The vault must be the repository root
// ============================================================================
check("a vault nested inside a project is refused, and the project is untouched", async () => {
  const { repo, vault } = makeRepo({ vaultAsSubdir: true });
  const plugin = makePlugin(vault, {});

  const before = git(repo, ["rev-parse", "HEAD"]);
  const beforeStatus = git(repo, ["status", "--porcelain"]);

  await plugin.runSync();

  assert(refused(), `expected a refusal, got: ${JSON.stringify(messages)}`);
  assert(git(repo, ["rev-parse", "HEAD"]) === before, "the parent repository was committed to");
  assert(
    git(repo, ["status", "--porcelain"]) === beforeStatus,
    "the parent repository's working tree was modified"
  );
  // Nothing of ours was written either: refusing must leave the directory as found.
  assert(!fs.existsSync(path.join(vault, ".gitignore")), "a .gitignore was written before refusing");
});

check("the refusal names both paths and says what to do", async () => {
  const { repo, vault } = makeRepo({ vaultAsSubdir: true });
  const plugin = makePlugin(vault, {});

  await plugin.runSync();

  const msg = messages.find((m) => /Refusing to sync/.test(m)) || "";
  assert(msg.includes(vault), `the vault path is missing from: ${msg}`);
  assert(msg.includes(repo), `the repository root is missing from: ${msg}`);
  assert(/git init/.test(msg), `no remedy offered in: ${msg}`);
});

check("a vault that is its own repository root syncs normally", async () => {
  const { repo } = makeRepo();
  const plugin = makePlugin(repo, {});
  fs.writeFileSync(path.join(repo, "note.md"), "changed\n");

  await plugin.runSync();

  assert(!refused(), `refused a legitimate layout: ${JSON.stringify(messages)}`);
  assert(logOf(repo).includes("sync: " + logOf(repo).slice(-1)[0].replace("sync: ", "")), "no commit");
  assert(/^note\.md$/m.test(git(repo, ["show", "--name-only", "--format=", "HEAD"])), "the change was not committed");
});

check("a vault reached through a symlink is not mistaken for the wrong repository", async () => {
  // realpath on both sides, or a perfectly legitimate vault gets refused.
  const { repo } = makeRepo();
  const link = path.join(path.dirname(repo), "linked-vault");
  fs.symlinkSync(repo, link, "dir");
  const plugin = makePlugin(link, {});
  fs.writeFileSync(path.join(repo, "note.md"), "via symlink\n");

  await plugin.runSync();

  assert(!refused(), `a symlinked vault was refused: ${JSON.stringify(messages)}`);
});

check("pull refuses too, rather than integrating into a foreign repository", async () => {
  const { vault } = makeRepo({ vaultAsSubdir: true });
  const plugin = makePlugin(vault, {});

  await plugin.runPull();

  assert(refused(), `pull did not refuse: ${JSON.stringify(messages)}`);
});

check("status refuses too, rather than reporting a foreign branch", async () => {
  const { vault } = makeRepo({ vaultAsSubdir: true });
  const plugin = makePlugin(vault, {});

  await plugin.runStatus();

  assert(refused(), `status did not refuse: ${JSON.stringify(messages)}`);
});

// ============================================================================
// A force push must not destroy what it overwrites
// ============================================================================
function diverged() {
  const { repo, remote, vault } = makeRepo();
  // Remote-only commit: the work a force push would discard.
  const other = path.join(path.dirname(repo), "other");
  git(path.dirname(repo), ["clone", remote, other]);
  git(other, ["config", "user.email", "o@test.local"]);
  git(other, ["config", "user.name", "O"]);
  fs.writeFileSync(path.join(other, "remote-work.md"), "work only on the remote\n");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-m", "remote-only work"]);
  git(other, ["push", "origin", "main"]);
  const discarded = git(other, ["rev-parse", "HEAD"]).trim();

  // Local-only commit, so the branches genuinely diverged.
  fs.writeFileSync(path.join(vault, "note.md"), "local work\n");
  git(vault, ["add", "-A"]);
  git(vault, ["commit", "-m", "local work"]);

  return { repo, remote, vault, discarded };
}

check("a force push backs up what it overwrites, and the commit stays recoverable", async () => {
  const { repo, vault, discarded } = diverged();
  const plugin = makePlugin(vault, { pushMode: "force" });

  await plugin.runSync();

  const refs = git(vault, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/vault-force-sync/"])
    .trim()
    .split("\n")
    .filter(Boolean);
  assert(refs.length === 1, `expected 1 backup ref, found ${refs.length}`);
  assert(refs[0].endsWith(discarded), `backup points at ${refs[0]}, expected ${discarded}`);

  // The point of the ref: the discarded commit is still reachable, so it can be
  // brought back after the fact.
  const name = refs[0].split(" ")[0];
  assert(gitQuiet(vault, ["cat-file", "-e", discarded]).ok, "the discarded commit is gone");
  git(vault, ["branch", "recovered", name]);
  assert(
    git(vault, ["log", "--format=%s", "recovered"]).includes("remote-only work"),
    "the discarded remote commit is not recoverable from the backup"
  );
});

check("a normal push leaves no backup behind", async () => {
  const { vault } = makeRepo();
  const plugin = makePlugin(vault, {});
  fs.writeFileSync(path.join(vault, "note.md"), "ordinary change\n");

  await plugin.runSync();

  const refs = gitQuiet(vault, ["for-each-ref", "refs/vault-force-sync/"]);
  assert(refs.out.trim() === "", `a backup was created without a force push: ${refs.out}`);
});

check("old backups are pruned so the list cannot grow without bound", async () => {
  const { vault } = makeRepo();
  const plugin = makePlugin(vault, {});
  const head = git(vault, ["rev-parse", "HEAD"]).trim();

  // Distinct, chronologically sortable names, as the real ones are.
  for (const d of ["01", "02", "03", "04", "05", "06"]) {
    git(vault, ["update-ref", `refs/vault-force-sync/2020-01-${d}T00-00-00-000Z`, head]);
  }

  await plugin.pruneBackups(vault);

  const left = git(vault, ["for-each-ref", "--format=%(refname)", "refs/vault-force-sync/"])
    .trim()
    .split("\n")
    .filter(Boolean);
  assert(left.length === 5, `expected 5 kept, found ${left.length}`);
  assert(!left.some((r) => r.includes("2020-01-01")), "the oldest backup should have been pruned");
});

// ============================================================================
// A token in the remote URL is worth saying out loud
// ============================================================================
check("credentials embedded in the remote URL are flagged", async () => {
  const { vault } = makeRepo();
  const plugin = makePlugin(vault, { remoteUrl: "https://me:ghp_secret@example.invalid/x.git" });

  await plugin.ensureRemote(vault);

  assert(
    notices.some((n) => /contains credentials/.test(n)),
    `no warning was shown: ${JSON.stringify(notices)}`
  );
});

check("an ordinary remote URL, a bare username, or SSH is not flagged", async () => {
  const { vault } = makeRepo();
  const plugin = makePlugin(vault, {});

  for (const url of [
    "https://github.com/me/vault.git",
    "https://me@github.com/me/vault.git",
    "git@github.com:me/vault.git",
    "/srv/git/vault.git",
  ]) {
    notices.length = 0;
    plugin.settings.remoteUrl = url;
    plugin.warnedUrlCredentials = false;
    await plugin.ensureRemote(vault);
    assert(!notices.some((n) => /contains credentials/.test(n)), `false positive on: ${url}`);
  }
});

// ============================================================================
// Size-skip patterns must be released when they stop applying
// ============================================================================
const EXCLUDE = (vault) => path.join(vault, ".git", "info", "exclude");
const bigFile = (vault, name, megabytes) =>
  fs.writeFileSync(path.join(vault, name), Buffer.alloc(megabytes * 1024 * 1024 + 1, 0x41));

check("a file over the limit is skipped and listed as managed", async () => {
  const { vault } = makeRepo();
  const plugin = makePlugin(vault, { maxFileSizeMB: 1 });
  bigFile(vault, "big.bin", 2);
  fs.writeFileSync(path.join(vault, "small.md"), "small\n");

  await plugin.runSync();

  assert(!git(vault, ["ls-files"]).includes("big.bin"), "the large file was committed anyway");
  assert(git(vault, ["ls-files"]).includes("small.md"), "the small file should still have synced");
  const text = fs.readFileSync(EXCLUDE(vault), "utf8");
  assert(text.includes("/big.bin"), `not listed in .git/info/exclude:\n${text}`);
  assert(text.includes("# vault-force-sync"), "the block is not marked as managed");
});

check("raising the limit releases the pattern and the file syncs", async () => {
  const { vault } = makeRepo();
  bigFile(vault, "big.bin", 2);
  const plugin = makePlugin(vault, { maxFileSizeMB: 1 });

  await plugin.runSync();
  assert(!git(vault, ["ls-files"]).includes("big.bin"), "precondition: should be skipped");

  // The user raises the limit. An append-only list would keep the file out of the
  // repository forever, silently.
  plugin.settings.maxFileSizeMB = 5;
  await plugin.runSync();

  assert(git(vault, ["ls-files"]).includes("big.bin"), "the file never synced after the limit was raised");
  assert(
    !fs.readFileSync(EXCLUDE(vault), "utf8").includes("/big.bin"),
    "the stale pattern was left behind"
  );
});

check("a skipped file that is deleted loses its pattern", async () => {
  const { vault } = makeRepo();
  const plugin = makePlugin(vault, { maxFileSizeMB: 1 });
  bigFile(vault, "big.bin", 2);

  await plugin.runSync();
  assert(fs.readFileSync(EXCLUDE(vault), "utf8").includes("/big.bin"), "precondition: not listed");

  fs.unlinkSync(path.join(vault, "big.bin"));
  await plugin.runSync();

  assert(
    !fs.readFileSync(EXCLUDE(vault), "utf8").includes("/big.bin"),
    "the pattern for a deleted file was kept"
  );
});

check("lines the user wrote in .git/info/exclude survive untouched", async () => {
  const { vault } = makeRepo();
  const mine = "# my own rule\nmy-secret-folder/\n/also-mine.md\n";
  fs.mkdirSync(path.dirname(EXCLUDE(vault)), { recursive: true });
  fs.writeFileSync(EXCLUDE(vault), mine);
  const plugin = makePlugin(vault, { maxFileSizeMB: 1 });
  bigFile(vault, "big.bin", 2);

  await plugin.runSync();

  const text = fs.readFileSync(EXCLUDE(vault), "utf8");
  for (const line of ["# my own rule", "my-secret-folder/", "/also-mine.md"]) {
    assert(text.includes(line), `the user's line "${line}" was lost:\n${text}`);
  }
  assert(text.includes("/big.bin"), "our own entry is missing");

  // And again once the file is gone, so the rewrite is idempotent.
  fs.unlinkSync(path.join(vault, "big.bin"));
  await plugin.runSync();
  const after = fs.readFileSync(EXCLUDE(vault), "utf8");
  for (const line of ["# my own rule", "my-secret-folder/", "/also-mine.md"]) {
    assert(after.includes(line), `the user's line "${line}" was lost on the second pass:\n${after}`);
  }
});

// --- report ------------------------------------------------------------------
(async () => {
  const results = [];
  for (const [name, fn] of checks) results.push(await runOne(name, fn));
  let failed = 0;
  for (const [status, name, err] of results) {
    if (status === "FAIL") failed++;
    console.log(`${status}  ${name}`);
    if (err) console.log(`      ${err}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
