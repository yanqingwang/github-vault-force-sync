/**
 * Exercises the plugin's real git sequence against real repositories.
 *
 * The feature under test is "pull and push automatically, standard delta flow".
 * Nothing short of real repos proves that: a merge that silently conflicts, or a
 * push that runs before the pull, is invisible to unit tests with mocked git.
 *
 * Scenarios simulated as two devices on one bare remote:
 *   1. only local changed            -> push only
 *   2. only remote changed           -> pull only (fast-forward)
 *   3. both changed, different files -> integrate then push; both converge
 *   4. both changed, same file       -> conflict; must not corrupt notes
 *   5. rebase strategy               -> same outcome as merge, linear history
 *   6. force mode                    -> remote overwritten on request
 */

const Module = require("module");
const { execFileSync, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// --- stub `obsidian` so the plugin can be required outside the app -----------
const notices = [];
class Plugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.commands = [];
    this.ribbons = [];
    this.settingTabs = [];
    this._data = {};
  }
  addCommand(c) {
    this.commands.push(c);
    return c;
  }
  addRibbonIcon(icon, title, cb) {
    this.ribbons.push({ icon, title, cb });
  }
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
    notices.push(msg);
  }
  setMessage(msg) {
    notices[notices.length - 1] = msg;
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
class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = { empty() {} };
  }
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return { Plugin, Notice, PluginSettingTab, Setting, Modal };
  return origLoad.apply(this, arguments);
};

const PluginClass = require(path.join(__dirname, "..", "main.js"));

