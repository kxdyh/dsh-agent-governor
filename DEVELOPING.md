# Developing dsh-agent-governor 开发文档

> 面向贡献者。面向用户的说明见 [README.md](README.md)。

## 它注册了什么

| Slot 插槽 | Kind | Scope | Entry id | Order | 说明 |
|---|---|---|---|---|---|
| `conversation.session.header.utilities` | list | session | `agent-governor` | -20 | 会话标题栏右侧的盾牌（收纳开关）。已装条目 `open-in-app` 是 -10、`session-log-download` 是 0，-20 让它落在它们左侧 |
| `conversation.session.header.utilities` | list | session | `agent-governor-log` | -19 | 盾牌旁边的**拦截记录**按钮（账本图标 + 计数）。点开是公共记录浮层：哪一步被拦、为什么 |
| `conversation.header.leading` | single | root | 无 | – | **兜底席位**：这是标题栏里唯一"没有会话也存在"的槽。平时返回 `null`，只有当浮层探针判定"浮层里的按钮其实没显示"（见下）时才渲染，因此永远不会出现重复按钮 |
| `shell.overlay` | list | root | `agent-governor-panel` | 201 | 开关浮层。浮层本身是 click-through，条目自己 opt-in 指针事件；用 `position:fixed` 从触发器 rect 定位，因此不受标题栏 overflow 裁剪 |
| `shell.overlay` | list | root | `agent-governor-log-panel` | 202 | 拦截记录浮层（比开关浮层宽 56px，给"理由"留位置） |
| `shell.overlay` | list | root | `agent-governor-fallback` | 190 | 没有选中会话时（Hero 页），在右上角浮层同时提供上面两个按钮（`.agov-fallback-host` 全屏宿主 + `.agov-fallback-row` 定位） |

**注册存在 ≠ 控件可见。** 槽系统只能告诉你条目已经挂上，不能告诉你它是否真的画在屏幕上：
浮层可能被裁剪、被盖住，或者某个带 `transform`/`filter`/`contain` 的祖先会把 `position: fixed`
变成"相对该祖先固定"。所以每个盾牌挂载后 400ms 会自检一次（`probePlacement`）：
读 `getBoundingClientRect()`、`getComputedStyle`、最近的变换祖先，并用
`document.elementFromPoint(中心)` 判断自己是否在最上层；结果同时 POST 到 `/diag` 并写入快照的
`diag` 字段。浮层自检失败时会自动切到上面的兜底席位 —— 用户永远有入口，而我们拿到的是数据而不是猜测。
`SeatBoundary` 也做同样的事：某个席位渲染抛错时会**上报**并把兜底席位打开，而不是静默什么都不显示。

全部是**追加**（`replaceRisk: none`），不替换任何自带界面。DOL 的政策注入是向
`system-prompt` 追加一个 section（order 55），不替换既有 section。

## 用到的宿主扩展点

| 事件 / 服务 | 模式 | 我们做什么 | 返回 |
|---|---|---|---|
| `tools/pre-execute` | waterfall | Sentinel 门控：确定性规则 + 证据比对 | `next()` 放行，或 `{kind:'deny', reason, info}` |
| `tools/post-execute` | waterfall | 收集证据（真实工具返回、成功调用指纹） | 原样透传 `next()` 的决定 |
| `agent/pre-step` | waterfall | 把用户消息纳入"地面真值"数值集合 | `next()` |
| `agent/assistant-stream` | emit | DOL 出站审计：按 attempt 累积文本，提交时判定 | 无（只读广播） |
| `system-prompt.section()` | service | 注入道义规则 + 待纠正项（文本取值为函数，每次组装实时求值） | disposer |
| `webServer.register()` | service | `prefix /dsh-agent-governor`，仅回环可访问 | disposer |

所有规则 **fail-open**：任何一条规则抛错都只记日志，调用照常放行 —— 治理不该成为新的故障源。

## 证据缓存（Evidence Cache）

- 每会话一个：用户消息文本、工具真实返回、执行过的调用参数 → 抽取数字集合（`numbers`）。
- `evidence` 只保留最近 **240** 条；会话最多 **32** 个（LRU）；数字集合上限 6000。
- 结果快照按截图里的策略**截中间而不是截尾部**（保留列头和样本行）：默认 800 字符，
  头 60% ＋ 尾 40%。
- 参数快照对长字符串截断到 200 字符，深层结构折叠，避免把大 payload 驻留内存。
- **被 `deny` 的调用不会进入证据**（它在 dispatch 前就被拦下），所以幻觉值不会自我认证。

## 判定与 meta-policy

```js
// 一条规则只有在它声明的**全部**条件成立时才触发：
//   声明了 patterns → 必须匹配；声明了 test → 必须返回原因。
matchRules(rules, { text, textFor, contextOf, config })
```

