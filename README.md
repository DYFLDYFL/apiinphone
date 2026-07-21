# apiinphone

**Version 1.2.4**

Android 版 AI API 客户端，功能对齐桌面项目 [aiusingapi](../aiusingapi)。

## 功能

- Poe / DeepSeek OpenAI 兼容 API 对话
- 流式回复、思考过程展示
- Markdown + LaTeX 渲染（本地 KaTeX）
- 多会话管理（新建 / 重命名 / 删除 / 清空）
- 附件（图片、文本、小体积二进制 Base64；粘贴图片）
- Vision 识图（Poe；DeepSeek 自动降级为文本提示）
- Tool Calls：`get_current_time`、联网搜索、`web_fetch`、**`run_python`（Pyodide 沙盒）**
- 自定义工具：JSON 定义 + `x-apiinphone` 扩展（HTTP / 内置 JS handler）
- 用量面板：上下文占用、对话累计、上次请求、DeepSeek 余额
- 重试上一条回复、复制回复、停止生成
- 完整设置项（搜索引擎、SearXNG/Metaso/百度 Key、网络重试、Poe 头等）
- 浅色 / 深色主题

> **`run_python`**：基于 [Sandpy](https://github.com/Raynan00/sandpy)（Pyodide Web Worker），与桌面版类似的 import 白名单与超时；**首次运行需联网下载约 15MB**，之后浏览器会缓存。

### 自定义工具示例

在设置 → 自定义工具 JSON 中：

```json
[
  {
    "type": "function",
    "function": {
      "name": "echo_tool",
      "description": "回显参数",
      "parameters": {
        "type": "object",
        "properties": { "text": { "type": "string" } }
      }
    },
    "x-apiinphone": { "type": "js", "handler": "echo" }
  },
  {
    "type": "function",
    "function": {
      "name": "remote_api",
      "description": "调用远程 HTTP 接口",
      "parameters": {
        "type": "object",
        "properties": { "q": { "type": "string" } }
      }
    },
    "x-apiinphone": {
      "type": "http",
      "url": "https://example.com/api",
      "method": "POST"
    }
  }
]
```

内置 JS handler：`echo`、`json_stringify`、`format_args`。

## 开发运行（浏览器）

```powershell
cd c:\code\apiinphone
npm install
npm run dev
```

## 构建 APK

需要先安装 [Android SDK](https://developer.android.com/studio)（或 Android Studio），并设置环境变量：

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:PATH += ";$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\cmdline-tools\latest\bin"
```

然后执行：

```powershell
.\build.ps1
```

输出：

- Debug：`android\app\build\outputs\apk\debug\app-debug.apk`（或根目录 `AI-API-Client-debug.apk`）
- Release：`android\app\build\outputs\apk\release\app-release-unsigned.apk`（或根目录 `AI-API-Client-release-unsigned.apk`）

项目内置 Android SDK 位于 `android-sdk\`，`build.ps1` 会自动写入 `android\local.properties`。

设置保存在应用私有存储（Capacitor Preferences / Filesystem）。