// --- helpers -----------------------------------------------------------------
const sh = (cwd, cmd) => execFileSync("git", cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function shQuiet(cwd, cmd) {
  try {
    return { ok: true, out: sh(cwd, cmd) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

let ROOT;
function makeRepos() {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "vfs-"));
  const remote = path.join(ROOT, "remote.git");
  fs.mkdirSync(remote);
  sh(remote, ["init", "--bare", "-b", "main"]);

  const a = path.join(ROOT, "deviceA");
  const b = path.join(ROOT, "deviceB");
  for (const [dir, who] of [[a, "A"], [b, "B"]]) {
    fs.mkdirSync(dir);
    sh(dir, ["init", "-b", "main"]);
    sh(dir, ["config", "user.email", `${who.toLowerCase()}@test.local`]);
    sh(dir, ["config", "user.name", who]);
    sh(dir, ["remote", "add", "origin", remote]);
  }

  // Seed the remote from A so both devices share a base commit.
  fs.writeFileSync(path.join(a, "base.md"), "base\n");
  sh(a, ["add", "-A"]);
  sh(a, ["commit", "-m", "base"]);
  sh(a, ["push", "-u", "origin", "main"]);
  sh(b, ["fetch", "origin"]);
  sh(b, ["reset", "--hard", "origin/main"]);
  sh(b, ["branch", "--set-upstream-to=origin/main", "main"]);
  return { remote, a, b };
}

/** Build a plugin instance bound to a device directory. */
function makePlugin(vaultPath, settings) {
  const app = {
    vault: {
      adapter: {
        getBasePath: () => vaultPath,
      },
    },
    workspace: { onLayoutReady: () => {} },
  };
  const plugin = new PluginClass(app, { id: "vault-force-sync", dir: null });
  plugin.settings = Object.assign({}, settings);
  plugin._data = plugin.settings;
  plugin.syncing = false;
  plugin.syncTimer = null;
  // Silence the UI: this harness asserts on git state, not on notices.
  plugin.notify = () => {};
  plugin.report = function (msg) {
    plugin.log(msg);
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
};

const logOf = (repo) => sh(repo, ["log", "--format=%s", "main"]).trim().split("\n").reverse();

// --- scenarios ---------------------------------------------------------------
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(["PASS", name, ""]);
  } catch (e) {
    results.push(["FAIL", name, e.message]);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function scenario(name, settingsPatch, mutate, verify) {
  check(name, async () => {
    const { a, b } = makeRepos();
    mutate({ a, b });
    const plugin = makePlugin(a, Object.assign({}, BASE_SETTINGS, settingsPatch));
    plugin._data = plugin.settings;
    return plugin.runSync().then(() => verify({ a, b, plugin }));
  });
}

(async () => {
  const run = async (name, settingsPatch, mutate, verify) => {
    try {
      const { a, b } = makeRepos();
      mutate({ a, b });
      const plugin = makePlugin(a, Object.assign({}, BASE_SETTINGS, settingsPatch));
      await plugin.runSync();
      await verify({ a, b, plugin });
      results.push(["PASS", name, ""]);
    } catch (e) {
      results.push(["FAIL", name, e.message]);
    }
  };

  const assertThrows = async (fn) => {
    try {
      await fn();
    } catch (e) {
      return;
    }
    throw new Error("expected an assertion to fail, but everything passed");
  };

  // 1. only local changed -> push
  await run(
    "only local changed -> local commit reaches the remote",
    {},
    ({ a }) => {
      fs.writeFileSync(path.join(a, "local.md"), "local only\n");
    },
    ({ a, b }) => {
      assert(fs.existsSync(path.join(b, "local.md")) === false, "device B should not see it yet");
      sh(b, ["fetch", "origin"]);
      sh(b, ["reset", "--hard", "origin/main"]);
      assert(fs.existsSync(path.join(b, "local.md")), "device B should see local.md after pulling");
    }
  );

  // 2. only remote changed -> pull
  await run(
    "only remote changed -> remote commit is pulled down",
    {},
    ({ b }) => {
      fs.writeFileSync(path.join(b, "remote.md"), "from device B\n");
      sh(b, ["add", "-A"]);
      sh(b, ["commit", "-m", "remote change"]);
      sh(b, ["push"]);
    },
    ({ a }) => {
      assert(fs.existsSync(path.join(a, "remote.md")), "device A should have pulled remote.md");
      assert(
        logOf(a).includes("remote change"),
        "the remote commit should be in A's history, not squashed away"
      );
    }
  );

  // 3. diverged, different files -> merge then push; both converge
  await run(
    "both changed different files -> integrate then push, devices converge",
    {},
    ({ a, b }) => {
      fs.writeFileSync(path.join(a, "from-a.md"), "a\n");
      sh(a, ["add", "-A"]);
      sh(a, ["commit", "-m", "a change"]);
      fs.writeFileSync(path.join(b, "from-b.md"), "b\n");
      sh(b, ["add", "-A"]);
      sh(b, ["commit", "-m", "b change"]);
      sh(b, ["push"]);
    },
    ({ a, b }) => {
      assert(fs.existsSync(path.join(a, "from-b.md")), "A should have pulled B's file");
      assert(fs.existsSync(path.join(a, "from-a.md")), "A should still have its own file");
      sh(b, ["fetch", "origin"]);
      sh(b, ["reset", "--hard", "origin/main"]);
      assert(fs.existsSync(path.join(b, "from-a.md")), "B should have received A's file");
      const la = sh(a, ["rev-parse", "main"]).trim();
      const lb = sh(b, ["rev-parse", "main"]).trim();
      assert(la === lb, `devices diverged: ${la} vs ${lb}`);
    }
  );

  // 4. conflict -> must not corrupt notes, must not push
  await run(
    "both changed the same file -> conflict is rolled back, notes intact, nothing pushed",
    {},
    ({ a, b }) => {
      fs.writeFileSync(path.join(a, "shared.md"), "line from A\n");
      sh(a, ["add", "-A"]);
      sh(a, ["commit", "-m", "a edits shared"]);
      fs.writeFileSync(path.join(b, "shared.md"), "line from B\n");
      sh(b, ["add", "-A"]);
      sh(b, ["commit", "-m", "b edits shared"]);
      sh(b, ["push"]);
    },
    ({ a, b }) => {
      const content = fs.readFileSync(path.join(a, "shared.md"), "utf8");
      assert(
        !content.includes("<<<<<<<") && !content.includes(">>>>>>>"),
        `conflict markers left in the note: ${JSON.stringify(content)}`
      );
      assert(content.trim() === "line from A", `local note should be untouched, got ${JSON.stringify(content)}`);
      // No merge left dangling, so the next sync can run.
      const busy = shQuiet(a, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      assert(!busy.ok, "a merge is still in progress after a conflicted sync");
      // And the remote must not have been touched.
      const remoteHead = sh(path.join(ROOT, "remote.git"), ["rev-parse", "main"]).trim();
      const bHead = sh(b, ["rev-parse", "main"]).trim();
      assert(remoteHead === bHead, "the remote was modified despite the conflict");
    }
  );

  // 5. rebase strategy produces the same convergence
  await run(
    "rebase strategy -> same convergence, linear history",
    { syncStrategy: "rebase" },
    ({ a, b }) => {
      fs.writeFileSync(path.join(a, "from-a.md"), "a\n");
      sh(a, ["add", "-A"]);
      sh(a, ["commit", "-m", "a change"]);
      fs.writeFileSync(path.join(b, "from-b.md"), "b\n");
      sh(b, ["add", "-A"]);
      sh(b, ["commit", "-m", "b change"]);
      sh(b, ["push"]);
    },
    ({ a, b }) => {
      assert(fs.existsSync(path.join(a, "from-b.md")), "A should have pulled B's file");
      sh(b, ["fetch", "origin"]);
      sh(b, ["reset", "--hard", "origin/main"]);
      const la = sh(a, ["rev-parse", "main"]).trim();
      const lb = sh(b, ["rev-parse", "main"]).trim();
      assert(la === lb, `devices diverged under rebase: ${la} vs ${lb}`);
      // Rebase means no merge commit was introduced.
      const merges = sh(a, ["log", "--merges", "--format=%H", "main"]).trim();
      assert(merges === "", `rebase should not create a merge commit, found: ${merges}`);
    }
  );

  // 6. force mode overwrites the remote and skips integration
  await run(
    "force mode -> remote overwritten, remote change discarded (as requested)",
    { pushMode: "force" },
    ({ a, b }) => {
      fs.writeFileSync(path.join(a, "shared.md"), "line from A\n");
      sh(a, ["add", "-A"]);
      sh(a, ["commit", "-m", "a edits shared"]);
      fs.writeFileSync(path.join(b, "shared.md"), "line from B\n");
      sh(b, ["add", "-A"]);
      sh(b, ["commit", "-m", "b edits shared"]);
      sh(b, ["push"]);
    },
    ({ a }) => {
      const content = fs.readFileSync(path.join(a, "shared.md"), "utf8");
      assert(content.trim() === "line from A", "A's own content should win under force");
      assert(
        !logOf(a).includes("b edits shared"),
        "force should have discarded the remote commit, not merged it"
      );
    }
  );

  // 7. an unresolved merge blocks the next sync
  await run(
    "an unresolved merge blocks the next sync instead of committing markers",
    { autoAbortConflicts: false },
    ({ a, b }) => {
      fs.writeFileSync(path.join(a, "shared.md"), "line from A\n");
      sh(a, ["add", "-A"]);
      sh(a, ["commit", "-m", "a edits shared"]);
      fs.writeFileSync(path.join(b, "shared.md"), "line from B\n");
      sh(b, ["add", "-A"]);
      sh(b, ["commit", "-m", "b edits shared"]);
      sh(b, ["push"]);
    },
    ({ a }) => {
      // autoAbortConflicts is off, so the merge is deliberately left in place.
      const busy = shQuiet(a, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
      assert(busy.ok, "the merge should still be in progress when auto-abort is off");

      const plugin = makePlugin(a, Object.assign({}, BASE_SETTINGS, { autoAbortConflicts: false }));
      const before = logOf(a).length;
      return plugin.runSync().then(() => {
        assert(
          logOf(a).length === before,
          "a second sync ran despite an unresolved merge — it would have committed conflict markers"
        );
      });
    }
  );

  // 8. re-entrancy guard
  {
    const { a, b } = makeRepos();
    fs.writeFileSync(path.join(a, "x.md"), "x\n");
    const plugin = makePlugin(a, BASE_SETTINGS);
    plugin.syncing = true;
    const before = logOf(a).length;
    await plugin.runSync();
    results.push([
      logOf(a).length === before ? "PASS" : "FAIL",
      "a sync triggered while another is running is dropped, not queued",
      "",
    ]);
  }

  // --- report ---------------------------------------------------------------
  let failed = 0;
  for (const [status, name, err] of results) {
    if (status === "FAIL") failed++;
    console.log(`${status}  ${name}`);
    if (err) console.log(`      ${err}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(1);
});