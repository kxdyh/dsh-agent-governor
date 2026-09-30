# dsh-agent-governor

一个装在 **DeepSeek Harness (dsh)** 上的自定义插件：给 agent 加两层可自由开关的拦截层，降低
agent 的错误率。

A custom **DeepSeek Harness (dsh)** plugin: two independently switchable interception layers that
reduce how often an agent gets things wrong.

- **DOL 层 · 通信语义治理** —— 管 agent **说什么**：把道义规则（许可／禁止／义务／豁免）注入每次
  请求的系统提示，并审计每一段可见输出；没有证据的完成性断言、凭据外泄、绝对化承诺会被标记，
  纠正要求会送进下一步，逼模型自我纠正。
- **Sentinel 层 · 工具执行治理** —— 管 agent **做什么**：用同一个证据缓存，在工具调用**执行前**
  校验参数；破坏性命令和无依据的数值参数会被拦下，并把结构化的重试反馈作为工具结果交还给模型。

两个开关就在会话标题栏右侧（你圈出的位置），由一个**盾牌**图标收纳，点击后带缩放＋淡入＋上浮的
动画展开面板。图标不是齿轮。

---

## 安装

插件就是一个声明了 bundle 的 npm 包，用 dsh 自带的安装器装即可：

```bash
# 本地路径（绝对路径）或 .tgz / git / registry 形式
dsh plugin add /absolute/path/to/dsh-agent-governor
```

在本机 GUI 里也可以让 agent 调用 `plugin_manager`：

```
install_bundle  target = E:/deepseek/dsh-agent-governor
```

安装后会写进当前 profile 的 bundle 列表并立即生效；**客户端部分需要刷新一次页面**（F5）才会
加载新的头部控件。**改动宿主规则（`index.js`）后必须重启应用才生效** —— 把 bundle 关掉再打开
只会重新 apply，不会重新导入模块（详见 [DEVELOPING.md](DEVELOPING.md) 的实测记录）。

## 使用

| 元素 | 含义 |
|---|---|
| 标题栏右侧的盾牌 | 收纳两个开关。旁边的小圆点：灰=全关，橙=只开一层，绿=两层都开；出现拦截时短暂脉冲 |
| 盾牌右侧的数字 | 自本次启动以来的拦截总数（Sentinel 拦截 + DOL 标记） |
| 点击盾牌 | 面板以 180–200ms 的 `scale(0.96) → 1` ＋ 淡入 ＋ 上浮展开，两行分层卡片错峰入场；点击面板外或按 Esc 收起 |
| 每层的开关 | 独立开关该层（`role="switch"`，带 `aria-checked`） |
| 影子模式 | 该层只记录、不拦截，用来在正式启用前校准规则（对应截图里的 Shadow Mode） |
| 统计行 | 该层真实计数：Sentinel = 检查／拦截／证据条数；DOL = 审计／标记／纠正 |
| 清零统计 | 只清计数，不动开关和证据缓存 |
| 盾牌右边的账本图标 | **拦截记录**：公共记录浮层，回答"哪一步被拦、为什么" |
| Sentinel 层详情里的**删除防护** | 删除拦截的子控件：右侧是开关，下面三档强度 —— **关注 / 拦截 / 严格**。**关闭不是强度**，是那个开关；关掉后完全不检查删除操作 |

**删除防护的三档强度**（默认 `拦截`）：

| 强度 | 行为 |
|---|---|
| **关注** | **只记录，不拦任何删除**（适合先观察一段时间再收紧）。命中的记录带"影子"标记，只进记录不计入拦截 |
| **拦截** | 拦下"未被你点名、也不是本会话自己创建"的**递归强制删除**（`rm -rf`、`Remove-Item -Recurse -Force`、`del /s`、`rmdir /s`）。单文件删除不受限 |
| **严格** | 连**单文件删除**也要先有点名/属于自己创建（`Remove-Item a.txt`、`rm a.txt` 都会拦）。仍保留"自己创建的产物可删"与 `tmp`/`cache` 等豁免 |

面板默认视图保持精简：只有把该档位改成非默认时，Sentinel 那一行才会出现一个小标签（`删除:关注` / `删除:严格` / `删除:关`），点开 `?` 才能改。

**拦截记录**每行 = 时间 · 层标签 · 规则名 · 第几步，下一行是**理由**；点某一行展开对象、
来源会话与轮次、规则 id。顶部三个筛选（全部／工具拦截／输出标记）＋ 清空。最多保留 80 条，
落盘在 `<dsh-home>/storages/agent-governor-log.json`，**重启后继续累积**。
记录示例（真实 payload）：

```json
{ "layer": "sentinel", "rule": "sentinel.evidence-gap", "deontic": "obligation",
  "title": { "zh": "数值证据缺失", "en": "Ungrounded numeric argument" },
  "detail": "参数中的数值 4213 未出现在本会话的已验证证据中（用户的输入或任何工具的真实返回）",
  "target": "process_refund {\"orderId\":\"A-1\",\"amount\":4213}",
  "turn": 6, "step": 12, "session": "session-2f1c", "shadow": false }
```

开关状态写在 `<dsh-home>/storages/agent-governor.json`，重启后保持；两个半部分通过一个
**仅限本机回环**的 HTTP 路由（`/dsh-agent-governor/state`、`/config`、`/reset`）交换状态，
所以面板里的每个数字都来自宿主实时数据，没有估算。

