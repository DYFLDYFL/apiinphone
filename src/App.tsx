import { useCallback, useEffect, useRef, useState } from "react";
import { configureNativeChrome } from "./lib/nativeChrome";
import type {
  AppSettings,
  AttachmentPreview,
  ChatMessage,
  ChatSession,
  DisplayMessage,
  TokenUsage,
  ToolTraceItem,
} from "./types";
import {
  chatStream,
  createStreamControl,
  fetchDeepseekBalance,
} from "./lib/apiClient";
import {
  buildUserMessage,
  describeAttachment,
  loadAttachmentsFromFiles,
  loadPastedImage,
} from "./lib/attachments";
import { formatBalanceDisplay } from "./lib/usageInfo";
import {
  effectiveModel,
  loadSettings,
  rememberModel,
  saveSettings,
  thinkingActive,
  thinkingChainVisible,
} from "./lib/settings";
import { warmupPythonSandbox } from "./lib/sandbox/pythonSandbox";
import {
  createNewSession,
  deleteSession,
  listSessions,
  loadActiveSession,
  renameSession,
  saveSession,
  setActiveSession,
  titleFromFirstMessage,
} from "./lib/sessionStore";
import { collectNumberedSources } from "./lib/searchSources";
import { buildToolTrace } from "./lib/tools";
import { ChatViewer, useChatViewerRef, viewerFromRef } from "./components/ChatViewer";
import { InfoPanel } from "./components/InfoPanel";
import { RenameDialog } from "./components/RenameDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import "./index.css";

interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
}

function normalizeToolTrace(
  trace: DisplayMessage["toolTrace"],
): ToolTraceItem[] {
  if (!trace) return [];
  if (Array.isArray(trace)) return trace;
  return trace.split("\n").map((line, i) => ({
    id: String(i),
    name: "",
    label: line.replace(/^-\s*/, ""),
    status: "done" as const,
  }));
}

