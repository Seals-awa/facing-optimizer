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
- `public/js/render/app.js` — **准备期部署干员也会播这条语音**：`landPiece` 在干员**新落到棋盘上**（`board`：从手牌/备战区
  放上去、交换；`buy`：买入落位）时调用 `sayPlace` → `audio.voice(charId, 'place')`（棋子 id `chess_char_*` 经
  `data.chess(...).charId` 映射到干员的 `char_*`，补位/自选取模型的 charId）；在棋盘内挪格（`move`）、合成、开局回放
  不播。战斗内的 `deploy` 事件沿用原来的 `place` 触发。

### 3. 攻击动画节奏 / attack-clip pacing

- `server/sim/snapshot.js` — `UnitInfo.atkInterval` = 干员真实攻击间隔 `s.interval`（含加成）。
- `public/js/render/attackRate.js` **（新文件）** — `startAtkInterval`（快照值 > 面板估值 > 1.2 s）、
  `nextAtkInterval`（第一次实测取代估值；之后**变化超过 8% 下一次出手直接跟上**，只有 30 Hz 抖动级的偏差才按 25% 轻微过渡；
  0.05–6 s 之外视为卡顿忽略）。
- `public/js/render/units.js` — 视图出生用 `startAtkInterval`；`onAttack` 的节奏平滑改用 `nextAtkInterval`，
  所以战斗第一刀就是正常速度（此前 宴 这类开技能后间隔 0.74 s、估值 1.20 s 的干员会慢放 62%）。

### 4. 战斗启动提速 / faster battle boot

- `public/js/battle/simHost.js` — 打完的 Worker **留暖**（按内容集 `cs` 区分，最多 1 个，180 s 过期）供下一场直接
  `start(spec)` 复用；`prewarmHost` 在开战 4 s 后**后台预热**下一个 Worker。
- `public/js/battle/runner.js` — 进战斗时优先取留暖的 Worker；淘汰条目时把它留暖而不是销毁；`dispose` 时清空池。
- `public/vendor/ses.umd.js` — **`[sp-patch]`**：有些引擎/WebView 的 `TextEncoder` 带一个不可删除的 own 属性 `arguments`，
  SES 的 `lockdown()` 删除它时抛错，整个脚本 Worker 停止（`PLUGIN_WORKER_FAILED`，
  `Cannot delete property 'arguments' of function TextEncoder()`）。补丁按它原本对待不可删除 `prototype` 的方式容忍并警告。

### 4. 测试 / tests

`test/facingRender.test.js`、`test/voiceGate.test.js`、`test/sesTolerance.test.js`、`test/simHostPool.test.js`
（`node --test test/xxx.test.js`；引擎内插件测试用 `node tools/plugin.mjs test <id>`，本仓库不含插件）。

## 怎么用 / How to apply

1. 复制过去（覆盖同名文件）：
   ```
   public/js/render/facing.js
   public/js/render/units.js
   public/js/render/app.js
   public/js/render/app/info.js
   public/js/screens/game/early.js
   public/js/audio.js
   public/js/battle/simHost.js
   public/js/battle/runner.js
   public/vendor/ses.umd.js
   server/sim/units.js
   server/sim/battle/queries.js
   server/sim/snapshot.js
   shared/protocol.js
   ```
2. 重启服务器，浏览器 **Ctrl+F5**（客户端文件没有构建步骤，改了就生效）。
3. 房间里**不要**再勾选脚本插件「朝向优化」：朝向已经由客户端做，两者同时开会互相覆盖模型的朝向。

## 旧方案 / the old plugin

早些时候的「朝向优化」脚本插件已从这个仓库移除（它是进入延迟的来源）。历史在本仓库的 git 里（分支 `plugin-only`）；
装回它只需要 `node tools/plugin.mjs install <zip>`，但房间一旦启用脚本插件，每场战斗的启动开销就会回来。
