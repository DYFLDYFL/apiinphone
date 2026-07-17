import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.apiinphone.client",
  appName: "AI API Client",
  webDir: "dist",
  android: {
    allowMixedContent: true,
  },
  plugins: {
    // Keep false so chat SSE can use WebView fetch + getReader().
    // Search/fetch still call CapacitorHttp directly via nativeHttp.ts.
    CapacitorHttp: {
      enabled: false,
    },
    StatusBar: {
      overlaysWebView: false,
    },
  },
  server: {
    androidScheme: "https",
    allowNavigation: [
      "*.bing.com",
      "bing.com",
      "*.duckduckgo.com",
      "duckduckgo.com",
      "*.jina.ai",
      "s.jina.ai",
      "metaso.cn",
      "*.metaso.cn",
      "qianfan.baidubce.com",
      "*.baidubce.com",
    ],
  },
};

export default config;