export default function App() {
  const viewerRef = useChatViewerRef();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [viewerReady, setViewerReady] = useState(false);
  const [lastUsage, setLastUsage] = useState<TokenUsage | null>(null);
  const [balanceLines, setBalanceLines] = useState<string[]>([]);
  const [balanceError, setBalanceError] = useState("");
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameId, setRenameId] = useState("");
  const [statusText, setStatusText] = useState("");
  const streamControlRef = useRef(createStreamControl());
  const toolTraceRef = useRef<ToolTraceItem[]>([]);
  const composingRef = useRef(false);

  const refreshSessions = useCallback(async () => {
    setSessions(await listSessions());
  }, []);

  const renderSession = useCallback(
    (
      current: ChatSession,
      theme: "light" | "dark",
      showThinkingChain: boolean,
    ) => {
      const viewer = viewerFromRef(viewerRef);
      if (!viewer) return;
      viewer.setTheme(theme);
      viewer.clearMessages();
      for (const msg of current.display) {
        if (msg.role === "user") {
          viewer.appendMessage("user", msg.content);
        } else {
          viewer.appendMessage("assistant", msg.content, {
            reasoning: showThinkingChain ? msg.reasoning : undefined,
            tools: normalizeToolTrace(msg.toolTrace),
            sources: msg.sources,
          });
        }
      }
      viewer.scrollToBottom();
    },
    [viewerRef],
  );

  useEffect(() => {
    void (async () => {
      const loaded = await loadSettings();
      setSettings(loaded);
      const active = await loadActiveSession();
      setSession(active);
      await refreshSessions();
      if (!loaded.apiKey.trim()) setSettingsOpen(true);
      if (loaded.toolsEnabled && loaded.toolsPythonSandbox) {
        void warmupPythonSandbox().catch(() => {
          /* first-run download may fail offline */
        });
      }
      await configureNativeChrome(loaded.theme);
    })();
  }, [refreshSessions]);

  useEffect(() => {
    if (!settings || !session || !viewerReady) return;
    renderSession(session, settings.theme, thinkingChainVisible(settings));
  }, [session?.id, viewerReady, settings, renderSession]);

  const refreshBalance = useCallback(async (current: AppSettings) => {
    if (current.apiProvider !== "deepseek" || !current.apiKey.trim()) {
      setBalanceLines([]);
      setBalanceError("");
      return;
    }
    setBalanceLoading(true);
    setBalanceError("");
    try {
      const balance = await fetchDeepseekBalance(current);
      setBalanceLines(formatBalanceDisplay(balance));
    } catch (err) {
      setBalanceLines([]);
      setBalanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    if (settings) void refreshBalance(settings);
  }, [settings?.apiKey, settings?.apiProvider, refreshBalance]);

  const persistSettings = async (next: AppSettings) => {
    setSettings(next);
    await saveSettings(next);
    await configureNativeChrome(next.theme);
    void refreshBalance(next);
  };

  const persistSession = async (next: ChatSession) => {
    setSession(next);
    await saveSession(next);
    await refreshSessions();
  };


  const runChat = async (
    history: ChatMessage[],
    displayBase: DisplayMessage[],
    sessionBase: ChatSession,
    userAlreadyShown: boolean,
  ) => {
    if (!settings) return;

    setBusy(true);
    setStatusText("正在请求…");
    streamControlRef.current = createStreamControl();
    toolTraceRef.current = [];
    let streamText = "";
    let streamReasoning = "";
    const viewer = viewerFromRef(viewerRef);

    if (!userAlreadyShown && displayBase.length) {
      const last = displayBase[displayBase.length - 1];
      if (last.role === "user") viewer?.appendMessage("user", last.content);
    }
    viewer?.appendMessage("assistant", "", { typing: true });
    if (thinkingChainVisible(settings)) {
      viewer?.updateLastAssistant("", true, "", true);
    }

    let reasoningStreaming = false;
    let viewerRaf = 0;
    const pushViewerStream = () => {
      if (thinkingChainVisible(settings)) {
        viewer?.updateLastAssistant(
          streamText,
          true,
          streamReasoning,
          reasoningStreaming && !streamText,
        );
      } else {
        viewer?.updateLastAssistant(streamText, true);
      }
    };
    const scheduleViewerStream = () => {
      if (viewerRaf) return;
      viewerRaf = requestAnimationFrame(() => {
        viewerRaf = 0;
        pushViewerStream();
      });
    };

    try {
      const response = await chatStream(settings, history, {
        control: streamControlRef.current,
        onStreamRoundStart: () => {
          streamText = "";
          scheduleViewerStream();
        },
        onDelta: (delta) => {
          streamText += delta;
          reasoningStreaming = false;
          scheduleViewerStream();
        },
        onReasoningDelta: (delta) => {
          streamReasoning += delta;
          reasoningStreaming = true;
          if (thinkingChainVisible(settings)) {
            scheduleViewerStream();
          }
        },
        onToolStatus: (phase, id, label, meta) => {
          if (phase === "start") {
            toolTraceRef.current.push({
              id,
              name: meta?.name ?? "",
              status: "running",
              label,
              args: meta?.args,
            });
          } else if (phase === "waiting") {
            setStatusText(label);
          } else {
            const entry = toolTraceRef.current.find((t) => t.id === id);
            if (entry) {
              entry.status = phase === "done" ? "done" : "error";
              entry.label = label;
              if (meta?.name) entry.name = meta.name;
              if (meta?.result) entry.result = meta.result;
            }
          }
          viewer?.updateLastAssistantTools(toolTraceRef.current, true);
        },
      });

      const toolTrace =
        buildToolTrace([
          ...response.apiMessages.filter((m) => m.role !== "user"),
        ]) || toolTraceRef.current;
      const hadTools =
        toolTrace.length > 0 ||
        response.apiMessages.some((m) => m.role === "tool");
      const toolHadError = toolTrace.some((t) => t.status === "error");
      const finalContent =
        response.content ||
        streamText ||
        (hadTools && toolHadError
          ? "模型未返回最终答复（联网搜索等工具可能失败，请查看工具状态或更换搜索引擎后重试）。"
          : hadTools
            ? "模型未返回最终文字（工具已执行，可点击重新生成）。"
            : "") ||
        response.note ||
        "(无内容)";

      const sources = collectNumberedSources(toolTrace);

      if (response.note === "已取消" && streamText.trim()) {
        const assistantDisplay: DisplayMessage = {
          role: "assistant",
          content: streamText,
          reasoning: thinkingActive(settings) ? streamReasoning : undefined,
          toolTrace,
          sources: sources.length ? sources : undefined,
          note: response.note,
        };
        const finalSession: ChatSession = {
          ...sessionBase,
          history: [...sessionBase.history, ...response.apiMessages],
          display: [...displayBase, assistantDisplay],
          promptTokens:
            sessionBase.promptTokens + (response.usage?.promptTokens ?? 0),
          completionTokens:
            sessionBase.completionTokens +
            (response.usage?.completionTokens ?? 0),
          totalTokens:
            sessionBase.totalTokens + (response.usage?.totalTokens ?? 0),
          contextTokens: response.usage?.promptTokens ?? sessionBase.contextTokens,
          cacheHitTokens:
            sessionBase.cacheHitTokens +
            (response.usage?.promptCacheHitTokens ?? 0),
        };
        await persistSession(finalSession);
        setLastUsage(response.usage);
        viewer?.updateLastAssistant(streamText, false, streamReasoning, false);
        viewer?.updateLastAssistantSources(sources);
        setStatusText("已取消");
        return;
      }

      const assistantDisplay: DisplayMessage = {
        role: "assistant",
        content: finalContent,
        reasoning: thinkingActive(settings) ? response.reasoning : undefined,
        toolTrace,
        sources: sources.length ? sources : undefined,
        note: response.note || undefined,
      };

      const finalSession: ChatSession = {
        ...sessionBase,
        history: [...sessionBase.history, ...response.apiMessages],
        display: [...displayBase, assistantDisplay],
        promptTokens:
          sessionBase.promptTokens + (response.usage?.promptTokens ?? 0),
        completionTokens:
          sessionBase.completionTokens + (response.usage?.completionTokens ?? 0),
        totalTokens:
          sessionBase.totalTokens + (response.usage?.totalTokens ?? 0),
        contextTokens: response.usage?.promptTokens ?? sessionBase.contextTokens,
        cacheHitTokens:
          sessionBase.cacheHitTokens +
          (response.usage?.promptCacheHitTokens ?? 0),
      };

      await persistSession(finalSession);
      setLastUsage(response.usage);
      const savedSettings = rememberModel(settings, effectiveModel(settings));
      if (savedSettings !== settings) await persistSettings(savedSettings);
      void refreshBalance(settings);

      viewer?.updateLastAssistantTools(toolTrace, false);
      if (thinkingChainVisible(settings)) {
        viewer?.updateLastAssistant(
          finalContent,
          false,
          response.reasoning || streamReasoning,
          false,
        );
      } else {
        viewer?.updateLastAssistant(finalContent, false);
      }
      viewer?.updateLastAssistantSources(sources);
      setStatusText("完成");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const toolTrace = [...toolTraceRef.current];
      const partial = streamText.trim();
      const errorBody = partial
        ? `${partial}\n\n---\n请求失败：${message}`
        : toolTrace.length
          ? `工具已执行，但后续请求失败：${message}`
          : `请求失败：${message}`;

      const errorSources = collectNumberedSources(toolTrace);
      const errorDisplay: DisplayMessage = {
        role: "assistant",
        content: errorBody,
        reasoning:
          thinkingActive(settings) && streamReasoning ? streamReasoning : undefined,
        toolTrace: toolTrace.length ? toolTrace : undefined,
        sources: errorSources.length ? errorSources : undefined,
      };

      const failedSession: ChatSession = {
        ...sessionBase,
        display: [...displayBase, errorDisplay],
      };

      await persistSession(failedSession);
      renderSession(failedSession, settings.theme, thinkingChainVisible(settings));
      setStatusText(message);
    } finally {
      if (viewerRaf) cancelAnimationFrame(viewerRaf);
      setBusy(false);
    }
  };

  const handleSend = async () => {
    if (!settings || !session || busy) return;
    const text = input.trim();
    if (!text && !attachments.length) return;
    if (!settings.apiKey.trim()) {
      setSettingsOpen(true);
      return;
    }

    const { content, apiContent } = buildUserMessage(text, attachments, settings);
    const userDisplay: DisplayMessage = { role: "user", content };
    const userMessage: ChatMessage = { role: "user", content: apiContent };

    const history: ChatMessage[] = [];
    if (settings.systemPrompt.trim()) {
      history.push({ role: "system", content: settings.systemPrompt.trim() });
    }
    history.push(...session.history, userMessage);

    const nextSession: ChatSession = {
      ...session,
      history: [...session.history, userMessage],
      display: [...session.display, userDisplay],
      title:
        session.display.length === 0
          ? titleFromFirstMessage(text || attachments[0]?.name || "新对话")
          : session.title,
    };
    setSession(nextSession);
    setInput("");
    setAttachments([]);

    await runChat(history, nextSession.display, nextSession, false);
  };

  const handleRegenerate = async () => {
    if (!settings || !session || busy || session.display.length < 2) return;
    const last = session.display[session.display.length - 1];
    if (last.role !== "assistant") return;

    const trimmedHistory = [...session.history];
    while (
      trimmedHistory.length &&
      (trimmedHistory[trimmedHistory.length - 1].role === "assistant" ||
        trimmedHistory[trimmedHistory.length - 1].role === "tool")
    ) {
      trimmedHistory.pop();
    }

    const trimmedDisplay = session.display.slice(0, -1);
    const baseSession = { ...session, history: trimmedHistory, display: trimmedDisplay };
    setSession(baseSession);
    renderSession(baseSession, settings.theme, thinkingChainVisible(settings));

    const history: ChatMessage[] = [];
    if (settings.systemPrompt.trim()) {
      history.push({ role: "system", content: settings.systemPrompt.trim() });
    }
    history.push(...trimmedHistory);
    await runChat(history, trimmedDisplay, baseSession, true);
  };

  const handleCopyLast = async () => {
    if (!session?.display.length) return;
    const last = [...session.display].reverse().find((m) => m.role === "assistant");
    if (!last?.content) return;
    try {
      await navigator.clipboard.writeText(last.content);
      setStatusText("已复制回复");
    } catch {
      setStatusText("复制失败");
    }
  };

  const handleNewSession = async () => {
    if (busy) return;
    const next = await createNewSession();
    setSession(next);
    setDrawerOpen(false);
    await refreshSessions();
  };

  const handleSelectSession = async (id: string) => {
    if (busy || !session || session.id === id) return;
    await setActiveSession(id);
    const loaded = await loadActiveSession();
    setSession(loaded);
    setDrawerOpen(false);
  };

  const handleDeleteSession = async (id: string) => {
    if (busy) return;
    if (!window.confirm("确定删除此对话？")) return;
    const next = await deleteSession(id);
    setSession(next);
    await refreshSessions();
  };

  const handleRenameSession = (id: string) => {
    setRenameId(id);
    setRenameOpen(true);
  };

  const confirmRename = async (title: string) => {
    setRenameOpen(false);
    const next = await renameSession(renameId, title);
    if (next && session?.id === renameId) setSession(next);
    await refreshSessions();
  };

  const handleClearChat = async () => {
    if (!session || busy) return;
    if (!window.confirm("确定清空当前对话？")) return;
    const next = {
      ...session,
      history: [],
      display: [],
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      cacheHitTokens: 0,
    };
    await persistSession(next);
    viewerFromRef(viewerRef)?.clearMessages();
    setLastUsage(null);
  };

  const handleAttach = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const loaded = await loadAttachmentsFromFiles(files);
      setAttachments((prev) => [...prev, ...loaded].slice(0, 10));
    } catch (err) {
      alert(String(err));
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        try {
          const att = await loadPastedImage(blob);
          setAttachments((prev) => [...prev, att].slice(0, 10));
        } catch (err) {
          alert(String(err));
        }
        return;
      }
    }
  };

  const handleCancel = () => {
    streamControlRef.current.cancel();
    setStatusText("正在停止…");
  };

  if (!settings || !session) {
    return <div className="boot">加载中…</div>;
  }

  return (
    <div className={`app theme-${settings.theme}`}>
      <header className="topbar">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setDrawerOpen(true)}
          aria-label="对话列表"
        >
          ☰
        </button>
        <div className="topbar-title">
          <div className="title">{session.title}</div>
          <div className="subtitle">
            {balanceLines[0] ?? statusText ?? effectiveModel(settings)}
          </div>
        </div>
        <div className="topbar-actions">
          <button type="button" className="icon-btn" onClick={() => setInfoOpen(true)} title="用量">
            ℹ
          </button>
          <button type="button" className="icon-btn" onClick={() => setSettingsOpen(true)}>
            ⚙
          </button>
        </div>
      </header>

      <main className="main">
        <ChatViewer
          ref={viewerRef}
          theme={settings.theme}
          onReady={() => setViewerReady(true)}
        />
      </main>

      <footer className="composer">
        {attachments.length > 0 && (
          <div className="attachment-bar">
            {attachments.map((att, idx) => (
              <span key={`${att.name}-${idx}`} className="attachment-chip">
                {describeAttachment(att)}
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((_, i) => i !== idx))
                  }
                >
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              className="link-btn"
              onClick={() => setAttachments([])}
            >
              清空
            </button>
          </div>
        )}
        <textarea
          value={input}
          placeholder="输入消息…（Enter 发送，Shift+Enter 换行，可粘贴图片）"
          rows={2}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onPaste={(e) => void handlePaste(e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !composingRef.current) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <div className="composer-actions">
          <label className="secondary-btn file-btn">
            附件
            <input
              type="file"
              multiple
              accept="image/*,.txt,.md,.json,.py,.csv,.xml,.html,.css,.js,.ts"
              hidden
              onChange={(e) => void handleAttach(e.target.files)}
            />
          </label>
          <button
            type="button"
            className="secondary-btn"
            disabled={busy || session.display.length < 2}
            onClick={() => void handleRegenerate()}
          >
            重试
          </button>
          <button type="button" className="secondary-btn" onClick={() => void handleCopyLast()}>
            复制
          </button>
          {busy ? (
            <button type="button" className="secondary-btn" onClick={handleCancel}>
              停止
            </button>
          ) : (
            <button type="button" className="primary-btn" onClick={() => void handleSend()}>
              发送
            </button>
          )}
        </div>
      </footer>

      {drawerOpen && (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <strong>对话列表</strong>
              <button type="button" className="secondary-btn" onClick={() => void handleNewSession()}>
                新建
              </button>
            </div>
            <div className="session-list">
              {sessions.map((item) => (
                <div
                  key={item.id}
                  className={`session-item ${item.id === session.id ? "active" : ""}`}
                >
                  <button
                    type="button"
                    className="session-title"
                    onClick={() => void handleSelectSession(item.id)}
                  >
                    {item.title}
                  </button>
                  <div className="session-actions">
                    <button type="button" onClick={() => handleRenameSession(item.id)}>
                      重命名
                    </button>
                    <button type="button" onClick={() => void handleDeleteSession(item.id)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" className="secondary-btn" onClick={() => void handleClearChat()}>
              清空当前对话
            </button>
          </aside>
        </div>
      )}

      <InfoPanel
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        settings={settings}
        session={session}
        lastUsage={lastUsage}
        balanceLines={balanceLines}
        balanceError={balanceError}
        balanceLoading={balanceLoading}
        onRefreshBalance={() => void refreshBalance(settings)}
      />

      <RenameDialog
        open={renameOpen}
        title={sessions.find((s) => s.id === renameId)?.title ?? "新对话"}
        onClose={() => setRenameOpen(false)}
        onConfirm={(title) => void confirmRename(title)}
      />

      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={(next) => void persistSettings(next)}
      />
    </div>
  );
}
