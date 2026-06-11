import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.apiinphone.client",
  appName: "AI API Client",
  webDir: "dist",
  android: {
    allowMixedContent: true,
  },
  plugins: {
    // Patch fetch/XHR to native HTTP — fixes Android WebView failing on external search URLs
    CapacitorHttp: {
      enabled: true,
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
