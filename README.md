# apiinphone

**Version 1.5.8**

Android 版 AI API 客户端，功能对齐桌面项目 [aiusingapi](../aiusingapi)。

## 功能

- DeepSeek OpenAI 兼容 API 对话
- 流式回复、思考过程展示
- 生成过程中可自由上翻查看上文（不会被拽回底部），右下角「↓」一键回到最新
- Markdown + LaTeX 渲染（本地 KaTeX）
- 多会话管理（新建 / 重命名 / 删除 / 清空）
- 附件（图片、文本、小体积二进制 Base64；粘贴图片）
- 图片附件会降级为文本提示（DeepSeek 不支持 vision）
- 内置工具：`get_current_time`、联网搜索、`web_fetch`、`run_python`、`save_document`（无自定义工具配置）
- 用量面板：上下文占用、对话累计、上次请求、DeepSeek 余额
- 重试上一条回复、复制回复、停止生成
- 设置：搜索引擎、导出目录、推理档位（随模型）、主题等
- 浅色 / 深色主题

> **`run_python`**：Android App 使用 [Chaquopy](https://chaquo.com/chaquopy/)（真 CPython，stdlib 白名单 + 超时）；浏览器使用 [Sandpy](https://github.com/Raynan00/sandpy)（Pyodide Web Worker，首次约 15MB）。策略与桌面版类似。

## 开发运行（浏览器）

```powershell
cd c:\code\apiinphone
npm install
npm run dev
```

## 构建 APK

需要先安装 [Android SDK](https://developer.android.com/studio)（或 Android Studio），并设置环境变量。构建机还需 **Python 3.12**（Chaquopy `buildPython`，Windows 可用 `py -3.12`）：

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:PATH += ";$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\cmdline-tools\latest\bin"
```

`minSdk` 为 **24**（Chaquopy 要求）。

然后执行：

```powershell
.\build.ps1
```

`build.ps1` 默认会自动把版本号 patch +1（`package.json` / `README` / `versionCode`），可用 `-SkipVersionBump` 跳过。

Debug / Release 均使用仓库内固定签名（`android/keystore/`），换机构建也可覆盖安装。若手机上已装的是其它签名的旧包，需先卸载一次再装。

输出：

- Debug：`android\app\build\outputs\apk\debug\app-debug.apk`
- Release：`android\app\build\outputs\apk\release\app-release.apk`

项目内置 Android SDK 位于 `android-sdk\`，`build.ps1` 会自动写入 `android\local.properties`。

设置保存在应用私有存储（Capacitor Preferences / Filesystem）。
