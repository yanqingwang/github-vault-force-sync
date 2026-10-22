/**
 * Covers the declarative settings API (Obsidian 1.13.0+ search) and the auto-sync timer.
 *
 * Neither is exercised by the git scenarios: a dropped setting definition is
 * silent (the setting simply cannot be found), and a timer bug only shows up as
 * syncs that never run or that overlap.
 */

const Module = require("module");
const path = require("path");

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
}
class Notice {
  constructor(m) {
    notices.push(m);
  }
  setMessage(m) {
    notices[notices.length - 1] = m;
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
Module._load = function (request) {
  if (request === "obsidian") return { Plugin, Notice, PluginSettingTab, Setting, Modal };
  return origLoad.apply(this, arguments);
};

const PluginClass = require(path.join(__dirname, "..", "main.js"));

// A real directory, so the plugin's log writer has somewhere to write and the
// harness output is not buried in ENOENT noise from a path that never existed.
const CFG = require("fs").mkdtempSync(require("os").tmpdir() + "/vfs-cfg-");
// In a real install this folder exists because main.js lives in it.
require("fs").mkdirSync(require("path").join(CFG, "plugins", "vault-force-sync"), { recursive: true });

const fakeApp = () => ({
  vault: { adapter: { getBasePath: () => "/tmp" }, configDir: CFG },
  workspace: { onLayoutReady: () => {} },
});

const results = [];
function assert(c, m) {
  if (!c) throw new Error(m);
}

const DEFAULTS = {
  remoteUrl: "",
  gitLocation: "",
  proxy: "",
  branch: "main",
  pushMode: "incremental",
  syncStrategy: "merge",
  autoSyncOnLoad: false,
  autoSyncIntervalMin: 0,
  autoAbortConflicts: true,
  credentialUsername: "",
  credentialSecretId: "",
  showSuccessNotice: true,
  enableLogging: true,
  maxFileSizeMB: 100,
  excludedFolders: [],
  syncOnlyFolders: [],
  excludeHiddenFiles: true,
  excludeDotFolders: true,
  excludeUnderscoreFiles: false,
  excludeUnderscoreFolders: false,
};

// Run the plugin's real onload so the tab under test is the one it actually
// registers -- not a re-implementation that could drift from it.
async function boot(settingsPatch) {
  const plugin = new PluginClass(fakeApp(), { id: "vault-force-sync", dir: null });
  plugin._data = Object.assign({}, DEFAULTS, settingsPatch);
  await plugin.onload();
  plugin.stopTimer();
  return { plugin, tab: plugin.settingTabs[0] };
}

const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}

// Control-backed keys. The token row is rendered rather than bound to a control
// (SecretComponent has no declarative type), so it is asserted separately.
const KEYS = [
  "remoteUrl",
  "gitLocation",
  "proxy",
  "branch",
  "pushMode",
  "syncStrategy",
  "autoSyncIntervalMin",
  "autoSyncOnLoad",
  "autoAbortConflicts",
  "credentialUsername",
  "maxFileSizeMB",
  "showSuccessNotice",
  "enableLogging",
  "excludeHiddenFiles",
  "excludeDotFolders",
  "excludeUnderscoreFiles",
  "excludeUnderscoreFolders",
];

// --- declarative definitions -------------------------------------------------
check("getSettingDefinitions exists", async () => {
  const { tab } = await boot();
  assert(typeof tab.getSettingDefinitions === "function", "method missing");
});

check("every persisted setting is advertised exactly once", async () => {
  const { tab } = await boot();
  const items = tab.getSettingDefinitions().flatMap((g) => g.items);
  const keys = items.filter((i) => i.control).map((i) => i.control.key);
  assert(new Set(keys).size === keys.length, "a key is advertised more than once");
  for (const k of KEYS) {
    assert(keys.includes(k), `setting "${k}" is not in the search index`);
  }
  // The token row carries no key because it is rendered. It still has to be
  // findable, and it must never hide itself: it is the on/off switch for the
  // whole credentials feature.
  const token = items.find((i) => i.name === "Personal access token");
  assert(token, "the token row is missing from the search index");
  assert(typeof token.render === "function", "the token row should be rendered, not bound");
  assert(token.visible === undefined, "the token row must always be visible");
});

check("every row has a name, because that is what search matches on", async () => {
  const { tab } = await boot();
  const items = tab.getSettingDefinitions().flatMap((g) => g.items);
  const unnamed = items.filter((i) => !i.name).length;
  assert(unnamed === 0, `${unnamed} row(s) have no name`);
});

check("dropdowns declare their options", async () => {
  const { tab } = await boot();
  const items = tab.getSettingDefinitions().flatMap((g) => g.items);
  const mode = items.find((i) => i.control && i.control.key === "pushMode");
  assert(mode.control.options.incremental, "pushMode lost its options");
  const strat = items.find((i) => i.control && i.control.key === "syncStrategy");
  assert(strat.control.options.merge && strat.control.options.rebase, "syncStrategy lost its options");
});

check("folder lists are rendered rows, not single-value controls", async () => {
  const { tab } = await boot();
  const items = tab.getSettingDefinitions().flatMap((g) => g.items);
  for (const name of ["Excluded folders", "Sync only these folders"]) {
    const row = items.find((i) => i.name === name);
    assert(row, `missing row: ${name}`);
    assert(typeof row.render === "function", `${name} has no renderer`);
    assert(row.control === undefined, `${name} should not be a control`);
  }
});

// --- read / write ------------------------------------------------------------
check("getControlValue reads the live value", async () => {
  const { tab } = await boot({ branch: "trunk" });
  assert(tab.getControlValue("branch") === "trunk", "did not read the stored value");
});

check("getControlValue falls back to the shipped default", async () => {
  const { tab, plugin } = await boot();
  delete plugin.settings.branch;
  assert(tab.getControlValue("branch") === "main", "unknown key did not fall back");
});

check("setControlValue persists", async () => {
  const { tab, plugin } = await boot();
  await tab.setControlValue("branch", "trunk");
  assert(tab.plugin.settings.branch === "trunk", "value not stored");
  assert(tab.plugin._data.branch === "trunk", "value not persisted to data");
});

check("text values are trimmed", async () => {
  const { tab } = await boot();
  await tab.setControlValue("remoteUrl", "  https://x/y.git  ");
  assert(tab.plugin.settings.remoteUrl === "https://x/y.git", `got ${JSON.stringify(tab.plugin.settings.remoteUrl)}`);
});

check("numbers arriving as strings become integers", async () => {
  const { tab } = await boot();
  await tab.setControlValue("autoSyncIntervalMin", "12");
  assert(tab.plugin.settings.autoSyncIntervalMin === 12, `got ${typeof tab.plugin.settings.autoSyncIntervalMin}`);
});

check("an unusable number falls back to the default instead of persisting garbage", async () => {
  const { tab } = await boot();
  await tab.setControlValue("autoSyncIntervalMin", "abc");
  assert(tab.plugin.settings.autoSyncIntervalMin === 5, `got ${tab.plugin.settings.autoSyncIntervalMin}`);
  await tab.setControlValue("autoSyncIntervalMin", "-3");
  assert(tab.plugin.settings.autoSyncIntervalMin === 5, `negative became ${tab.plugin.settings.autoSyncIntervalMin}`);
});

check("maxFileSizeMB refuses zero, which would skip every file", async () => {
  const { tab } = await boot();
  await tab.setControlValue("maxFileSizeMB", 0);
  assert(tab.plugin.settings.maxFileSizeMB === 100, `got ${tab.plugin.settings.maxFileSizeMB}`);
  await tab.setControlValue("maxFileSizeMB", 250);
  assert(tab.plugin.settings.maxFileSizeMB === 250, "a valid size was rejected");
});

check("folder paths are normalized, de-duplicated, and root is refused", async () => {
  const { tab } = await boot();
  assert(await tab.addFolder("excludedFolders", "  Notes\\Archive/  "), "a valid folder was refused");
  assert(
    JSON.stringify(tab.plugin.settings.excludedFolders) === JSON.stringify(["Notes/Archive"]),
    `not normalized: ${JSON.stringify(tab.plugin.settings.excludedFolders)}`
  );
  assert(!(await tab.addFolder("excludedFolders", "Notes/Archive")), "a duplicate was accepted");
  for (const bad of ["", ".", "/", "Notes/../Secret", "./"]) {
    assert(!(await tab.addFolder("excludedFolders", bad)), `the root/escaping path "${bad}" was accepted`);
  }
  assert(
    tab.plugin.settings.excludedFolders.length === 1,
    "a rejected path changed the stored list"
  );

  await tab.setControlValue("syncOnlyFolders", [" Notes/ ", "Notes", "Other"]);
  assert(
    JSON.stringify(tab.plugin.settings.syncOnlyFolders) === JSON.stringify(["Notes", "Other"]),
    `list values were not normalized: ${JSON.stringify(tab.plugin.settings.syncOnlyFolders)}`
  );

  await tab.removeFolder("excludedFolders", "Notes/Archive");
  assert(tab.plugin.settings.excludedFolders.length === 0, "remove did not persist");
});

check("validation rejects what coerce would silently fix", async () => {
  const { tab } = await boot();
  const items = tab.getSettingDefinitions().flatMap((g) => g.items);
  const v = (key) => items.find((i) => i.control && i.control.key === key).control.validate;
  assert(v("autoSyncIntervalMin")(-1), "negative interval accepted");
  assert(v("autoSyncIntervalMin")(0) === undefined, "0 is a valid interval (timer off)");
  assert(v("maxFileSizeMB")(0), "0 MB accepted");
  assert(v("autoAbortConflicts") === undefined, "a toggle should not need validation");
});

// --- timer -------------------------------------------------------------------
check("a positive interval arms the timer", () => {
  const plugin = new PluginClass(fakeApp(), { id: "vault-force-sync" });
  plugin.settings = { autoSyncIntervalMin: 7, enableLogging: false };
  plugin.syncing = false;
  let armed = 0;
  const realSet = global.setInterval;
  global.setInterval = (fn, ms) => {
    armed++;
    return realSet(fn, ms);
  };
  plugin.startTimer();
  global.setInterval = realSet;
  plugin.stopTimer();
  assert(armed === 1, `expected one interval, got ${armed}`);
});

check("interval 0 arms nothing", () => {
  const plugin = new PluginClass(fakeApp(), { id: "vault-force-sync" });
  plugin.settings = { autoSyncIntervalMin: 0, enableLogging: false };
  plugin.syncing = false;
  let armed = 0;
  const realSet = global.setInterval;
  global.setInterval = () => {
    armed++;
    return 1;
  };
  plugin.startTimer();
  global.setInterval = realSet;
  assert(armed === 0, "the timer was armed even though the interval is 0");
});

check("changing the interval does not leak the old one", () => {
  // The regression this guards: each change arms a second interval and the old
  // one keeps firing forever, so syncs multiply with every visit to the settings.
  const plugin = new PluginClass(fakeApp(), { id: "vault-force-sync" });
  plugin.settings = { autoSyncIntervalMin: 5, enableLogging: false };
  plugin.syncing = false;
  let live = 0;
  const handles = new Set();
  const realSet = global.setInterval;
  const realClear = global.clearInterval;
  global.setInterval = () => {
    const h = { id: live++ };
    handles.add(h);
    return h;
  };
  global.clearInterval = (h) => handles.delete(h);
  plugin.startTimer();
  plugin.settings.autoSyncIntervalMin = 9;
  plugin.startTimer();
  plugin.settings.autoSyncIntervalMin = 2;
  plugin.startTimer();
  const stillLive = handles.size;
  plugin.stopTimer();
  global.setInterval = realSet;
  global.clearInterval = realClear;
  assert(stillLive === 1, `expected exactly one live timer, got ${stillLive}`);
});

check("unload clears the timer", () => {
  const plugin = new PluginClass(fakeApp(), { id: "vault-force-sync" });
  plugin.settings = { autoSyncIntervalMin: 5, enableLogging: false };
  plugin.syncing = false;
  plugin.startTimer();
  assert(plugin.syncTimer !== null, "timer not armed");
  plugin.onunload();
  assert(plugin.syncTimer === null, "onunload left the timer running");
});

// --- log path ----------------------------------------------------------------
check("the log path follows configDir, not a hard-coded .obsidian", () => {
  const moved = new PluginClass(
    { vault: { configDir: "/srv/notes-config" }, workspace: {} },
    { id: "vault-force-sync" }
  );
  moved.settings = { enableLogging: true };
  const p = moved.getLogPath();
  assert(p.includes("notes-config"), `log path ignored configDir: ${p}`);
  assert(!p.includes(".obsidian"), `log path still hard-codes .obsidian: ${p}`);
});

// --- report ------------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${e.message}`);
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();