**入口一定存在。** 选中会话时盾牌在标题栏右侧工具区；没有选中会话时（Hero 页）先在右上角浮层出现。
每次挂载后客户端会自检"我到底画出来了没有"（rect、计算样式、是否有带 transform 的祖先、
`elementFromPoint` 是否命中自己）并把结果上报给宿主；**如果浮层里其实显示不出来，会自动改用标题栏
里的兜底席位**，不让你找不到入口。自检结果和渲染异常都能从 `GET /dsh-agent-governor/state` 的
`diag` 字段读到。

## 两层各自检查什么

**Sentinel（工具调用执行前）**

| 规则 id | 类型 | 默认 | 说明 |
|---|---|---|---|
| `sentinel.destructive-delete` | 禁止 | 开 | `rm -rf /`、`~`；递归强删盘符根；`mkfs`／`diskpart`／`format C:`／`dd of=/dev/` |
| `sentinel.system-control` | 禁止 | 开 | 关机／重启／注销本机 |
| `sentinel.history-rewrite` | 禁止 | 开 | `git push --force`/`-f`、`git reset --hard`、`git clean -fd`、`git restore`（非 `--staged`）、`git checkout -- <path>`/`-f`/`.`、`git stash drop`/`clear`、`git branch -D` |
| `sentinel.data-destroy` | 禁止 | 开 | `DROP TABLE/DATABASE/SCHEMA/INDEX`、`TRUNCATE TABLE` |
| `sentinel.pipe-to-shell` | 禁止 | 开 | `curl … \| bash`、`iwr … \| iex` |
| `sentinel.unrequested-delete` | 义务 | 开 | **由"删除防护"子控件控制强度**（见上文）。拦截/严格两档要求递归强制删除（严格档含单文件）的目标属于：① 出现在你的要求里；② **本会话自己创建的产物**——文件工具写出的路径、创建类命令的目标、agent 自己写的脚本里提到的路径、创建命令成功输出里列出的路径；③ `tmp`/`cache`/`node_modules`/`dist` 等临时与构建目录。目录归属只向下传递，**绝不向上传递**（改过 `src\app.ts` ≠ 可以删 `src\`） |
| `sentinel.evidence-gap` | 义务 | 开 | 调用参数里的**具体数值**（≥100 且非整十）必须已经出现在本会话的已验证证据里（用户输入或任何工具的真实返回）。只读工具、shell 命令、含大段内容的调用不参与此规则 |
| `sentinel.repeat-loop` | 义务 | 关 | 同名同参数的成功调用超过阈值后拒绝（默认阈值 0 = 关闭） |

**DOL（消息／输出侧）**

| 规则 id | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dol.credential-leak` | 禁止 | 开 | 输出里出现私钥、`sk-` key、AWS/GitHub/Slack/Google 令牌、JWT |
| `dol.completion-claim` | 义务 | 开 | 本回合没有任何成功的工具结果，却声称"已完成／已通过／已修复" |
| `dol.absolute-claim` | 禁止 | 关 | "100%／绝对／保证／guaranteed"这类无法兑现的表述 |
| `dol.number-grounding` | 义务 | 关 | 输出里的具体数值也要有证据来源 |

规则冲突时按 **meta-policy** 裁决：`Prohibition > Obligation > Permission`；同级别按规则簿顺序。
用户可以通过配置**豁免**（Dispensation）任意规则。

### 配置

在 profile 的补丁层里给该条目加 config 即可（`config.ruleOverrides` 可按规则 id 开关，
`dispensations` 用于豁免，`repeatLimit` 用于循环门）：

```yaml
- id: agent-governor
  name: '@kxdyh/dsh-agent-governor'
  config:
    dol: true
    sentinel: true
    repeatLimit: 5                                   # 打开重复调用门
    ruleOverrides:
      dol.absolute-claim: true                       # 打开绝对化承诺检查
      sentinel.evidence-gap: false                   # 关掉证据门
    dispensations: ['sentinel.history-rewrite']      # 豁免强推检查
```

## 如实的限制（重要）

1. **它不是"拦截每一个 LLM 请求"。** 请求侧只做了一件事：把治理规则与待纠正项
   **追加**进系统提示（`system-prompt/assemble`）。请求体本身（消息历史、工具集、参数）
   **目前没有被检查**；真正能硬阻断的是**工具调用**（`tools/pre-execute`）和**步骤**（`agent/pre-step`）。
2. **输出侧是"下一步纠正"，不是当场掐断。** `agent/assistant-stream` 是只读广播事件，
   拦不住已经发布的内容；纠正通过系统提示进入下一次组装。
3. **审查是确定性规则 + 证据比对，不是语义推理。** 没有 OWL/Rei，也刻意没有让 LLM 当裁判
   （成本翻倍、有递归风险、延迟不可控）。误报请用影子模式先观测。
4. **看不见的调用**：会话标题生成、压缩摘要这类不走 agent loop 的 LLM 调用目前不覆盖；
   PTC `run_code` 内部子派发未覆盖；子 agent 理论上覆盖（root 作用域监听），本机实测前请以
   面板计数为准。
5. **证据缓存有上限**（每会话 240 条、最多 32 个会话），很长的会话可能丢掉旧证据而误报
   "无依据"；被拒绝的调用不会进入证据。
6. **这不是安全边界。** 插件与 agent 同进程，且 agent 权限足够时能改插件文件、POST 关闭开关、
   改 profile 补丁。它降低**错误率**，挡不住**恶意 agent**。

## 测试

```bash
node test/host.test.mjs     # 24 项：规则、meta-policy、豁免、证据链、HTTP、持久化
node test/client.test.mjs   # 11 项：模块标识、插槽席位、本地化键、动画样式契约
npm test                    # 两者都跑
```

## License

MIT
