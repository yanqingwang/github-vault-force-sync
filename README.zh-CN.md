# Vault Force Sync

[English](README.md) | **简体中文**

一个 [Obsidian](https://obsidian.md) 插件：调用系统 `git`，让整个 vault 与一个 GitHub 仓库保持同步。它是**双向**的——把另一台设备上的改动拉下来，把本机的改动推上去；只传上次同步以来的增量；需要时可以强推；超过 100 MB 的文件自动跳过，所以同步不会卡死；并且保留一份随时可看的本地日志。

笔记是这里唯一无法重新生成的东西，所以整个设计都围绕一条约束：**绝不让插件成为你丢失笔记的原因**。下文全部服从于这一点，详见[插件保证什么](#插件保证什么)。

## 插件保证什么

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

**token 不会落到磁盘上。**
它存在 Obsidian 的 SecretStorage 里，通过环境变量交给 git，绝不写进 `.git/config`、remote URL 或仓库。而一个**确实**内嵌了凭证的 remote URL 会被点出来——因为 git 会把那个 URL 原样存进 `.git/config`。

## 功能

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
- **点文件留在本地**——写入 `.gitignore`（`.*` + `!/.gitignore`），让 `.obsidian` 及其他隐藏文件/目录永不被跟踪。
- **没有 credential helper 也能用**——机器上没配 `gh`/钥匙串/凭据管理器时，选一个 personal access token（存在 Obsidian 的 SecretStorage 里，不在 vault 中），插件就用它认证。
- **同步日志**——每一轮都记进 `sync.log`（仅本地，从不提交），可从命令面板或设置里查看。
- **可选代理**——网络需要的话，给 git 配一个 HTTP(S) 代理。

## 一轮同步是怎么跑的

顺序是刻意安排的：

```
暂存（git add -A）→ 提交 → fetch → 整合远端 → 推送
```

**先提交，再整合。** `git rebase` 在有未暂存改动时会直接拒绝运行；而 merge 则不得不把我们刚做的提交拿去和远端解冲突。先暂存保证整合时工作区是干净的，本地改动作为一个整体被合并。

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

## 环境要求

- Obsidian **桌面版**（插件使用 Node.js API，标注为 `isDesktopOnly`）。
- 已安装 `git` 且可访问（在 `PATH` 里，或在设置里填完整路径）。
- 你的 vault 必须**是**一个 git 仓库——它自己的仓库，且 vault 位于仓库根。还没有仓库的话，在 vault 里跑一次 `git init`，插件随后会替你配好 `origin`。仅仅**位于**另一个仓库**内部**的 vault 会被拒绝：同步它会发布那整个项目，而不只是这个 vault。
- 一个用于同步的 GitHub 仓库，且推送权限已配好（HTTPS 配 credential helper，或 SSH——你本地 git 现在能用的那种就行）。

## 认证

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

## 安装

### 从社区插件目录

> 尚未上架——插件正在提交审核。在它出现在社区目录之前，请用下面的手动安装或 BRAT。

### 手动安装

1. 从[最新 release](https://github.com/yanqingwang/github-vault-force-sync/releases) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 创建 `<vault>/.obsidian/plugins/vault-force-sync/`，把三个文件拷进去。
3. 重载 Obsidian，在 设置 → 第三方插件 里启用 **Vault Force Sync**。

### 用 BRAT 做 beta 测试

在 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 里把 `yanqingwang/github-vault-force-sync` 添加为 beta 插件。

## 使用

1. 启用插件，然后打开 **设置 → Vault Force Sync**。
2. 把 **Remote URL** 设成你的 GitHub 仓库（例如 `https://github.com/user/vault-backup.git`）。留空则保留已有的 `origin`。
3. 可选地设置 **Git location**（git 可执行文件的完整路径）、**代理**、**分支**、**最大文件大小**。
4. 想让它自己跑，就打开 **每 N 分钟自动同步**。
5. 点侧边栏的刷新图标，或运行下列命令之一：

| 命令 | 作用 |
|------|------|
| Sync vault with remote（拉 + 推） | fetch、整合你缺的、推送你有的。 |
| Pull remote changes only | 只 fetch 和整合；从不提交或推送。适合先看看另一台设备做了什么。 |
| Show sync status | 分支、短 SHA、领先/落后多少、未提交文件数。 |
| Force push all data to remote | 提交 + `git push --force-with-lease`，丢弃远端提交。 |
| Open sync log | 查看 `sync.log` 最后 300 行。 |

## 插件会往系统里写什么

- `<vault>/.gitignore`——仅在缺失时创建（`.*` / `!/.gitignore`）。
- `<vault>/.git/info/exclude`——超限文件记在一个带标记、由插件管理的块里，免得每轮同步都变慢。该块每轮重写，一旦不再适用就释放；**你自己在这个文件里写的内容原封不动。** 从不提交。
- 本地仓库里的 `refs/vault-force-sync/<时间戳>`——强推前对远端做的快照。仅本地，从不推送；保留最近 5 个。
- 仓库内的 git 配置：`http.postBuffer`，以及**仅在你配置了代理时**的 `http.proxy` / `https.proxy`。
- `<配置目录>/plugins/vault-force-sync/sync.log`——同步日志。
- `<配置目录>/plugins/vault-force-sync/.askpass.sh`（Windows 上是 `.askpass.cmd`）——**仅在配置了 token 时**。它从环境变量读取 token 而不是把 token 写在自己里面，所以磁盘上没有机密。它是个点文件，因此无论你的配置目录叫什么，都会被插件写入的 `.*` 规则挡在跟踪之外；它也可以随手删掉——下次同步会重写。

配置目录就是 `Vault#configDir`，除非你改过名，否则是 `.obsidian`。插件从不假定这个名字。

除了拉取远端改动、以及解决你要求它解决的冲突之外，插件从不改写你笔记的内容——而且即使是后者，它也是回滚，而不是留下标记。

## 安全说明

上面那些保证是承重的。这里是围绕它们的操作细节。

- **没被忽略的东西都会被提交并推送。** 插件用 `git add -A` 暂存，所以 vault 里任何没被 `.gitignore` 或 `.git/info/exclude` 覆盖的文件都会进提交并到达远端。机密别放进 vault，或者把它忽略掉——笔记里的 token 就是 GitHub 上的 token。
- 两次同步绝不重叠：同步进行中到来的触发会被**丢弃**而不是排队。没有这个，定时器和手动点击会并发跑在同一个 index 上。
- 超过上限的文件会以通知形式报告并跳过；其余一切照常同步。
- 插件从不碰配置目录，所以每台设备各自的设置（包括本插件自己的设置）不会被同步。
- **公开仓库会让整个 vault 公开。** 如果你同步到任何人都能读的地方，先确认里面有什么。

## 设置参考

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
| 最大文件大小（MB） | `100` | 更大的文件会被跳过。GitHub 的硬限制是 100 MB。 |
| 成功时显示通知 | 开 | 每次成功同步后弹一个通知。 |
| 启用日志 | 开 | 把同步结果写进 `sync.log`。 |

在 Obsidian 1.13.0 及以后，设置会出现在设置的**搜索**里；更老的版本仍走 `display()`。两条路径读同一张表，所以它们不可能对「有哪些设置」产生分歧。

## 开发

没有构建步骤——`main.js` 就是源码，手写的 CommonJS，由 Obsidian 直接加载。

```bash
node --check main.js   # 语法检查
sh tests/run.sh        # 全部测试，57 项
```

`tests/run.sh` 除了 Node 和 `git` 之外不需要安装任何东西：

| 文件 | 覆盖内容 | 项数 |
|------|----------|------|
| `tests/sync.test.js` | 共享一个裸远端的两台设备：仅本地改、仅远端改（fast-forward）、干净分叉、冲突回滚、rebase、强制、未解决 merge 阻塞下一轮、重入 | 8 |
| `tests/settings.test.js` | 声明式定义与搜索索引、读写、校验、定时器生命周期、日志路径解析 | 17 |
| `tests/credentials.test.js` | 凭证解析、SecretStorage 缺失/为空、生成的 helper 不含 token、git 自己的凭证获取、`configDir` 的各种形态 | 17 |
| `tests/safety.test.js` | vault 不是其仓库根时拒绝（并验证那个项目未被改动）、强推备份与恢复、备份清理、remote URL 内嵌凭证、大小跳过规则的释放、`.git/info/exclude` 里用户自己的行不被破坏 | 15 |

这些不是对着 mock git 写的单元测试。一个悄悄冲突了的 merge，或者一个跑在 pull 之前的 push，对 stub 来说都是不可见的——所以每个场景都创建真实仓库、真实的裸远端，并驱动真实的二进制。凭证测试会跑 `git credential fill`，对 git 实际交回来的东西做断言。安全测试会构造出那个让「仓库根检查」成为必需的真实嵌套 vault 布局，然后断言父项目逐字节未被改动。

## 许可证

[MIT](./LICENSE)
