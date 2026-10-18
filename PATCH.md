# 卫戍协议：盟约 0.3.0 — 客户端补丁 / client patch set

这个仓库只放**改动过的文件**（按游戏里的原路径），不是完整游戏。把它盖到一份 0.3.0 安装上即可。
This repo holds only the **modified files**, at their original paths, to copy over a v0.3.0 installation.

作者 / author: **seals_awa** · 许可 / license: MIT（补丁本身；游戏本体仍是 GPL-3.0-or-later，见原仓库）

## 包含的改动 / What is in here

### 1. 干员模型朝向（客户端实现，取代早期的「朝向优化」插件）/ operator facing, client-side

- `public/js/render/facing.js` **（新文件）** — 朝向判据：目标与水平线夹角 > 约 60° 才抬头；贴身（一格里）的敌人按上下优先；
  `FACING_FLIP_S`（0.05 s 翻面过渡）、`FACING_HOLD_S`（3 s 保持）。
- `public/js/render/units.js` — `UnitView.onAttack` 里让**模型**转向正在打的目标（`setViewDir`，只改画面，`dir` 与射程不变）；
  被控（晕眩/冰冻/沉睡）不转，**同一帧命中多个目标（群攻）不转**；`update` 里 3 秒没有新攻击就转回部署方向。
  另外含 `viewDir` / 翻面过渡的基础实现。
- `public/js/render/app.js` — 每帧统计每个攻击者的命中数（给上面的"群攻不转"用）；`vdir` 事件（旧插件通道）保留。
- `public/js/render/app/info.js`、`public/js/screens/game/early.js`、`server/sim/units.js`、
  `server/sim/battle/queries.js`、`server/sim/snapshot.js`、`shared/protocol.js` — 配合的显示通道
  （`unit.viewDir` / `Battle.setViewDir` / `EV.VDIR`），只用于画面，模拟里没有任何代码读它。

> 为什么改成客户端：脚本插件会让房间的内容集变成"改动玩法"，于是模拟被放进模块 Worker，**每场战斗**都要重新导入整套引擎、
> 加载 SES 并 `lockdown()`、校验并编译插件源码 —— 手机上就是每场 1~3 秒的进入延迟。放到渲染层后，房间可以是原生内容集，
> 连 Worker 都不建，延迟归零。

### 2. 部署语音必定播放 / the deploy voice always plays

- `public/js/audio.js` — `VOICE_ALWAYS_SLOTS = ['place']`：部署语音不再被 1.2 s 的全局间隔吞掉，会**打断选中语音**
  （`select`，优先级 10），遇到更重要的语音（开战/接敌/作战中/结算）则**排队**，等它结束后补播（`VOICE_QUEUE_TTL_MS`）。
- `public/js/render/app.js` — **准备期干员落到棋盘上就播这条语音**：`landPiece` 在 `board`（从手牌/备战区放上去、交换）、
  `buy`（买入落位）、`move`（**在棋盘内挪格 / 交换位置**）时调用 `sayPlace` → `audio.voice(charId, 'place')`（棋子 id
  `chess_char_*` 经 `data.chess(...).charId` 映射到干员的 `char_*`，补位/自选取模型的 charId）；只有合成（`merge`）与
  开局回放（`round`）不播。准备期落位还带 `interrupt: true`：**不同干员接连落位会打断上一条部署语音**（同一位挪格不重复播），
  而战斗内八个干员同时部署不会互相打断。战斗内的 `deploy` 事件沿用原来的 `place` 触发。

### 3. 攻击动画节奏 / attack-clip pacing

- `server/sim/snapshot.js` — `UnitInfo.atkInterval` = 干员真实攻击间隔 `s.interval`（含加成）。
- `public/js/render/attackRate.js` **（新文件）** — `startAtkInterval`（快照值 > 面板估值 > 1.2 s）、
  `nextAtkInterval`（第一次实测取代估值；之后**变化超过 8% 下一次出手直接跟上**，只有 30 Hz 抖动级的偏差才按 25% 轻微过渡；
  0.05–6 s 之外视为卡顿忽略）。
- `server/sim/snapshot.js` + `server/sim/battle/lifecycle.js` — `noteAttackRates`：`s.interval` 变化的同一 tick 发
  `['rate', id, 秒]`（`shared/protocol.js` `EV.RATE`，只在变化时发，仅我方干员）。
