---
name: composer-oss-research
description: >-
  For apiinphone: research community open-source projects before implementing
  or changing features. Use for new tools, libraries, architecture, UI patterns,
  streaming chat, Capacitor/Android, citations, sessions, or when the user asks
  to reference open source / 社区开源 / GitHub / aiusingapi.
---

# apiinphone — 开源优先调研

在 **apiinphone** 仓库中动手改代码之前，**必须先调研社区开源相关项目**（含桌面版 aiusingapi、同类 Chat 客户端、Capacitor 方案），再基于成熟模式设计与实现。

## 何时触发（本项目默认较宽）

- 新建或修改功能、工具、UI 交互
- 选择/更换库、架构或 API 封装方式
- 用户提到「参考开源」「社区方案」「GitHub」「aiusingapi」
- 流式输出、思考链、工具调用展示、引用/来源、会话存储、模型列表等

**本项目偏好**：即使用户未重复强调，也应先简要调研再实现；仅当用户明确说「不要搜」「直接写」时可跳过。

## 调研流程（动手写代码前完成）

```
调研进度：
- [ ] 1. 搜索相关开源项目（GitHub / 文档 / 示例）
- [ ] 2. 筛选 2–5 个高质量候选（含 aiusingapi 若可访问）
- [ ] 3. 阅读 README、技术栈、核心实现文件
- [ ] 4. 提炼可复用的模式与库
- [ ] 5. 输出简短「开源参考」摘要，再开始实现
```

### 1. 搜索

用 WebSearch / GitHub，中英文各搜一轮，例如：

- `openai streaming chat react sse github`
- `capacitor chat app openai github`
- `markdown citation footnote chat ui`
- `site:github.com deepseek chat client`

优先：**活跃维护、文档完整、MIT/Apache 许可**。

### 2. 本仓库相关参考源

| 来源 | 说明 |
|------|------|
| `../aiusingapi`（若本地存在） | 桌面版对齐目标，优先对照 |
| Open WebUI、Lobe Chat、ChatGPT-Next-Web 等 | 流式、Markdown、引用 UI |
| Capacitor / Ionic 社区示例 | 原生壳、Filesystem、StatusBar |
| DeepSeek / OpenAI 官方文档 | SSE、`reasoning_content`、models API |

### 3. 深度阅读（至少 1–2 个项目）

- README 与限制
- 依赖与目录结构
- 与当前任务最接近的 1–3 个源文件（如 `apiClient`、viewer、session store）

可用 WebFetch 读 GitHub raw，**不要凭记忆臆造 API**。

### 4. 实现前输出（简短）

```markdown
## 开源参考
- [项目名](url) — 借鉴点：xxx

## 选型
- 采用：xxx（原因）
- 未整库复用：xxx（原因）
```

### 5. 实现原则

- 借鉴架构与已验证依赖，不盲目复制整仓
- 与 apiinphone 现有风格一致，**最小 diff**
- 在回复或 README 中注明主要参考来源

## 例外（仅用户明确时跳过）

- 用户说「不要搜」「直接写」
- 纯错别字/注释（无行为变化）

## 搜索技巧

- 英文关键词通常结果更多
- 找 minimal demo 仓库加速理解
- 官方 API 文档与 GitHub 项目同等重视