- 道义等级：`Prohibition (3) > Obligation (2) > Permission (1)`，同级按规则簿顺序。
- `dispensations: [ruleId]` 优先于一切，直接移除该规则（Dispensation 语义）。

### "是不是自己的产物"必须靠证据，不能靠名字猜

`sentinel.unrequested-delete` 最初的临时空间判据只有一份**名字白名单**（tmp/cache/node_modules/dist…）。
真实事故：另一个会话留了 `dsh-skill-probe`、`_sx`、`_sx.js` 三个自建临时产物，名字都不在白名单里，
清理时被拦，而拒绝话术还叫它"先用只读工具取证"——**读文件永远不能授权删文件**，话术与判据不匹配，
它白跑一轮后放弃了。

修法（`session.ownedPaths`，只在调用**成功**后记录）：

| 来源 | 记为什么 |
|---|---|
| `write` / `edit` 的 `file_path` | file |
| `write` 的 **content 里出现的路径**（agent 自己写的脚本会写明产物路径，`_sx` 就是这样被认领的） | file |
| 创建类命令（`New-Item -ItemType Directory`/`mkdir`/`Expand-Archive`/`asar extract`/`Copy-Item`…）的命令文本路径 | dir |
| 创建类命令的**成功输出**里列出的路径 | file |

- 目录归属**只向下传递**：可以删自己建的目录及其内容；**绝不向上传递**——`edit` 过 `src\app.ts`
  不等于可以删 `src\`（有专门测试盯着这条）。
- 路径比较必须**规范化**：脚本内容里的 `E:\\deepseek\\_sx` 与命令里的 `E:\deepseek\_sx` 是同一个路径。
  这一点是被测试逼出来的真 bug。
- 教训二则：拒绝话术必须与判据同源。判"用户有没有点名"的规则，不能给"先去取证"的建议。
- "具体数值"判据：`|n| ≥ 100` 且不是整十 → `4213`、`299.99` 会被检查，`60000`、`2000`、`3` 不会。
  证据门只读**真正的数字类型**（`{fromStrings:false}`），不扫字符串里的数字，否则 URL 里的
  `127.0`、文件名里的 `4213` 都会误报（这是实测踩到的坑，见 `test/host.test.mjs` 的同名回归用例）。

## 两个半部分怎么通信

宿主半部分注册一个仅回环的 HTTP 路由（`LOOPBACKS` 之外一律 403）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-agent-governor/state?session=<id>` | 开关 + 计数 + 规则表 + 证据（最近 12 条）+ 该会话计数 + `diag`（最近的客户端自检/报错，最多 6 条） |
| POST | `/dsh-agent-governor/config` | `{layer, field, value, session}`，`layer∈{dol,sentinel}`、`field∈{enabled,shadow}`、`value:boolean` |
| POST | `/dsh-agent-governor/reset?session=<id>` | 清零计数（不动开关与证据） |
| POST | `/dsh-agent-governor/diag` | 客户端自检/异常上报，任意 JSON，服务端保留最近 20 条 |
| POST | `/dsh-agent-governor/log/clear` | 清空拦截记录（计数与证据不动） |

**拦截记录（`log`）**：一层全局环形缓冲（最多 80 条，`/state` 返回最近 30 条 + `logCount`），
每条带 `layer / rule / deontic / title(zh,en) / detail(理由) / target / turn / step / session / shadow`。
步骤归属：`agent/pre-step` 与 `agent/assistant-stream` 的 start 帧都会写入 `session.step`，
所以工具被拦时能报出"第几步"。记录会落盘到 `<dsh-home>/storages/agent-governor-log.json`
（200ms 去抖、先写 `.tmp` 再 rename），重启后继续累积，`logSeq` 从已有最大 id 续号 ——
"重启就归零的记录"不算记录。

开关落盘到 `<dsh-home>/storages/agent-governor.json`（先写 `.tmp` 再 rename），
所以热重载和重启都保留用户的选择。客户端面板在展开时 2s 轮询、收起时 8s 拉一次用于状态点。

## 删除防护子控件（Sentinel 的强度档）

宿主状态是 `deleteGuard = { enabled, level }`，`level ∈ {watch, block, strict}`，
**`off` 不是 level，而是 `enabled:false`** —— 关闭是开关，三档才是强度。`guardLevel()` 把两者合成
一个对外值（`off` / `watch` / `block` / `strict`）。

| level | 实现位置 | 行为 |
|---|---|---|
| `watch` | `governorPreExecute` 里的 `soft` 判定 | 规则照常命中，但把记录标成 `shadow: true` 并 `return next()` —— **只记录，永不拦**（和层影子模式同一套记录路径，不计入 `blocked`） |
| `block` | 规则默认 | `deleteTargets(text)` 只认**递归强制删除**形式 |
| `strict` | `config.deleteGuardStrict` | `deleteTargets(text, { anyVerb: true })` 改认**任何删除动词** |