- `public/js/render/app.js` — `case 'rate'` → `UnitView.setAtkInterval`（权威值，下一次起手就用它）；
  `public/js/battle/runner.js` / `public/js/screens/game/early.js` 的 `STATE_EV` 也保留 `rate`（补帧/中途进场）。
- `public/js/render/spine.js` — `windUpPlan`：`lead < MIN_LEAD`（0.05 s，即没有起手提前量：开局第一刀、迟到批次、模型未就绪）
  时片段按**自身速度**播放（`ts = 1`），不再被拉成"一个循环 = 一个攻击间隔"；`attack()` 未起手的分支同样按自身速度播尾巴
  （此前 惊蛰 1 s 片段 / 2.3 s 间隔，第一刀 0.43×、尾巴 1.53 s，看起来像慢放）；`windUp` 的 `attackUntil` 改用实际起播的
  `tsWind`。
- `public/js/render/units.js` — 视图出生用 `startAtkInterval`；`onAttack` 的节奏平滑改用 `nextAtkInterval`，
  所以战斗第一刀就是正常速度（此前 宴 这类开技能后间隔 0.74 s、估值 1.20 s 的干员会慢放 62%）。

### 4. 战斗启动提速 / faster battle boot

- `public/js/battle/simLoader.js` — `contentNeedsWorker(content)`：只有内容集里**有脚本插件**才需要模块 Worker（SES 沙箱）；
  纯数据插件（数值 / 干员 / 敌人 / 商店 …）与"脚本未启用"的空脚本列表都返回 false。
- `public/js/battle/runner.js` — `ensureSim`：没有脚本的内容集**在页面内**加载（`loadSim({ ...content, scripts: [] })`），
  和原生内容一样，于是这类房间进战斗不再有"每场一次"的 Worker 启动；带脚本的仍走 Worker。

- `public/js/battle/simHost.js` — 打完的 Worker **留暖**（按内容集 `cs` 区分，最多 1 个，180 s 过期）供下一场直接
  `start(spec)` 复用；`prewarmHost` 在开战 4 s 后**后台预热**下一个 Worker。
- `public/js/battle/runner.js` — 进战斗时优先取留暖的 Worker；淘汰条目时把它留暖而不是销毁；`dispose` 时清空池。
- `public/vendor/ses.umd.js` — **`[sp-patch]`**：有些引擎/WebView 的 `TextEncoder` 带一个不可删除的 own 属性 `arguments`，
  SES 的 `lockdown()` 删除它时抛错，整个脚本 Worker 停止（`PLUGIN_WORKER_FAILED`，
  `Cannot delete property 'arguments' of function TextEncoder()`）。补丁按它原本对待不可删除 `prototype` 的方式容忍并警告。

### 5. 战斗期倍速 2× / 4×（房间统一，结果不变）/ battle speed

**做什么**：房主在房间里把战斗速度设为 **×2**（默认，即原来的节奏）或 **×4**，整个房间的**常规作战与联防**都按这个
速度推进；顶栏在 ×4 时显示一个 `×4` 小牌。**最终攻势 / 隐秘核心始终 ×2**（它们的共享领袖血池按服务器真实时间记账，
加速只会让客户端上报的伤害被暂时压后，甚至可能让这一场提前结束）。

**为什么结果不变**：模拟从来是按**固定的 1/30 秒一步**（tick）推进的，倍速只决定一秒里走多少步 —— 同一份战斗规格在
两种速度下走的是**完全相同的 tick 序列**，所以伤害、击杀、漏怪、盟约层数、掉落、结算都逐位相同，只有现实用时减半。
客户端（`b.start.speed`）、服务器自己的推进（`FieldRunner`）、结果截止时间、结果释放与服务器兜底都是同一个速度，
不会出现"手表和模拟对不上"。

**为什么不是插件**：插件 API 没有能改战斗节奏的入口（`sim.*` 在战斗内部，改不了推进；`ui` 插件不能发对局意图）。
所以这一条改的是引擎与界面本身，和朝向一样属于本补丁集。

- `shared/constants.js` — `BATTLE_SPEEDS = [2, 4]`、`DEFAULT_BATTLE_SPEED`、`isBattleSpeed`、`battleSpeedOf(kind, base, room)`：
  常规 / 联防用房间速度，`boss` / `hidden` 用基础速度。
