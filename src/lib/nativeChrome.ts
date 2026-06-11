import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";

const PANEL_LIGHT = "#ffffff";
const PANEL_DARK = "#1e293b";

let safeAreaListenersAttached = false;

function attachAndroidSafeAreaListeners(): void {
  if (safeAreaListenersAttached || Capacitor.getPlatform() !== "android") return;
  safeAreaListenersAttached = true;

  const root = document.documentElement;
  const update = () => {
    const vv = window.visualViewport;
    if (!vv) return;

    const top = Math.max(0, Math.round(vv.offsetTop));
    const bottom = Math.max(
      0,
      Math.round(window.innerHeight - vv.height - vv.offsetTop),
    );

    if (top > 0) root.style.setProperty("--safe-area-top", `${top}px`);
    if (bottom > 0) root.style.setProperty("--safe-area-bottom", `${bottom}px`);
  };

  update();
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
}

/** Status bar / gesture bar: keep system UI visible, pad app content below it. */
export async function configureNativeChrome(
  theme: "light" | "dark",
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const isDark = theme === "dark";
  const bg = isDark ? PANEL_DARK : PANEL_LIGHT;

  try {
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setBackgroundColor({ color: bg });
    await StatusBar.setStyle({ style: isDark ? Style.Light : Style.Dark });
    attachAndroidSafeAreaListeners();
  } catch {
    /* StatusBar unavailable outside native shell */
  }
}
