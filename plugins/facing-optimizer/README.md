# 朝向优化 · Facing Optimizer

插件 id `facing-optimizer`，类别 `script`（脚本插件）。战斗里干员**只有模型**会转向自己的目标：攻击范围、技能范围、
伤害判定全部保持部署时的样子，和原版一模一样。转身带翻转过渡。

A `script` plugin: in battle each operator's **model** turns toward what it is fighting or healing. The operator itself
keeps fighting exactly as deployed — `unit.dir` (the direction that rotates the attack range) is never touched — so the
damage numbers of a battle with this plugin on are the vanilla ones. Turns are flips, not jump cuts.

## 谁转、谁不转 / Who turns

| 干员的普通攻击 | 转？ | 转向 |
|---|---|---|
| 单体伤害（速射手、近卫、单体术师…） | ✅ | 它会攻击的那个敌人（阻挡中的优先，其次是职业优先、仇恨、剩余路程，和引擎自己的索敌顺序一致） |
| 单奶（一次治疗一个：医师、疗养师、行医…） | ✅ | 它会治疗的那个队友（引擎的受伤排序第一名） |
| **群攻**：溅射、攻击范围内全体、同时攻击阻挡的所有敌人、连锁 | ❌ | 保持部署朝向 |
| **一次奶 2 个以上**：群愈师（multi）、链愈师（chain） | ❌ | 保持部署朝向 |
| 没有普通攻击（吟游者、阵法术师…） | ❌ | 保持部署朝向 |

被排除的干员会被**清空**外观朝向，也就是回到部署时的朝向；不会残留上一次的转身。

规则细节：

- 判定读的是引擎解析好的攻击档案（`unit.profile`，`server/sim/professions.js`）：`splashRadius`、`allInRange` /
  `rangeAoe`、`hitAllBlocked`、`chain`、`maxTargets`、`heal.mode`（`multi` / `chain` 算多目标）。
- 目标不是插件自己算的：敌人用 `kit.enemiesInGrid`（内部就是引擎的 `sortEnemyTargets`），队友用
  `battle.injuredAlliesInKeys`（引擎的治疗搜索）。所以"看向谁"和"打/治的是谁"是同一份判断。

## 什么时候转 / When it turns

**只有自己打得到、且真的有目标时才会转。** "打得到"指引擎自己会打的目标（`ai.js acquireTargets`）：

1. **它正在阻挡的敌人**（最近的那个，优先 —— 被阻挡的敌人即使站在攻击范围外也一定会挨打）；
2. 否则是攻击/治疗范围里索敌顺序第一名（职业优先 → 仇恨 → 剩余路程 → 出现顺序）。

打不到、也挡不住的敌人不会被面向；范围里没东西时保持部署朝向。

**近战：不预转，但会"起手"。** 近战的普通攻击只打自己阻挡的敌人，所以它**不会**朝还打不到的敌人提前转头（那样看着很
怪）；它只朝**已经挡下的那个敌人**转。如果这一下需要转身，**这次挥砍会被压住一个翻转的时长**（`FLIP_SECONDS` ≈ 0.05 s，
加上重新上膛约 **0.07 s 游戏时间**）再打出去 —— 也就是"能打到 → 转身 → 再打"，多出来的那一点点就是起手延迟。远程干员同理：
换目标时那一发会晚两帧左右，换来"先转好再开火"。

**先转向，再攻击。** 有三处会做判断，按"早→晚"排：

1. `enemySpawn` 钩子 —— 敌人出场那一刻（`spawns` 阶段，还没人挥砍）就面向它；
2. 0.05 秒的脉冲 —— 在 `scheduled` 阶段，排在 `attackCommit`、敌人移动、我方攻击**之前**；
3. `beforeAttack` 钩子 —— 引擎自己的"即将攻击"时点（`ai.js performAttack` 里，**早于** `lastAttackAt` 打时间戳、
   也早于这一发的 `atk` 事件）。如果到这一步才发现要转身，**这一下不打了**：清空目标让引擎跳过（不计攻击次数、
   不发 `atk`），把冷却压到 `FLIP_SECONDS`，两帧后再打 —— 于是"转向 → 隔两帧 → 出手"。

因此事件流里永远是「`vdir` 转向」在前、「`atk` 攻击」在后，而且需要转身的那一下会晚两帧左右（起手延迟）。

**动画当中一律不转。** 只有「开火之前」或「这一套动作结束之后」才换方向，正在播的动画里模型不动：

- **攻击动画期间不转**：`unit.lastAttackAt` 之后 `ATTACK_ANIM_TIME`（0.35 s）内锁定当前朝向；所以每一发攻击都不会
  带着转身，转身一定落在两次攻击之间的空档。
- **动作不能自理时也不转**：**晕眩 / 冻结 / 浮空**（`unit.canAct` 为假，冻结与浮空会带 `stun` 标记）与 **沉睡**
  （`flags.sleep`，不带 `stun` 但同样无法行动），整个异常状态期间朝向冻结，醒来后照常。