- `shared/protocol.js` — 新意图 `room.setBattleSpeed { speed: 2 | 4 }`。
- `server/lobby.js` — 房间状态 `room.state.battleSpeed`；房主在开局前设置，像改难度一样**把其他真人取消准备**；新房间默认 2；
  跨局保留；开局时存进 Match 的 `opts.battleSpeed`。
- `server/match/Match.js` — `battleSpeed` 与 `_speedOf(kind)`：一处决定"这一场用几倍速"。
- `server/match/fields.js` — `FieldRunner` 按 `speed` 累积时间（4× 每秒 120 tick，追帧上限同步放大）。
- `server/match/match/clientCombat.js` — `b.start.speed`、战场时钟 `_fieldElapsed`、结果截止 / 结果释放都按 `_speedOf`。
- `server/match/match/combat.js`、`server/match/match/unitePhase.js` — 作战 / 联防的截止时间与服务器推进用房间速度。
- `server/match/match/views.js` — `m.public.speed`（顶栏小牌与倒计时量表用）。
- `server/match/host/proxy.js` — 玩法插件房间的对局跑在子进程里，`battleSpeed` 随选项一起传过去。
- `public/js/screens/room.js` — 房间底部「战斗速度 ×2 / ×4」选择器（房主可点，其他人只读）。
- `public/js/ui/hud.js` — 作战 / 联防顶栏的 `×4` 小牌。
- `public/js/ui/gameLogic/phases.js` — 倒计时量表的总时长跟着倍速缩放（×4 时一场 60 秒的回合只有 30 秒）。
- `public/js/battle/runner.js` — 注释说明 4×（逻辑本来就按 `b.start.speed` 走，不需要改代码）。

### 6. 测试 / tests

`test/facingRender.test.js`、`test/voiceGate.test.js`、`test/sesTolerance.test.js`、`test/simHostPool.test.js`、
`test/battleSpeed.test.js`（`node --test test/xxx.test.js`；引擎内插件测试用 `node tools/plugin.mjs test <id>`，本仓库不含插件）。

`test/battleSpeed.test.js` 覆盖：只接受 2 / 4、首领会保持 2×、房主才能设置且开局后冻结、`room.state` / Match 选项搬运、
`FieldRunner` 在 4× 下每秒走两倍 tick、战场时钟 / 截止 / 释放随速度缩放，以及**同一场战斗用 2 tick / 4 tick 一帧推进
得到完全相同的 tick 数与结算结果**。

## 怎么用 / How to apply

1. 复制过去（覆盖同名文件）：
   ```
   public/js/battle/runner.js
   public/js/battle/simHost.js
   public/js/render/app.js
   public/js/render/app/info.js
   public/js/render/facing.js          （新文件）
   public/js/render/units.js
   public/js/screens/game/early.js
   public/js/screens/room.js
   public/js/ui/gameLogic/phases.js
   public/js/ui/hud.js
   public/js/audio.js
   public/vendor/ses.umd.js
   server/lobby.js
   server/match/Match.js
   server/match/fields.js
   server/match/host/proxy.js
   server/match/match/clientCombat.js
   server/match/match/combat.js
   server/match/match/unitePhase.js
   server/match/match/views.js
   server/sim/units.js
   server/sim/battle/queries.js
   server/sim/snapshot.js
   shared/constants.js
   shared/protocol.js
   ```
2. 重启服务器，浏览器 **Ctrl+F5**（客户端文件没有构建步骤，改了就生效）。
3. 房间里**不要**再勾选脚本插件「朝向优化」：朝向已经由客户端做，两者同时开会互相覆盖模型的朝向。
4. 战斗速度在房间底部选：**×2** 是原来的节奏，**×4** 只加快，不改变战斗结果；最终攻势 / 隐秘核心仍是 ×2。

## 旧方案 / the old plugin

早些时候的「朝向优化」脚本插件已从这个仓库移除（它是进入延迟的来源）。历史在本仓库的 git 里（分支 `plugin-only`）；
装回它只需要 `node tools/plugin.mjs install <zip>`，但房间一旦启用脚本插件，每场战斗的启动开销就会回来。
