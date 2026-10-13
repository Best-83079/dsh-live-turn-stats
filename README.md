# dsh-live-turn-stats

一个 DeepSeek Harness（dsh）Web 客户端插件：在输入框下方的胶囊行里加一个**只看最新一轮对话**的实时统计——首 token 延迟（TTFT）和输出速度（TPS）。

> A DSH web-client bundle that adds one composer pill for the **newest turn only**: live time-to-first-token and output speed, instead of the whole-session averages the shipped session-stats pill shows. Requires dsh `>=0.2.0-rc.2 <0.3.0-0`.

dsh 自带的「会话统计」是整个会话的平均值——它的 TTFT 是 `ttftMs / ttftSteps`（日志里每个 Step 的平均），TPS 是全会话所有 token 除以所有解码时间。它回答的是「这个会话整体怎么样」，不是「这次回答怎么样」。这个插件补的就是后者。

## 显示什么

胶囊长这样（顺序紧跟在原有「会话统计」胶囊之后）：

| 状态 | 胶囊文字 | 含义 |
|---|---|---|
| 还没出首 token | `本轮 等待首字 2.3秒` | 从本轮第一个 Step 的 `step/start`（还没有 Step 时从 `turn/start`）开始计时，每秒跳动 |
| 正在流式输出、提供方还没报 usage | `本轮 3.6秒 · 生成中 1.2秒` | TTFT 已确定；「生成中」从首 token 起计时，每秒跳动 |
| 已拿到 usage 或本轮已结束 | `本轮 3.6秒 · 142 tok/s` | 本轮最终（或当前）的首 token 延迟与输出速度 |

鼠标悬停时胶囊会有和自带胶囊一样的 hover 底色；**点一下会弹出详细信息窗口**（和自带「会话统计」同款：固定定位、贴在上方、越界自动夹进视口、随滚动/窗口变化重新定位、点外面或按 Esc 关闭），内容是：

```
🕐 最新一轮统计                     第 12 轮
─────────────────────────────────────────
首 token 延迟（TTFT）              3.6秒
输出速度（TPS）                 142 tok/s
输出 token                         1,234
解码用时                          8.4秒
步数                                  2

只统计最新一轮，旁边的「会话统计」是整个会话的平均值。
```

进行中的一轮里，TTFT 行显示 `等待首字 2.3秒`、TPS 行显示 `生成中 1.2秒`，和胶囊一起每秒跳动；没有记录到的项显示「未记录」，不会瞎编。

- **TTFT（本轮）**：本轮里**最早**那个同时有 `step/start` 和首 token 的 Step，`首 token 时间 − Step 开始时间`。首 token 判定与 Host 的 `@deepseek-ai/dsh-llm` 的 `isTokenDelta` 一致（非空 text / reasoning delta，或带名字或参数的工具调用 delta）。
- **TPS（本轮）**：本轮里**同时**有首 token、解码结束时间和 provider usage 的 Step，把 `输出 token` 求和除以 `解码时间（首 token → 结算）` 求和。`解码时间` 为 0 时不显示速度。这与自带对话框对 TPS 的定义一致，只是把范围收到本轮。
- **不编造**：不会用「已收到的 delta 数」冒充 token 数，也不会给进行中的 Step 编造一个时长。流式期间能实时看到的只有「已经等了多少」和「已经生成了多久」，token 数只有提供方报了 usage 才知道（`usage` chunk 通常紧挨着 `finish`，所以速度值几乎在结束前就出现）。

## 数据来源

`ctx.sessions.binding(sessionId).eventSource`——当前会话的连续事件窗口，浏览器端本来就有的那一份：

- 流式过程中的 `assistant/live-chunk`（transient 行）给出首 token 的**精确时刻**；
- 结算后的 `assistant/message` 内嵌 compact 计时流（`stream`），所以**刷新页面后**（transient 行已经消失）TTFT 依然准确；
- `usage` chunk 和 `assistant/message.usage` 给出输出 token 数。

折叠只保留**最新一轮**（窗口是连续日志切片，turn 号只会往前走，旧 turn 的事件直接丢弃）。只有「窗口的 revision 恰好比上次读到的大 1，且这次变更是 `append`」才沿用上一次的折叠状态——`change` 只描述一批里的**最后一次**变更，所以长度相同的 `replace`、净长度为零的 `settleAssistant`、以及夹带了这些的同批追加，都必须整体重算，否则会把它们插入的行漏掉。走快路径时只折这次发布的那几条事件，**不物化整个窗口数组**，所以每个 chunk 到达时既不重扫也不重读整个窗口。

`Date.now()` 只用于把「等待/生成中」的已用时跳出来；事件时刻来自 Host（本地 Web GUI 是同一台机器）。

## 安装

三种方式等价，装完**首次要刷新一次页面**：`dsh-client-modules` 的包扫描结果按 specifier 缓存，新 bundle 的客户端半要刷新页面才会进模块表。

1. **GUI**：侧边栏 → 插件 → 添加插件，粘贴仓库地址：

   ```text
   https://github.com/Best-83079/dsh-live-turn-stats
   ```

   （`github:Best-83079/dsh-live-turn-stats` 也可以；带分支或 tag 就写 `...#v1.2.0`。）

