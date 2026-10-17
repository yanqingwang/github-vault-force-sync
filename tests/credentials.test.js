/**
 * Covers the optional personal-access-token path.
 *
 * The interesting failure modes here are all silent: a token that never reaches
 * git, a cached credential quietly winning over the configured one, or a token
 * written to disk. So the tests drive git's real credential-acquisition path
 * (`git credential fill`) rather than asserting on our own strings.
 *
 * Also covers configDir resolution: `Vault#configDir` is a folder *name*, and
 * `fs` resolves relative paths against process.cwd(), not the vault.
 */

const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");

const PLUGIN = path.join(__dirname, "..", "main.js");

// Results keep declaration order even when a check is async, so the report reads
// in the same order as the file.
const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}
async function runOne(name, fn) {
  try {
    await fn();
    return ["PASS", name, ""];
  } catch (e) {
    return ["FAIL", name, e.message];
  }
}
function assert(c, m) {
  if (!c) throw new Error(m);
}

// --- obsidian stub -----------------------------------------------------------
const spy = { secretComponents: [] };

function makeStub({ withSecretStorage = true, withSecretComponent = true } = {}) {
  spy.secretComponents = [];

  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
      this.settingTabs = [];
      this._data = {};
    }
    addCommand() {}
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
  }
  class Notice {}
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

  class SecretComponent {
    constructor(app, el) {
      this.app = app;
      this.el = el;
      this.value = null;
      this.cb = null;
      spy.secretComponents.push(this);
    }
    setValue(v) {
      this.value = v;
      return this;
    }
    onChange(cb) {
      this.cb = cb;
      return this;
    }
  }

  const stub = { Plugin, Notice, PluginSettingTab, Setting, Modal };
  if (withSecretComponent) stub.SecretComponent = SecretComponent;
  return { stub, withSecretStorage };
}

let current = makeStub();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "obsidian") return current.stub;
  return origLoad.apply(this, arguments);
};

function loadPlugin(opts) {
  current = makeStub(opts || {});
  delete require.cache[require.resolve(PLUGIN)];
  return require(PLUGIN);
}

// --- fixtures ----------------------------------------------------------------
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
  showSuccessNotice: false,
  enableLogging: false,
  maxFileSizeMB: 100,
};

let VAULT;
let CONFIG_REL;

/** A fake vault on a real directory, so the plugin can write its helper. */
function makeApp({ secrets = {}, withSecretStorage = true, configDir = CONFIG_REL } = {}) {
  const app = {
    vault: { adapter: { getBasePath: () => VAULT }, configDir },
    workspace: { onLayoutReady: () => {} },
    secretStorage: withSecretStorage
      ? {
          getSecret: (id) => (id in secrets ? secrets[id] : null),
          setSecret: (id, v) => {
            secrets[id] = v;
          },
          listSecrets: () => Object.keys(secrets),
        }
      : undefined,
  };
  return app;
}

async function boot(PluginClass, settingsPatch, appOpts) {
  const app = makeApp(appOpts);
  const plugin = new PluginClass(app, { id: "vault-force-sync", dir: null });
  plugin._data = Object.assign({}, DEFAULTS, settingsPatch);
  await plugin.onload();
  plugin.stopTimer();
  return { plugin, tab: plugin.settingTabs[0] };
}

function freshVault() {
  VAULT = fs.mkdtempSync(path.join(os.tmpdir(), "vfs-auth-"));
  return VAULT;
}
CONFIG_REL = ".obsidian";
freshVault();

const askpassPath = () => path.join(VAULT, CONFIG_REL, "plugins", "vault-force-sync", ".askpass.sh");

// --- resolveCredentials ------------------------------------------------------
check("no token configured leaves the default path untouched", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(PluginClass, {});
  assert(plugin.resolveCredentials().configured === false, "should not be configured");
  const auth = plugin.authFor();
  assert(auth.args.length === 0, `expected no extra args, got ${JSON.stringify(auth.args)}`);
  assert(auth.env === null, "expected no env override, so git keeps the ambient environment");
});

