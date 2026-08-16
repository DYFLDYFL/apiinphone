export type AppMode = "chat" | "game" | "workspace";

export function ModeSwitcher({
  current,
  onSwitch,
  disabled,
}: {
  current: AppMode;
  onSwitch: (mode: AppMode) => void;
  disabled?: boolean;
}) {
  const items: Array<{ mode: AppMode; icon: string; label: string }> = [
    { mode: "chat", icon: "💬", label: "对话" },
    { mode: "workspace", icon: "📁", label: "工作区" },
    { mode: "game", icon: "🎲", label: "游戏" },
  ];
  return (
    <div className="mode-switcher" role="tablist">
      {items.map((item) => (
        <button
          key={item.mode}
          type="button"
          className={
            current === item.mode ? "mode-switcher-btn active" : "mode-switcher-btn"
          }
          title={item.label}
          aria-label={item.label}
          disabled={disabled}
          onClick={() => onSwitch(item.mode)}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}