- `syncGuard()` 是唯一同步点：`enabled:false` 时往 `config.ruleOverrides['sentinel.unrequested-delete']`
  写 `false` 禁用该规则，开启时删掉这个键（这样 profile 配置仍可强制禁用）；同时维护
  `config.deleteGuardStrict`。关掉开关**不会**丢失已选强度（`level` 保留，重开即恢复）。
- 接口：`POST /config {layer:'sentinel', field:'deleteGuardEnabled'|'deleteGuardLevel', value}`；
  快照里是 `layers.sentinel.deleteGuard = { enabled, level, effective }` 与 `deleteGuardLevels`。
- 面板默认视图不显示它们，只有当档位非默认时 Sentinel 行上出现一个小标签（`删除:关注` 等），
  控件本体在 `?` 详情里。

## 改完怎么生效

- **客户端 `client.js` 没有构建步骤**：改完把 bundle 关掉再打开即可（见下一条，实测不需要手动刷新页面）。
- **宿主 `index.js` 改完必须重启应用。** 实测：`plugin_manager` 的 `set_bundle` 关闭再打开确实会
  dispose 再 apply 宿主 fiber（系统提示里的 DOL 段落会消失再出现），但它**不会重新导入 ESM 模块** ——
  Node 的模块缓存按 URL 生效，而本 profile 的 `hmr` 配置是 `root: []`（不监听任何目录），
  所以重新 apply 用的还是内存里的旧代码。要确认这一点，可以对比磁盘上的规则与运行时行为：
  在**旧代码**上，一个短字符串参数里带 `-176px` 的 `edit` 调用会被证据门拒掉；
  改成 `fromStrings:false` 之后新建一个进程才会放行 —— 同一个进程里怎么做都不会变。
- 想在不重启的情况下改宿主规则，只能改**配置**（`config.ruleOverrides` / `dispensations`），
  因为 config 变更走的是 Cordis 的 reload 路径；改代码一律需要重启。
- **客户端 `client.js` 的改动不需要重启、也不需要手动刷新页面**：把 bundle 关掉再打开，
  新的客户端产物就会送到已经打开的页面。实测证据：改完 `client.js` 后 toggle 一次，
  `/state` 的 `diag` 立刻出现新代码才有的 `kind:"placement"` 报告（旧代码根本不会发这个）。
  代价是宿主 fiber 会重建，内存态（计数、证据、`diag`）归零。
- **`t` 不是插槽的标准 prop，必须通过注册选项的 `inject` 传进去**：
  `ctx.slots.register({ name, id, order, inject: () => ({ t }) }, Component)`。
  漏了它，座位会抛 `t is not a function` —— 而"注册存在"依然为真，
  所以只看槽的 occupant 列表会得出"已经装上了"的错误结论。这个坑就是这样骗过两轮验证的：
  `active: true` 只说明条目挂上了，不代表它画出来了。`SeatBoundary` + `probePlacement` + `/diag`
  就是为了让这类失败变成可读数据，而 `test/client.test.mjs` 里新增的**渲染测试**
  （用最小 React 替身真正调用组件函数）是防止它复发的闸门。
- 校验要点：宿主改动重启后系统提示里出现 DOL 政策段落；客户端改动 toggle 后 `/state` 里
  出现 `kind:"placement"`、`build` 等于当前 `BUILD` 常量、且 `visible:true`；再跑 `npm test`
  （25 宿主 + 17 客户端）。**`build` 字段是刻意加的**：只看"有 placement 报告"无法区分新旧客户端，
  报出构建标签才能把"这一版代码真的在跑"变成可核对的数据。
- 面板默认只显示：标题 + `?`、以及每层一行（层名 · 一个关键数字 · `?` · 开关）。描述、影子模式、
  计数器、最近事件全部收在对应行的 `?` 里，整体说明与"清零统计"收在标题的 `?` 里；同一时刻
  只展开一个。折叠态用 `max-height:0` + `visibility:hidden`（后者让它同时退出 tab 顺序），
  展开用 `max-height` 过渡，所以既不抖也不占位。
- **主题 token 有两个坑，都是实测踩出来的**：① token 定义在主题作用域的元素上，**不在
  `documentElement`** —— 在 `document.documentElement` 上 `getPropertyValue('--dsw-alias-*')`
  读到的是空字符串，必须从面板内部的元素上读；② **`--dsw-alias-brand-primary` 不是填充色**：
  在深色主题里它解析成 `#f9fafb`（近白），拿它当开关的"开启轨道"会得到一个白底白钮的胶囊，
  看起来完全不像控件（这正是用户反馈"不点一下不知道是按钮"的原因）。所以开关的开启填充用
  显式品牌蓝 `#4d6bfe`：`test/client.test.mjs` 里那条"只允许主题 token"的用例现在显式白名单
  `#fff`（旋钮）与 `#4d6bfe`（开启轨道），把"为什么硬编码"变成测试里的一句注释。