check("a configured token is read from SecretStorage, never from settings", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(
    PluginClass,
    { credentialSecretId: "gh-pat" },
    { secrets: { "gh-pat": "ghp_realtoken" } }
  );
  const cred = plugin.resolveCredentials();
  assert(cred.configured === true, "should be configured");
  assert(cred.token === "ghp_realtoken", "token not read from SecretStorage");
  assert(!cred.error, `unexpected error: ${cred.error}`);
});

check("the username defaults to a placeholder, because GitHub ignores it", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(
    PluginClass,
    { credentialSecretId: "gh-pat" },
    { secrets: { "gh-pat": "t" } }
  );
  assert(plugin.resolveCredentials().username === "x-access-token", "placeholder missing");
});

check("a configured username is honoured", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(
    PluginClass,
    { credentialSecretId: "gh-pat", credentialUsername: "yanqingwang" },
    { secrets: { "gh-pat": "t" } }
  );
  assert(plugin.resolveCredentials().username === "yanqingwang", "username ignored");
});

check("an old Obsidian without SecretStorage reports why, instead of failing to authenticate", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(
    PluginClass,
    { credentialSecretId: "gh-pat" },
    { secrets: {}, withSecretStorage: false }
  );
  const cred = plugin.resolveCredentials();
  assert(cred.configured === true, "the user's intent is recorded");
  assert(cred.error && /1\.11\.4/.test(cred.error), `error should name the version: ${cred.error}`);
});

check("a missing or empty secret is reported, not silently ignored", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(PluginClass, { credentialSecretId: "gh-pat" }, { secrets: {} });
  const cred = plugin.resolveCredentials();
  assert(cred.error && /gh-pat/.test(cred.error), `error should name the secret: ${cred.error}`);

  const { plugin: empty } = await boot(
    PluginClass,
    { credentialSecretId: "blank" },
    { secrets: { blank: "" } }
  );
  assert(empty.resolveCredentials().error, "an empty secret must not be treated as a token");
});

check("a credential problem stops the command rather than falling back silently", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(PluginClass, { credentialSecretId: "missing" }, { secrets: {} });
  let threw = false;
  try {
    plugin.authFor();
  } catch (e) {
    threw = /missing/.test(e.message);
  }
  assert(threw, "authFor should throw so the sync reports it instead of guessing");
});

// --- the askpass helper ------------------------------------------------------
check("the helper is written outside the vault's tracked files and holds no token", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(
    PluginClass,
    { credentialSecretId: "gh-pat" },
    { secrets: { "gh-pat": "ghp_realtoken" } }
  );
  plugin.authFor();

  const f = askpassPath();
  assert(fs.existsSync(f), `helper not written to ${f}`);
  const body = fs.readFileSync(f, "utf8");
  assert(!body.includes("ghp_realtoken"), "the token was written to disk");
  assert(body.includes("VFS_GIT_TOKEN"), "the helper should read the token from the environment");
  const mode = fs.statSync(f).mode & 0o777;
  assert((mode & 0o100) !== 0, `helper is not executable (mode ${mode.toString(8)})`);
});

check("the helper answers git's two prompts correctly", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(
    PluginClass,
    { credentialSecretId: "gh-pat", credentialUsername: "alice" },
    { secrets: { "gh-pat": "s3cret" } }
  );
  plugin.authFor();

  const run = (prompt) =>
    spawnSync("sh", [askpassPath(), prompt], {
      encoding: "utf8",
      env: Object.assign({}, process.env, {
        VFS_GIT_USERNAME: "alice",
        VFS_GIT_TOKEN: "s3cret",
      }),
    }).stdout.trim();

  assert(run("Username for 'https://github.com': ") === "alice", "username prompt answers wrong");
  assert(run("Password for 'https://alice@github.com': ") === "s3cret", "password prompt answers wrong");
});

check("git actually uses the helper to acquire credentials", async () => {
  // The real thing: drive git's own credential lookup for an https host and check
  // what comes back. A non-GitHub host keeps the result independent of whatever
  // this machine has configured.
  const PluginClass = loadPlugin();
  const { plugin } = await boot(
    PluginClass,
    { credentialSecretId: "gh-pat", credentialUsername: "alice" },
    { secrets: { "gh-pat": "s3cret" } }
  );
  const auth = plugin.authFor();

  const res = spawnSync("git", auth.args.concat(["credential", "fill"]), {
    input: "protocol=https\nhost=example.com\n\n",
    encoding: "utf8",
    env: auth.env,
  });
  assert(res.status === 0, `git credential fill failed: ${res.stderr}`);
  assert(/^username=alice$/m.test(res.stdout), `wrong username: ${res.stdout}`);
  assert(/^password=s3cret$/m.test(res.stdout), `wrong password: ${res.stdout}`);
});

