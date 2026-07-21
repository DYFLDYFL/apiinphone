import { Capacitor, registerPlugin } from "@capacitor/core";

interface ChatKeepAlivePlugin {
  start(options: { title?: string; body?: string }): Promise<void>;
  stop(): Promise<void>;
  checkPermissions(): Promise<{ display: string }>;
  requestPermissions(): Promise<{ display: string }>;
}

const ChatKeepAlive = registerPlugin<ChatKeepAlivePlugin>("ChatKeepAlive");

let active = false;
let permissionAsked = false;

async function ensurePermission(): Promise<void> {
  if (permissionAsked) return;
  permissionAsked = true;
  try {
    const current = await ChatKeepAlive.checkPermissions();
    if (current.display === "granted") return;
    await ChatKeepAlive.requestPermissions();
  } catch {
    /* ignore — service may still start */
  }
}

export async function startChatKeepAlive(
  title = "AI API Client",
  body = "正在生成…",
): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") {
    return;
  }
  if (active) return;
  try {
    await ensurePermission();
    await ChatKeepAlive.start({ title, body });
    active = true;
  } catch {
    active = false;
  }
}

export async function stopChatKeepAlive(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") {
    return;
  }
  if (!active) {
    try {
      await ChatKeepAlive.stop();
    } catch {
      /* ignore */
    }
    return;
  }
  active = false;
  try {
    await ChatKeepAlive.stop();
  } catch {
    /* ignore */
  }
}