- 开关的可见性不只靠颜色：48×22 轨道 + 18px 带阴影旋钮 + 内嵌 `开/关` 文字 + hover 光环 +
  `appearance:none`，任何一项缺失都会退化成"看起来像装饰"。`probePlacement` 会把每个
  `.agov-switch` 的 `aria-checked`/`background`/`border`/`width` 一并上报，样式问题因此可核对。
- 浏览器产物的 `__ModuleLoader__.load({ id })` **必须等于包名**，`test/client.test.mjs` 会检查。
- 测试必须隔离：`apply()` 会读取 `<dsh-home>/storages/agent-governor.json`，
  所以 `test/host.test.mjs` 在启动时把 `DSH_HOME` 指到临时目录 —— 否则开发机上真实的开关状态
  会悄悄改掉测试结果（这一点是被测试自己抓出来的）。

## 验证配方（本次实测用过）

1. `GET /dsh-agent-governor/state` → `layers` 两开关、`sentinel.inspected` 随自己的工具调用增长。
2. 未落地数值 → 拦截：带一个证据里没有的具体数值调用工具，应收到
   `{kind:'deny'}` 生成的 `[Agent Governor · Sentinel 层] …` 反馈，且 `blocked+1`。
3. 落地后放行：先用只读工具让该数值出现在真实返回里，再用同一数值重试 → 放行，规则不再触发。
4. 影子模式：`POST /config {layer:'sentinel',field:'shadow',value:true}` 后重复第 2 步 →
   调用放行但 `shadowed+1`、`lastShadow.rule` 指向该规则。
5. 关掉整个 bundle → 系统提示里的 DOL 段落消失，证明注入来自本插件而非其它插件。

## 发布（社区插件）

### 1. GitHub

`package.json` 里已经写好 `repository` / `homepage` / `bugs`，仓库地址约定为
`https://github.com/kxdyh/dsh-agent-governor`。首次推送：

```bash
git remote add origin https://github.com/kxdyh/dsh-agent-governor.git
git push -u origin main
```

- 仓库 **topics** 打上：`dsh-plugin`、`deepseek-harness`、`cordis`、`plugin`、`guardrail`、`agent-safety`
  （社区一般按 `dsh-plugin` 话题/关键词检索收录）。
- 发一个 **Release**，把 `kxdyh-dsh-agent-governor-1.0.0.tgz` 作为附件 —— 用户拿到 tgz 就能装，不必等 npm。

### 2. npm（可选但推荐）

```bash
pnpm publish --access public --registry https://registry.npmjs.org
```

注意：`registry.npmmirror.com` 这类**只读镜像发不上去**，必须显式指定官方源；
scoped 包已设 `publishConfig.access = public`。

### 3. 四种安装方式（都可用）

| 方式 | 命令 | 适用 |
|---|---|---|
| 本地目录 | `dsh plugin add E:\deepseek\dsh-agent-governor` | 开发（本机就是 `link:` 安装） |
| 发布产物 | `dsh plugin add ./kxdyh-dsh-agent-governor-1.0.0.tgz` | 不想发布时的分发 |
| npm 包名 | `dsh plugin add @kxdyh/dsh-agent-governor` | 发布之后 |
| GitHub | `dsh plugin add github:kxdyh/dsh-agent-governor` | 只发了 GitHub |

装好后：客户端半部分刷新页面即可见；**宿主半部分需要重启应用**（原因见上文"改完怎么生效"）。

### 4. 发布前自检清单（本仓库已全部通过）

- [x] `npm test` → 44 宿主 + 18 客户端，全绿
- [x] `npm pack` 后**解包再跑一次测试** → 证明产物自包含（13 个文件，含 DEMO.md/DEVELOPING.md）
- [x] `npm install --dry-run <tgz>` → 可被解析安装
- [x] `cordis.patch.yml` 的 `name` 与 `package.json` 的 `name` 完全一致
- [x] `client.js` 的 `__ModuleLoader__.load({ id })` 等于包名
- [x] 无出网依赖：宿主只 import `node:fs`/`node:os`/`node:path`，不调用任何模型

### 5. 发布产物（`E:\deepseek\dsh-agent-governor-dist\`）

| 文件 | 说明 |
|---|---|
| `kxdyh-dsh-agent-governor-1.0.0.tgz` | npm/GitHub Release 用；`dsh plugin add` 可直接吃 |
| `kxdyh-dsh-agent-governor-1.0.0-src.zip` | `git archive HEAD` 生成的源码快照（不含 `.git`） |

`.tgz` 与 `github:user/repo` 两种形式同样可安装。
