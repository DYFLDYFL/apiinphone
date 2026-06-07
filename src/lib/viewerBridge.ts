export interface ViewerHandle {
  setTheme(theme: "light" | "dark"): void;
  clearMessages(): void;
  appendMessage(
    role: "user" | "assistant" | "system",
    text: string,
    options?: Record<string, unknown>,
  ): void;
  updateLastAssistant(
    text: string,
    typing?: boolean,
    reasoning?: string,
    reasoningTyping?: boolean,
  ): void;
  updateLastAssistantTools(
    tools: Array<{ status: string; label: string }>,
    active?: boolean,
  ): void;
  showError(text: string): void;
  scrollToBottom(): void;
}

export function getViewerWindow(iframe: HTMLIFrameElement | null): ViewerHandle | null {
  const win = iframe?.contentWindow as (Window & Partial<ViewerHandle>) | null;
  if (!win?.appendMessage) return null;
  return win as ViewerHandle;
}