2. **CLI**：直接让 dsh 的 pnpm 层装进某个 profile：

   ```powershell
   dsh plugin --profile web add github:Best-83079/dsh-live-turn-stats
   ```

3. **本地目录**（改代码时用）：`plugin_manager install_bundle` → `C:\Users\123\Documents\DSH\dsh-live-turn-stats`，或 `dsh plugin --profile web add link:C:\path\to\dsh-live-turn-stats`。

装好后 profile 的 `package.json` 里会出现一条依赖（git 装是 `github:Best-83079/dsh-live-turn-stats`），`dsh.profile.bundles` 里会多出 `dsh-live-turn-stats`。

- bundle 名 `dsh-live-turn-stats`，row id `live-turn-stats`，Host 半（`index.js`）是空实现，做的事全在 `client.js`。
- 客户端半 `client.js` 只 `require('react')`，不 import 任何 Harness 包；`slots` / `sessions` / `locale` 都在运行时通过 Cordis 服务取。

## 支持的 dsh 版本

声明在 `package.json` 的 **`peerDependencies`** 上——这是 dsh 唯一**强制执行**的地方（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` 拿运行时版本逐个校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 range）：

```json
"peerDependencies": {
  "@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.3.0-0",
  "@deepseek-ai/dsh-api-session-controller": ">=0.2.0-rc.2 <0.3.0-0",
  "@deepseek-ai/dsh-client-locale": ">=0.2.0-rc.2 <0.3.0-0",
  "@deepseek-ai/dsh-client-ui-chat": ">=0.2.0-rc.2 <0.3.0-0"
}
```

- 含义：**dsh 0.2.x（rc.2 及以后）可用**；0.1.x 和 0.3.0 起的版本会被网关拒绝安装/激活，并提示需要「精确版本豁免」。本插件开发与实测的运行时是 **dsh 0.2.0-rc.2**。
- 除 `@deepseek-ai/dsh` 外，还声明了它真正用到的三个包的客户端半（会话事件窗口、locale、`conversation.composer.dock` 插槽的拥有者），所以某个包被改名或拆包时会被拦下，而不是运行时静默失效。
- `dsh.engines.dsh` 是同一范围的声明式副本：插件市场（dshmarket）的「宿主要求」徽标读的是它（顶层 `engines.dsh` 也认，两者都在时以顶层为准）。测试会断言两者一致，不会出现「徽标说兼容、网关说拒绝」。
- 升级到 0.3.x 后想先用着，可以走豁免：`plugin_manager` 的 `set_version_exemption`（或 `dsh plugin allow-version`），风险自负。
- 本插件声明 `"private": true`（防止误发 npm）。如果你要发到 npm 让「添加插件」支持包名安装，删掉这一行即可——包名 `dsh-live-turn-stats` 目前未被占用。

## 验证

1. `npm test`（离线，不需要 Harness 在跑）：
   - `test/fold.mjs`：24 项断言覆盖流式 TTFT、usage chunk、结算后从 compact 流重建 TTFT、多 Step 轮次、重试保留更早的首 token、空轮次不上屏、窗口从中间开始、畸形 usage、陈旧 turn 事件、读缓存增量与 settle 重算、**同一批里 settle + append 必须整体重算**、**追加路径不重新物化窗口**、**没有 `step/start` 的 Step 按「已出 token」而不是「等待首字」处理**、格式化函数，以及**弹出窗口的每一行文字**（等待中/生成中/已结算三种状态）。
   - `test/manifest.mjs`：9 项断言覆盖包名/版本/协议、patch 文件与插入的 row 名、`exports` 指向、`dsh.client` 声明、发布文件集、引擎徽标与 peer range 一致；能自发现本机 dsh 时再跑**真实的** `evaluatePluginCompatibility`，断言当前运行时（0.2.0-rc.2）通过，且 0.1.0 / 0.3.0 会被拒（声明有效性的反向验证）。
2. 运行中的客户端：`cordis_inspect_query`（Client `Slots`，root `conversation.composer.dock`）的 occupants 里应出现 `id: live-turn-stats`，order 0.5（紧跟 `stats`）。
3. 视觉核对需要你自己看一眼：发一条消息，胶囊应在「等待首字 → 生成中 → 速度」之间切换；点开旁边的「会话统计」，两者数值应当不同（除非整个会话只有这一轮）。

## 局限

- 只在最新一轮**已经产生过 token** 或**正在进行中**时显示；最新一轮直接失败/取消且没有任何输出时胶囊隐藏（不会把上一轮的数字冒充成「本轮」）。
- 窗口从**某个 Step 的 `step/start` 之后**开始载入时，那个 Step 没有起点，TTFT 算不出来：此时仍显示它的 token 数与速度（TTFT 行写「未记录」），不会把它说成「等待首字」。要精确的 TTFT 需要窗口覆盖到该 Step 的 `step/start`。
- tick 用的是浏览器时钟与 Host 事件时刻的差；本地同一台机器没问题，跨机器（Host 在远端）时这个差值会带上时钟偏差。
- 不支持把行**插进**自带「会话统计」对话框：那个对话框不是插槽，唯一的加法是整格替换 `conversation.composer.dock` 里 id 为 `stats` 的条目，会连带覆盖自带的用量胶囊，得不偿失。所以这里是并排的独立胶囊。
