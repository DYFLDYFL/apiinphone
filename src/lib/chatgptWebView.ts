import { Capacitor, registerPlugin } from "@capacitor/core";

interface ChatGptWebViewPlugin {
  open(): Promise<void>;
  close(): Promise<void>;
}

const ChatGptWebView = registerPlugin<ChatGptWebViewPlugin>("ChatGptWebView");

export async function openChatGptWebView(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") {
    throw new Error("ChatGPT 网页内嵌目前仅支持 Android APK。");
  }
  await ChatGptWebView.open();
}

export async function closeChatGptWebView(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") {
    return;
  }
  await ChatGptWebView.close();
}
