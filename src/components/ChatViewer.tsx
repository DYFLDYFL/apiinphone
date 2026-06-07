import { forwardRef, useEffect, useRef } from "react";
import { getViewerWindow } from "../lib/viewerBridge";

interface ChatViewerProps {
  theme: "light" | "dark";
  onReady?: () => void;
}

export const ChatViewer = forwardRef<HTMLIFrameElement, ChatViewerProps>(
  function ChatViewer({ theme, onReady }, ref) {
    useEffect(() => {
      const iframe =
        ref && typeof ref === "object" && "current" in ref
          ? ref.current
          : null;
      if (!iframe) return;
      const handleLoad = () => {
        getViewerWindow(iframe)?.setTheme(theme);
        onReady?.();
      };
      iframe.addEventListener("load", handleLoad);
      return () => iframe.removeEventListener("load", handleLoad);
    }, [onReady, ref, theme]);

    useEffect(() => {
      const iframe =
        ref && typeof ref === "object" && "current" in ref
          ? ref.current
          : null;
      getViewerWindow(iframe)?.setTheme(theme);
    }, [ref, theme]);

    return (
      <iframe
        ref={ref}
        title="chat-viewer"
        src="./viewer.html"
        className="chat-viewer"
      />
    );
  },
);

export function useChatViewerRef() {
  return useRef<HTMLIFrameElement>(null);
}

export function viewerFromRef(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
) {
  return getViewerWindow(iframeRef.current);
}
