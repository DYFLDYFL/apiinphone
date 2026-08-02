# apiinphone — Agent 交接说明

新对话请先读本文件。用户界面与回复默认用中文。

## 项目是什么

Capacitor + React + Vite 的 **Android AI 客户端**（包名 `com.apiinphone.client`），对齐桌面 [aiusingapi](../aiusingapi)。  
主能力：DeepSeek 官方 API / 可选网页会话聊天、工具调用、多会话、用量面板；另有全屏 **多智能体游戏模式**。

当前版本（写本文时）：**1.4.23** / versionCode **26**。以 `package.json` 与 `android/app/build.gradle` 为准。

## 构建（改完代码必打）

仓库规则：改动 App 行为后必须执行 `.\build.ps1`（见 `.cursor/rules/auto-build-apk.mdc`）。  
默认 patch 升版本；`-SkipVersionBump` 可跳过。  
产物：`android\app\build\outputs\apk\debug\app-debug.apk`。  
回复须带出版本号与 APK 路径。纯文档可不打。

## 目录速查

| 路径 | 作用 |
|------|------|
| `src/App.tsx` | 壳：聊天 / 设置 / 游戏模式切换 |
| `src/lib/apiClient.ts` | 流式补全、工具循环 |
| `src/lib/settings.ts` | 设置；**游戏**用 `settingsForGame()` |
| `src/lib/deepseekWeb/` | 网页逆向（仅聊天可用；游戏禁用） |
| `src/components/game/GameScreen.tsx` | 游戏 UI |
| `src/lib/game/orchestrator.ts` | 推进一轮编排 |
| `src/lib/game/gameRunner.ts` | 后台推进、状态广播 |
| `src/lib/game/gameStore.ts` | 多局存档 / 剧情归档 |
| `src/lib/game/prompts.ts` | 世界 / 角色 / 裁判 / 书记 system prompt |
| `src/lib/game/templates.ts` | 建局模板、默认时刻 |
| `build.ps1` | 升版 + sync + assembleDebug |

## 游戏模式（定稿玩法 · 1.4.23）

### 通道

- `settingsForGame()` **强制** `deepseekTransport: "official"`，游戏从不走网页 Token。
- 创建/推进只校验 `apiKey`；页脚不再提网页会话 / `1/6`。
- `ModelSwitcher` `scope="game"` 不展示网页档位。

### 「推进一轮」流水线

每次点击：

1. 世界开场（若本 tick 需要，不拨钟）
2. **恰好一轮**交互：提案 → 回应 → 裁判（reject/redo 在同轮重试）
3. 整理剧情（上帝视角 / 玩家视角书记）
4. **立刻拨钟**（世界给 `nextTime`）

已取消：同时刻多轮上限（旧 `1/6` / `maxInteractionRounds` 逻辑）、靠裁判 `periodComplete` 决定是否再交互一轮。  
`maxInteractionRounds` 字段可仍存在于存档，**编排与 UI 不再依赖**。

### 时刻格式

- 默认开场：`三月初二 05:30`（`DEFAULT_INITIAL_TIME`）
- `nextTime`：可读日期 + **24h 时:分**（如 `三月初二 14:20`）
- **禁止**地支时辰（卯时等）、禁止「第 N 时」
- 跨度由世界按事件疏密定：紧 → 数十分钟～一两小时；闲 → 可半天/入夜/次日，仍须具体 `HH:mm`
- 旧档里的「卯时」字符串不强制迁移

### 游戏其它已有能力（勿重复造轮）

- 旁观 / 扮演；扮演可提交意图或「交给 AI」
- 侧栏：世界观 / 角色面板
- 玩家剧情须写入本人行动；开场未就绪时「推进一轮」禁用
- 每局独立文件夹存档；删局清文件夹；tick 剧情归档
- 软限流可自动重试（网页 SSE 路径相关；游戏已走官方）
- 建局模板可配世界/裁判/书记/角色提示词与模型；提案顺序（固定/随机/自定义）与串行/并行
- 推进一轮按可编辑流水线图执行（节点：开场/提案/回应/裁判/书记/拨钟；边条件含打回）

## 聊天侧要点（勿与游戏混淆）

- 设置里仍可选「网页会话」——**仅聊天**
- 内置工具：时间、搜索、`web_fetch`、`run_python`、`save_document`（无用户自定义工具 JSON）
- Android `run_python`：Chaquopy；浏览器：Sandpy/Pyodide
- 生成时可上滑；切后台有前台服务保活（划掉任务不保证）

## Agent 工作习惯

1. 大功能先调研开源：`.cursor/skills/composer-oss-research/SKILL.md`
2. 改完行为代码 → `.\build.ps1` → 回报版本与 APK
3. 用户说 push 时再 push，并按 `.cursor/rules/report-version-on-push.mdc` 报版本
4. 未要求则不改计划文件、不主动 commit
5. 长多任务：一逻辑单元一对话；跨对话用本文件 + `@` 相关源码，勿依赖超长聊天记忆

## 新对话开场示例

```text
@AGENTS.md 继续游戏相关：……
```

或指定文件：

```text
@AGENTS.md @src/lib/game/orchestrator.ts ……
```