- **技能期间**（读的是 `unit.skill.spec`，技能自己声明的攻击覆盖）：

  | 技能类型 | 例子 | 朝向 |
  |---|---|---|
  | **群攻技能**（把普通攻击变成范围/多目标：`maxTargets > 1`、溅射、范围内全体、连锁） | 深巡 S1–S3（`maxTargets: 3`）、拉普兰德 S1（`maxTargets: 2`）、银灰 / 安洁莉娜 | **先回到部署朝向**（`skillStart` 那一下就把模型转回去），然后整个技能期间固定不动 |
  | 其余所有技能 —— 只改数值的姿态、充能、弹药、一瞬技能都算 | **宴**（14 秒数值姿态）、**忍冬** S1（充能）、**隐现**（弹药） | **照常转向**（只锁引擎自己那 0.5 秒的技能片段窗口） |

  "技能片段窗口"用的是引擎自己的量，不是我猜的：`unit.skillAnimUntil`（`skills.js` 每次 `activate` 都开 0.5 s，客户端
  正是靠它播技能片段）。除此之外技能不锁模型 —— 宴 / 忍冬 这类**无弹道近战**在技能动画期间**照样转身**。

  另外 薄绿（普通攻击就是 `allInRange` 群攻）与 白面鸮（群愈师，一次奶 3 个）本来就在"群攻 / 群奶不转"的名单里，
  整场都不会转 —— 和你说的表现一致。

**上下只在超过约 60° 时才算。** 目标与水平线的夹角 > 60° 才转 UP / DOWN（UP 用背面模型，就是"背向镜头"）：正上方的
敌人（90°）会转身朝上，斜 45° 的不会 —— 四方向模型是正面 / 背面 / 左右镜像，只有陡到一定程度才看得出是"抬头看它"。
判定是 `|行差| > tan60° × |列差|`（约 1.732 倍），对阻挡中的敌人同样适用。

**转回是慢的。** 它攻击过一次之后，模型会保持开火时的朝向，穿过整个攻击动画，再等 `holdSeconds`（默认 3 秒，
也就是 `ATTACK_ANIM_TIME 0.35 s + 3 s` 之后）才开始考虑转回：

- 还有能打到的目标（包括刚换成另一个目标）：在动作结束后的空档里直接面向它，不等 —— 打谁就看着谁；
- 目标没了（死了、走了、出范围了）：保持开火朝向，直到「攻击动画结束 + `holdSeconds`」，期间不会翻回去；
- 保持期结束仍然没目标：转回部署朝向（同样的翻转过渡）。

计时看的是引擎自己的 `unit.lastAttackAt` 与 `unit.skill.active`，和客户端的动作是同一个时钟。

## 翻转过渡 / The flip

每次转身都有一个过渡，**固定 0.05 秒**（不是设置项，`AIM_EVERY` / `FLIP_SECONDS` 两个常量都写死在插件里）：

- 左右换向：模型沿竖直轴转过 90° 再转过来（水平宽度从 +1 扫到 −1，经过 0 时正好侧对镜头）。
- 需要换模型（转成 UP / DOWN 用背面模型）：宽度收到 0 的那一刻交换正/背面模型，再张开 —— 交换藏在最窄的一帧里，
  不会出现瞬间换模型的突兀感。
- 缓动用 smoothstep，两端都不生硬；连续快速换向会从"当前画到的角度"接着转，不会跳。

## 设置 / Settings（房间插件面板里可改）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 关掉后所有模型保持部署朝向 |
| `holdSeconds` | number 0–10（步长 0.1） | `3` | 攻击动画结束后再保持朝向多久才转回（秒） |
| `includeTokens` | boolean | `false` | 召唤物也调模型朝向 |

**固定不开放改的两个时间**：判断间隔 `AIM_EVERY = 0.05 s`、翻转过渡 `FLIP_SECONDS = 0.05 s`（改插件源码里的常量即可）。

## 开启 / Enabling

脚本插件默认不执行，服主先开（否则插件状态是 `disabled`，房间里也开不了）：

```bash
node scripts/launch.mjs --scripts sandbox     # 或双击 scripts\start-windows-sandbox.bat
# 受信任的原生执行：--scripts trusted，需要在 plugins/config.json 的 trusted 里钉住 lock 的 SHA-256，
# 且房间里每位玩家都要点同意
```

启动日志里应出现 `[plugins] facing-optimizer 1.0.0 (script, loaded)`。然后在房间里点顶部「原版 / 插件 ×N」，勾选
「朝向优化」，房主点「应用设置」。注意：工作台的「试一场」也能用，但如果端口上已经有服务端在跑，
`start-windows-sandbox.bat` 只会打开浏览器、不会换成沙箱模式，要先关掉旧窗口。

### 一场打完会写一行日志 / a per-battle line in the server window

```
[plugin:facing-optimizer] facing-optimizer: 7 model turns this battle
```

- 没有这一行 → 插件没在跑（脚本模式没开、房间没勾选、或下面说的锁文件过期）。
- 写着 `0 model turns` → 插件在跑，但这一场没有任何"值得转"的目标（比如所有敌人都在干员正面、或者全是群攻/群奶）。

