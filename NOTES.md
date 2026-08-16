# apiinphone 注意事项

只记录重要事项，按「改代码前必读」对待。

## 网络（go 网关 / 手机端）

- opencode go 网关**接受 HTTP/1.1**（曾误诊为「只接受 HTTP/2」）；**无 CORS**，网页版必须走 Vite 代理 `/go-gateway`；无效 Key 返回 500 而非 401。
- 调试以**手机 APK 为准**，网页版（Vite 代理）行为可能与手机不同（CORS / 流式）。
- Android 聊天/模型请求走 OkHttp 原生（`HttpNativePlugin`，HTTP/1.1 优先、网络层异常才回退 HTTP/2）；WebView fetch 的 CORS 与流式不可靠，不要改回。

## Android WebView 限制

- `window.confirm` / `alert` 静默失效——一律用 `src/lib/uiDialogs.ts` 的 `confirmAsync` / `showMessage`。
- `navigator.clipboard` 旧版 WebView 无此 API——用 `src/lib/clipboard.ts` 的 `copyText`。
- fetch 流式不可靠——聊天/模型请求走原生（见上）。

## 平台差异

- `run_python`：Android 用 Chaquopy（minSdk 24，构建机需 Python 3.12，首次构建慢）；浏览器用 Sandpy/Pyodide。

## 构建

- 改行为代码后必须 `.\build.ps1` 打 APK（自动升版），并在回复中回报版本号与 APK 路径。
