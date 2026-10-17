# 干员模型朝向 · 卫戍协议：盟约 0.3.0 客户端补丁

> 让**干员的模型**转向它正在攻击的目标（射程、朝向判定、伤害全都不变），顺带修了两个毛病：部署语音必定播放、进入战斗
> 不再卡 1～3 秒；现在还可以把**战斗期倍速**切到 ×4 —— 只加快节奏，战斗结果逐位不变。
>
> A client patch for **Stronghold Protocol: Alliance v0.3.0** (a fan remake of 明日方舟's 「卫戍协议：盟约」): an operator's
> *model* turns toward the enemy it is attacking — display only, `dir` / range / damage untouched — plus a room-wide
> ×2 / ×4 battle speed that changes only the pace, never a battle's result.

作者 **seals_awa** · 补丁本身 **MIT**（游戏本体是 GPL-3.0-or-later，见 [LICENSE](LICENSE) / 原仓库）

---

## 这个仓库是什么

**只放改动过的文件**，全部按游戏里的原路径排列。不是完整游戏，也不能单独运行 —— 把它**覆盖**到一份 0.3.0 安装上即可。

- 逐文件的说明：[PATCH.md](PATCH.md)
- 游戏原本的说明：[README.game.md](README.game.md)
- 改动记录：[CHANGELOG.md](CHANGELOG.md)（顶部的「未发布」小节）

## 功能

### 1. 干员模型朝向（核心）

干员攻击谁，**模型就转向谁**；停手 3 秒后转回部署方向。转身有 0.05 秒的翻面过渡（正/背面在侧对瞬间切换，看不出跳帧）。

| 情况 | 表现 |
|---|---|
| 目标在正上 / 正下方（> 约 60°） | 用背面模型抬头/低头看它 |
| 目标在同一水平线附近（≤ 约 60°） | 保持左右朝向 |
| 贴身的敌人（被挡住在格子角上） | 按"上下优先"判，抬头看 |
| **群攻**（同一帧打到多个目标） | **不转**（否则会在多个目标之间乱闪） |
| 被**晕眩 / 冻结 / 沉睡** | 不转 |
| 群奶（一次奶多个） | 不转 |

**关键：只改画面。** `unit.dir`、攻击范围（格子）、目标选择、伤害结算、推击方向、方向性技能判定全部保持部署时的样子 ——
详情卡里的范围预览也不会变。

### 2. 部署语音必定播放（准备期部署干员时也播）

**触发点**：准备期干员落到棋盘上就播它的**部署语音** —— 从手牌/备战区放上去（`board`）、买入后落位（`buy`）、
**在棋盘内挪格子 / 交换位置（`move`）**，以及战斗内的部署事件；只有合成（`merge`）和开局回放（`round`）不播。
**不同干员**接连落位时会**打断**上一条部署语音、立刻播新的（interrupt）；**同一位干员**重复落位（挪格子）不会重复播。
战斗内八个干员同时部署则不会互相打断（避免连珠炮），第一条念完为止。

播的时候不再被 1.2 秒的全局间隔吞掉：

- 空频道 → 必播；
- 正在播**选中语音**（点开干员）→ **打断它**；
- 正在播更重要的语音（开战 / 接敌 / 作战中 / 结算）→ 排队，等它结束后补播（最多等 8 秒）。

### 3. 攻击动画节奏（战斗开始不再"慢放"）

攻击动画是按**干员当前攻击间隔**拉伸播放的。以前开局用的是"基础面板"估的间隔（`bat × 100 / aspd`，不含战斗中加成），
而技能/加成会让真实间隔更短 —— 比如 宴 开技能后真实间隔 0.74 s，估值 1.20 s，动画就会被拉长 **62% 看着像慢放**，要等测到
两次攻击的间隔后才慢慢正常。

现在：快照带上干员**真实攻击间隔**（`UnitInfo.atkInterval` = 模拟里的 `s.interval`，含加成），视图一出生就用它；
实测也不再慢慢平滑 —— **变化超过 8%（技能开关、攻速增减）下一次出手就直接跟上**，只有 30 Hz 时钟级别的抖动（约 3.3%）
才按 25% 轻微过渡。所以第一刀就是正常速度，技能前后也不会"飘"。
想更激进就把 `ATK_JUMP_TOLERANCE` 设为 0（完全照实测走）；想更稳就调大这个比例、或把 `ATK_DRIFT_SHARE` 调小。

### 4. 进入战斗提速

**只有带脚本插件的房间才走 Worker。** 模块 Worker 是为了 GPU 之外的"脚本沙箱"（SES）而存在的，它每场战斗都要重新导入整套
引擎、加载 SES、lockdown()、编译插件源码 —— 手机上就是那几秒卡顿。而**纯数据插件**（数值 / 干员 / 敌人 / 商店 …，没有脚本）
根本不需要沙箱，现在直接在**页面内**模拟，和原生内容完全一样，于是这类房间进战斗不再有 Worker 启动。

带脚本插件的房间仍然用 Worker，并做了两件事：

- 打完的 Worker **留暖**复用，并在开战 4 秒后**后台预热**下一个；
- 修掉 SES 在部分 Android WebView 上 lockdown() 崩溃的问题
  （`Cannot delete property 'arguments' of function TextEncoder()`，会让脚本插件整场失效）。

> 而朝向功能**已经搬到客户端渲染层**，脚本插件可以完全不用 —— 房间回到"只有数据插件"甚至原生，进战斗零额外延迟。

### 5. 战斗期倍速 2× / 4×（房间统一，结果不变）

房主在房间底部把**战斗速度**设为 **×2**（默认，即原来的节奏）或 **×4**，整个房间的**常规作战与联防**都按这个速度推进；
作战中顶栏会显示一个 `×4` 小牌，倒计时也按倍速缩短。

**关键是：只改节奏，不改结果。** 模拟一直按固定的 1/30 秒一步（tick）推进，倍速只决定一秒里走多少步 —— 同一场战斗在
两种速度下走的是**完全相同的 tick 序列**，伤害、击杀、漏怪、盟约层数、掉落和结算逐位相同，只有现实用时减半。
客户端、服务器推进、结果截止与兜底都用同一个速度。

**最终攻势 / 隐秘核心始终 ×2**：它们的共享领袖血池按服务器真实时间记账，加速只会让客户端上报的伤害被暂时压后。

> 这不是插件：插件 API 无法改战斗节奏（`sim.*` 在战斗内部、`ui` 插件不能发对局意图），所以和朝向一样做在引擎与界面里。

## 安装

1. 找一份 0.3.0 的安装目录，把本仓库这些文件**覆盖**过去（保持相对路径）：

   ```
   public/js/battle/runner.js
   public/js/battle/simHost.js
   public/js/render/app.js
   public/js/render/app/info.js
   public/js/render/facing.js          ← 新文件
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

2. **重启服务器**（`npm start` 或双击 `启动游戏.bat` / `scripts\start-windows.bat`）。
3. 浏览器 **Ctrl+F5** 强刷（客户端没有构建步骤，改了立刻生效，但要绕过缓存）。
4. 房间里**不要**再勾选「朝向优化」脚本插件 —— 朝向已由客户端完成，两者同时开会互相覆盖模型的朝向。
5. 战斗速度在**房间底部**选：×2 是原来的节奏，×4 只加快、不改变结果；最终攻势 / 隐秘核心仍是 ×2。

## 想调整

| 想改什么 | 改哪里 |
|---|---|
| 转身过渡时长 | [public/js/render/facing.js](public/js/render/facing.js) 的 `FACING_FLIP_S`（默认 0.05 秒） |
| 停手后多久转回 | 同文件 `FACING_HOLD_S`（默认 3 秒） |
| 抬头角度阈值 | 同文件 `facingDir` 里的 `1.7320508075688772`（tan 60°；想要 45° 就改成 1） |
| 整体关掉朝向 | 把 `units.js` 里 `onAttack` 中调用 `setViewDir` 的那段注释掉，或把 `FACING_HOLD_S` 设为 0 后只在攻击瞬间转向 |
| 语音行为 | [public/js/audio.js](public/js/audio.js) 的 `VOICE_ALWAYS_SLOTS`（哪些槽位"必定播放"）、`VOICE_QUEUE_TTL_MS` |
| 战斗速度档位 | [shared/constants.js](shared/constants.js) 的 `BATTLE_SPEEDS`（默认 `[2, 4]`，再加 `3`、`6` 也可以） |
| 首领战是否也加速 | [shared/constants.js](shared/constants.js) 的 `battleSpeedOf`：删掉 `boss` / `hidden` 那一行就全部倍速 |

## 已知限制

- 朝向按"攻击目标"驱动：**奶**（治疗）与**推击/位移**的方向不跟随，模型保持部署方向。
- 技能姿态（例如群攻技能）不特判：技能期间若仍在普攻，模型会跟着普攻目标转。
- 若服务器上还启用着其它**改动内容**的插件，模拟仍会进 Worker，那段启动开销只是变少（不再加载 SES 与脚本），不会完全消失。
- 战斗速度是**房间统一**的（房主设置，其他人在房间里看得到但改不了），不是每个人各调各的；最终攻势 / 隐秘核心固定 ×2。
- 只有装了本补丁的服务器才有这个选项；旧服务器没有 `room.setBattleSpeed`，客户端会显示 ×2 且点击无效果。

## 测试

仓库里有这些纯 Node 用例（不需要浏览器）：

```bash
node --test test/facingRender.test.js    # 6 个：朝向判据、60° 阈值、贴身、时间常数
node --test test/voiceGate.test.js       # 11 个：部署语音必播 / 打断选中 / 排队 / 其余语音的官方调度
node --test test/sesTolerance.test.js    # 2 个：不可删除的 arguments 不会让 SES lockdown 失败
node --test test/simHostPool.test.js     # 7 个：暖 Worker 池（复用、按内容集区分、失败不入池、TTL）
node --test test/battleSpeed.test.js     # 6 个：只接受 2/4、首领会 2×、房主设置、服务器推进、截止缩放、
                                         #       同一场战斗在 2 tick / 4 tick 一帧下结果完全相同
```

## 许可 / License

- 本补丁（`public/`、`server/`、`shared/`、`test/` 下的改动）：**MIT**，见 [LICENSE](LICENSE)。
- 游戏本体 卫戍协议：盟约：**GPL-3.0-or-later**（见 [LICENSE](LICENSE) 原文与 [NOTICE.md](NOTICE.md) /
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)）；本仓库只是它的改动文件，分发时仍按 GPL-3.0-or-later。
- 不含任何官方游戏素材（美术 / 音频 / Spine 均未包含）。