check("with no token configured, git falls back to the machine's own helper", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(PluginClass, {});
  const auth = plugin.authFor();
  assert(auth.args.length === 0 && auth.env === null, "the default path must not be modified");

  // Sanity check on the machine we are running on: its helper answers, proving the
  // helper list was not cleared by accident.
  const res = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: "0" }),
  });
  assert(/^password=/m.test(res.stdout), "this machine's helper did not respond; other tests are less meaningful");
});

// --- configDir ---------------------------------------------------------------
check("a relative configDir is joined onto the vault", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(PluginClass, {}, { configDir: ".obsidian" });
  const p = plugin.getLogPath();
  assert(path.isAbsolute(p), `log path is not absolute: ${p}`);
  assert(p.startsWith(VAULT + path.sep), `log path left the vault: ${p}`);
});

check("a custom config folder name is honoured", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(PluginClass, {}, { configDir: "obsidian-config" });
  assert(plugin.getLogPath().includes("obsidian-config"), "custom config folder ignored");
});

check("an already-absolute configDir is used as-is", async () => {
  const PluginClass = loadPlugin();
  const abs = fs.mkdtempSync(path.join(os.tmpdir(), "vfs-cfg-abs-"));
  const { plugin } = await boot(PluginClass, {}, { configDir: abs });
  assert(plugin.getLogPath().startsWith(abs), `absolute configDir mangled: ${plugin.getLogPath()}`);
});

check("the log is actually written where getLogPath says", async () => {
  // The regression this guards: configDir is a name, and fs resolves relative
  // paths against process.cwd(), so an unjoined path silently writes elsewhere.
  const PluginClass = loadPlugin();
  const { plugin } = await boot(PluginClass, { enableLogging: true }, { configDir: ".obsidian" });
  fs.mkdirSync(path.join(VAULT, ".obsidian", "plugins", "vault-force-sync"), { recursive: true });
  plugin.log("hello from the test");
  const p = plugin.getLogPath();
  assert(fs.existsSync(p), `nothing was written to ${p}`);
  assert(fs.readFileSync(p, "utf8").includes("hello from the test"), "log content missing");
});

// --- settings row binding ----------------------------------------------------
check("the token row round-trips through SecretStorage", async () => {
  const PluginClass = loadPlugin();
  const { tab } = await boot(PluginClass, { credentialSecretId: "chosen" });

  const items = tab.getSettingDefinitions().flatMap((g) => g.items);
  const row = items.find((i) => i.name === "Personal access token");
  assert(row && typeof row.render === "function", "no rendered token row");

  // Mirrors the real `Setting`: setDesc() is chainable, which renderSecretRow relies on.
  const captured = [];
  const fakeSetting = {
    setDesc() {
      return this;
    },
    addComponent(fn) {
      captured.push(fn);
      return this;
    },
  };
  row.render(fakeSetting);
  assert(captured.length === 1, "the row did not add a component");

  captured[0]({}); // Obsidian hands the callback the host element.
  const comp = spy.secretComponents[spy.secretComponents.length - 1];
  assert(comp, "no SecretComponent was constructed");
  assert(comp.value === "chosen", `the stored secret name was not shown (got ${comp.value})`);

  // Selecting a different secret must reach settings through the write path.
  await new Promise((res) => {
    comp.cb("another");
    setTimeout(res, 0);
  });
  assert(tab.getControlValue("credentialSecretId") === "another", "selection did not persist");
  assert(tab.plugin._data.credentialSecretId === "another", "selection was not saved to disk");
});

check("the helper exists even when the token was never typed", async () => {
  const PluginClass = loadPlugin();
  const { plugin } = await boot(PluginClass, {}, { configDir: ".obsidian" });
  plugin.log("x");
  assert(plugin.getLogPath().length > 0, "log path unavailable");
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
