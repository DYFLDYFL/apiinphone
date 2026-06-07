import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.apiinphone.client",
  appName: "AI API Client",
  webDir: "dist",
  android: {
    allowMixedContent: true,
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