### 改了插件文件就要重新打包 / repack after every edit

`plugin.lock.json` 记着每个文件的哈希。只要 `plugins/facing-optimizer/` 里任何一个文件改过（哪怕只改 README），
服务器就会把它当成"文件已改变"而**禁用**这个插件，启动日志里是：

```
[plugins] scripts: facing-optimizer: 插件锁文件无效、文件已改变或受信任哈希不符
[plugins] facing-optimizer 1.0.0 (script, disabled)
```

改完跑一次 `node tools/plugin.mjs pack facing-optimizer --zip` 就恢复。（这一版的所有文件已经打包好，锁是新的。）

## 引擎里配套的一小段改动 / The engine side

游戏本体提供了"只画、不参与计算"的朝向通道（不是插件的一部分，插件只用公开的 `sp:sdk@1`）：

- `server/sim/units.js` — `unit.viewDir`（默认 `null` = 按 `dir` 画），模拟里没有任何代码读它。
- `server/sim/battle/queries.js` — `Battle.setViewDir(unit, dir, seconds)`：只写 `viewDir` 并发客户端事件，
  **不动** `unit.dir`、不重算范围。
- `server/sim/snapshot.js` / `public/js/render/app/info.js` — `UnitInfo.viewDir`：中途进入战场（观战、重连）也能看到
  已经转过的模型。
- `shared/protocol.js` — 事件 `EV.VDIR = 'vdir'`，`['vdir', id, dir|null, seconds]`。
- `public/js/render/app.js` — 收到 `vdir` 调 `view.setViewDir(dir, seconds)`；
  `public/js/render/units.js` — `viewDir` + 翻转过渡（`_startFlip` / 每帧 `_flipT`），画模型时用扫动中的水平符号。
- `public/js/battle/runner.js`、`public/js/screens/game/early.js` — `vdir` 和 `skill` 一样算状态事件（补帧、切后台、
  中途进战场不丢）。

拿到**没打这个补丁的 0.3.0** 上，插件会记一行日志后什么都不做（没有只改模型的通道，它也不肯动真实朝向）。

## 预算 / Budget

一场战斗每个插件 8000 次脚本执行（`server/sim/content/dsl/budget.js`），一次 `every` 回调算 1 次。判断间隔 0.05 秒 =
20 次/秒 ⇒ **约 6.5 分钟游戏时间**（游戏里现有的关卡都在这之内；超长的首领/联防局用完之后模型保持最后的朝向，其余一切
照常）。判断本身很便宜——只查已建好的格子索引，**不重算任何范围**；需要更长可用时间就把源码里的 `AIM_EVERY` 调大。

## 自检 / Self-check

```bash
node tools/plugin.mjs check facing-optimizer --strict
node tools/plugin.mjs test  facing-optimizer
node tools/plugin.mjs pack  facing-optimizer --zip
```

`test/facing.test.js` 用真实战斗引擎跑十九个用例：单体射手转向上方的敌人（并断言 `dir` 与 `rangeKeys` 一个字都没变、
`vdir` 事件带过渡时长）；**45° 的目标不会让它抬头（只有超过约 60° 才转 UP）**；打不到的敌人不面向；目标消失后先保持、
过了「攻击动画 + 3 秒」才转回；**近战挡住敌人后先转身、隔几帧再出手（起手延迟）**；**贴身（格子角上）的敌人会被抬头看**；
**重装转向它阻挡的敌人 —— 那个敌人并不在射程格子里**；攻击动画当中不转；**晕眩期间不转、醒来才转**；
**群攻技能先回部署朝向并锁定**；**非群攻技能（宴的数值姿态 / 隐现的弹药）照转**；**充能技能（忍冬 S1）不锁模型**；
先转好再开火；同一帧里转向一定在攻击之前；群攻术师不转；单奶转向受伤队友；群愈师不转；范围内没目标时不动。

## 说明 / Notes

- 不改数值、干员、技能和素材：只有一个 `sp.content.register({ install })` 模块，在战斗里挂一个计时器。
- 真实朝向不动，所以推击方向、正面判定、方向性技能特效、详情卡的范围预览都还是部署时的方向。
- 技能把单体攻击变成范围（比如某个群攻技能）时，插件仍按该干员的普通攻击判断——它只看 `unit.profile`；这是画面，
  不影响任何结算。

## 许可 / License

本插件（`plugins/facing-optimizer/`）以 **MIT** 许可发布，见同目录 [`LICENSE`](LICENSE)：Copyright (c) 2026 seals_awa。

游戏本体 卫戍协议：盟约 是 **GPL-3.0-or-later**（仓库根目录 `LICENSE`，另见 `NOTICE.md` / `THIRD-PARTY-NOTICES.md`）；
本插件只通过文档化的 `sp:sdk@1` / `sp.content.register` 接口调用游戏，是独立作品，所以用 MIT 发布。里面不含任何官方
游戏素材（美术、音频、Spine 都不带）。
