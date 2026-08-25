import React, { useState, useEffect, useRef } from 'react';
import { useBrowserStore } from '../store/browserStore';
import { listen, Event as TauriEvent } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Sparkles, Bug, X, Settings as SettingsIcon } from 'lucide-react';
import { getActiveProvider, getApiKey } from '../services/ai';
import { dbGetChatHistory, dbAddChatMessage, dbClearChatHistory } from '../services/db';
import { Message, AgentStepItem, AgentMessageData } from '../types';
import { runAgentLoop, cancelActiveAgentRun } from '../services/agent/agentLoop';
import { runAutoQuizSolver, cancelActiveQuizRun } from '../services/agent/quizSolver';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

// Sub-components
import { SidePanelChat } from './sidepanel/SidePanelChat';
import { AgentDebug } from './sidepanel/AgentDebug';

export function detectUserIntent(query: string): { 
  type: 'agent' | 'intel' | 'chat' | 'quiz'; 
  goal?: string; 
  intelMode?: 'summarize' | 'translate' | 'facts'; 
  targetLang?: string; 
} {
  const lower = query.trim().toLowerCase();

  // 0. Dedicated Quiz & Assessment Auto-Solver Intent
  if (
    lower.includes('solve quiz') ||
    lower.includes('auto solve') ||
    lower.includes('solve test') ||
    lower.includes('solve assessment') ||
    lower.includes('answer all questions') ||
    lower.includes('answer questions') ||
    lower.includes('solve questions') ||
    lower.includes('solve mcq') ||
    lower.includes('solve mcqs') ||
    lower.includes('/quiz') ||
    lower.includes('/solve')
  ) {
    return { type: 'quiz', goal: query.trim() };
  }

  // 1. Page Intelligence Intent
  if (
    lower.startsWith('summarize') || 
    lower.startsWith('summary') || 
    lower === 'tldr' || 
    lower.includes('summarize this page') || 
    lower.includes('give me a summary')
  ) {
    return { type: 'intel', intelMode: 'summarize' };
  }

  if (
    lower.includes('key points') || 
    lower.includes('key facts') || 
    lower.includes('main takeaways') || 
    lower.includes('extract facts') ||
    lower.includes('bullet points')
  ) {
    return { type: 'intel', intelMode: 'facts' };
  }

  if (lower.includes('translate')) {
    const langMatch = query.match(/translate\s+(?:this\s+page\s+)?(?:to\s+|into\s+)?([A-Za-z]+)/i);
    const targetLang = langMatch ? langMatch[1] : 'Spanish';
    return { type: 'intel', intelMode: 'translate', targetLang };
  }

  // 2. Direct URL or Domain presence is an agent navigation/task
  if (/https?:\/\/|[a-zA-Z0-9.-]+\.(?:com|org|net|in|io|ai|app|edu|gov|co|dev|me|site|xyz)/i.test(query)) {
    return { type: 'agent', goal: query.trim() };
  }

  // 3. Browser Action / Task / Automation Intent
  const actionKeywords = [
    'click', 'type', 'search', 'navigate', 'go to', 'fill out', 'fill',
    'press', 'scroll', 'open', 'buy', 'order', 'book', 'login', 'log in',
    'sign in', 'signin', 'signup', 'sign up', 'register', 'submit', 'find on page',
    'find', 'select', 'choose', 'pick', 'answer', 'solve', 'complete',
    'take', 'do', 'mcq', 'mcqs', 'quiz', 'test', 'exam', 'question', 'questions',
    'form', 'survey', 'play', 'watch', 'listen', 'stream', 'download',
    'visit', 'close tab', 'refresh', 'reload', 'enter', 'check', 'uncheck',
    'toggle', 'help me', 'can you', 'please', 'browse', 'start'
  ];

  const isAction = actionKeywords.some(keyword => lower.includes(keyword));
  if (isAction) {
    return { type: 'agent', goal: query.trim() };
  }

  // 4. Q&A / General Conversation
  return { type: 'chat' };
}

export const SidePanel: React.FC = () => {
  const {
    activeTabId,
    settings,
    sidebarOpen,
    setSidebarOpen,
    navigateActiveTab,
    addTab,
    setActiveTabId
  } = useBrowserStore();

  // Single Chat Stream State
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showDebugDrawer, setShowDebugDrawer] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Agent Developer Debug Panel State
  const [debugRawLlm, setDebugRawLlm] = useState('');
  const [debugParsedJson, setDebugParsedJson] = useState<any>(null);
  const [debugErrors, setDebugErrors] = useState<string[]>([]);

  // Refs for task cancellation and pause states by message ID
  const agentCancelRef = useRef<Record<string, boolean>>({});
  const agentPausedRef = useRef<Record<string, boolean>>({});

  // Load chat history when active tab changes
  useEffect(() => {
    if (activeTabId) {
      dbGetChatHistory(activeTabId).then(history => {
        const loadedMessages: Message[] = history.map(msg => {
          if (msg.content.startsWith('__AGENT_DATA__:')) {
            try {
              const data = JSON.parse(msg.content.substring('__AGENT_DATA__:'.length));
              return {
                ...msg,
                messageType: 'agent' as const,
                agentData: data
              };
            } catch (e) {}
          }
          return {
            ...msg,
            messageType: 'chat' as const
          };
        });
        setMessages(loadedMessages);
      });
    }
  }, [activeTabId]);

  // Listen for global "Ask AI" event from Omnibox
  useEffect(() => {
    const handleAskAiEvent = async (e: Event) => {
      const queryText = (e as CustomEvent).detail;
      if (queryText) {
        await handleSendMessage(queryText);
      }
    };
    window.addEventListener('aria-ask-ai', handleAskAiEvent);
    return () => window.removeEventListener('aria-ask-ai', handleAskAiEvent);
  }, [activeTabId, isGenerating, isAgentRunning]);

  // Syntax highlighting for markdown code blocks
  useEffect(() => {
    document.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
  }, [messages, showDebugDrawer]);

  // Helper: Extract text from active webview
  const extractPageContent = (): Promise<string> => {
    return new Promise(async (resolve, reject) => {
      if (!activeTabId) return resolve('');
      
      const eventName = `page-content-tab-${activeTabId}`;
      let unlisten: (() => void) | null = null;
      
      const timeout = setTimeout(() => {
        if (unlisten) unlisten();
        resolve(''); // Fallback to empty if timeout
      }, 5000);

      unlisten = await listen<string>(eventName, (event: TauriEvent<string>) => {
        clearTimeout(timeout);
        if (unlisten) unlisten();
        resolve(event.payload);
      });

      try {
        await invoke('extract_page_text', { webviewLabel: `tab-${activeTabId}` });
      } catch (e) {
        clearTimeout(timeout);
        if (unlisten) unlisten();
        reject(e);
      }
    });
  };







  // Autonomous Agent Loop embedded in single chat interface
  const runAgentForMessage = async (msgId: string, goal: string) => {
    if (!activeTabId || !goal.trim()) return;

    cancelActiveAgentRun();
    setIsAgentRunning(true);
    agentCancelRef.current[msgId] = false;
    agentPausedRef.current[msgId] = false;

    let timeline: AgentStepItem[] = [];
    let logs: string[] = [];

    const updateMessageState = (updates: Partial<AgentMessageData>) => {
      setMessages(prev => prev.map(m => {
        if (m.id !== msgId || !m.agentData) return m;
        return {
          ...m,
          agentData: {
            ...m.agentData,
            ...updates
          }
        };
      }));
    };

    try {
      await runAgentLoop(
        goal,
        activeTabId,
        settings,
        {
          onStatusUpdate: (status, currentStep) => {
            updateMessageState({ status, currentStep, running: true });
          },
          onTimelineUpdate: (item) => {
            const existingIdx = timeline.findIndex(it => it.id === item.id);
            if (existingIdx >= 0) {
              timeline[existingIdx] = item;
            } else {
              timeline = [...timeline, item];
            }
            updateMessageState({ timeline: [...timeline] });
          },
          onLog: (logStr) => {
            logs = [...logs, logStr];
            updateMessageState({ logs: [...logs] });
          },
          onDebugData: (rawLlm, parsedJson) => {
            setDebugRawLlm(rawLlm);
            setDebugParsedJson(parsedJson);
          },
          onFinish: async (result, success) => {
            updateMessageState({
              running: false,
              status: success ? 'Completed' : 'Finished',
              result: result
            });
            setIsAgentRunning(false);

            // Save final message state to DB
            setMessages(currentMessages => {
              const finalMsg = currentMessages.find(m => m.id === msgId);
              if (finalMsg && finalMsg.agentData) {
                const serializedContent = '__AGENT_DATA__:' + JSON.stringify(finalMsg.agentData);
                dbAddChatMessage({
                  tab_id: activeTabId,
                  role: 'assistant',
                  content: serializedContent,
                  provider: settings.aiProvider,
                  model: settings.aiModel || ''
                });
              }
              return currentMessages;
            });
          },
          isCancelled: () => !!agentCancelRef.current[msgId],
          isPaused: () => !!agentPausedRef.current[msgId],
          navigateActiveTab,
          addTab,
          setActiveTabId,
          getTabs: () => useBrowserStore.getState().tabs,
          getActiveTabId: () => useBrowserStore.getState().activeTabId
        }
      );
    } catch (err: any) {
      console.error('[AGENT TRACE] ERROR in runAgentForMessage:', err);
      updateMessageState({
        running: false,
        status: `Error: ${err.message || String(err)}`
      });
    } finally {
      setIsAgentRunning(false);
    }
  };

  // Dedicated Quiz & Assessment Solver Runner
  const runQuizSolverForMessage = async (msgId: string, _goal?: string) => {
    if (!activeTabId) return;

    cancelActiveQuizRun();
    cancelActiveAgentRun();
    setIsAgentRunning(true);
    agentCancelRef.current[msgId] = false;
    agentPausedRef.current[msgId] = false;

    let timeline: AgentStepItem[] = [];
    let logs: string[] = [];

    const updateMessageState = (updates: Partial<AgentMessageData>) => {
      setMessages(prev => prev.map(m => {
        if (m.id !== msgId || !m.agentData) return m;
        return {
          ...m,
          agentData: {
            ...m.agentData,
            ...updates
          }
        };
      }));
    };

    try {
      await runAutoQuizSolver(
        activeTabId,
        settings,
        {
          onStatusUpdate: (status, currentStep) => {
            updateMessageState({ status, currentStep, running: true });
          },
          onTimelineUpdate: (item) => {
            const existingIdx = timeline.findIndex(it => it.id === item.id);
            if (existingIdx >= 0) {
              timeline[existingIdx] = item;
            } else {
              timeline = [...timeline, item];
            }
            updateMessageState({ timeline: [...timeline] });
          },
          onLog: (logStr) => {
            logs = [...logs, logStr];
            updateMessageState({ logs: [...logs] });
          },
          onFinish: async (result, success) => {
            updateMessageState({
              running: false,
              status: success ? 'Completed' : 'Finished',
              result: result
            });
            setIsAgentRunning(false);

            setMessages(currentMessages => {
              const finalMsg = currentMessages.find(m => m.id === msgId);
              if (finalMsg && finalMsg.agentData) {
                const serializedContent = '__AGENT_DATA__:' + JSON.stringify(finalMsg.agentData);
                dbAddChatMessage({
                  tab_id: activeTabId,
                  role: 'assistant',
                  content: serializedContent,
                  provider: settings.aiProvider,
                  model: settings.aiModel || ''
                });
              }
              return currentMessages;
            });
          },
          isCancelled: () => !!agentCancelRef.current[msgId],
          isPaused: () => !!agentPausedRef.current[msgId]
        }
      );
    } catch (err: any) {
      console.error('[QUIZ TRACE] ERROR in runQuizSolverForMessage:', err);
      updateMessageState({
        running: false,
        status: `Error: ${err.message || String(err)}`
      });
    } finally {
      setIsAgentRunning(false);
    }
  };

  const pauseAgent = (msgId: string) => {
    agentPausedRef.current[msgId] = true;
    setMessages(prev => prev.map(m => m.id === msgId && m.agentData ? {
      ...m,
      agentData: { ...m.agentData, paused: true, status: 'Paused by user' }
    } : m));
  };

  const resumeAgent = (msgId: string) => {
    agentPausedRef.current[msgId] = false;
    setMessages(prev => prev.map(m => m.id === msgId && m.agentData ? {
      ...m,
      agentData: { ...m.agentData, paused: false, status: 'Resuming...' }
    } : m));
  };

  const stopAgent = (msgId: string) => {
    cancelActiveAgentRun();
    cancelActiveQuizRun();
    agentCancelRef.current[msgId] = true;
    setIsAgentRunning(false);
    setMessages(prev => prev.map(m => m.id === msgId && m.agentData ? {
      ...m,
      agentData: { ...m.agentData, running: false, status: 'Aborted by user' }
    } : m));
  };

  // Single Unified Submission Handler
  const handleSendMessage = async (textToSend?: string) => {
    const text = (textToSend || inputValue).trim();
    console.log('[AGENT TRACE] INPUT_RECEIVED', { text, activeTabId, isGenerating, isAgentRunning });

    if (!text) return;
    if (!textToSend) setInputValue('');

    if (!activeTabId) {
      console.warn('[AGENT TRACE] SUBMIT_HANDLER cancelled: activeTabId is null');
      return;
    }

    if (isGenerating || isAgentRunning) {
      console.log('[AGENT TRACE] Cancelling previous agent run to execute new request');
      cancelActiveAgentRun();
      cancelActiveQuizRun();
      setIsAgentRunning(false);
      setIsGenerating(false);
    }

    // Add user message to state & DB
    const userMsg = await dbAddChatMessage({
      tab_id: activeTabId,
      role: 'user',
      content: text,
      provider: settings.aiProvider,
      model: settings.aiModel || ''
    });
    setMessages(prev => [...prev, userMsg]);

    // Parse Intent: Agent action vs Intelligence vs Chat Q&A vs Quiz
    const intent = detectUserIntent(text);
    console.log('[AGENT TRACE] SUBMIT_HANDLER', { type: intent.type, goal: intent.goal || text });

    if (intent.type === 'quiz') {
      // 0. Dedicated Quiz & Assessment Solver Task
      const assistantMsgId = crypto.randomUUID();
      console.log('[QUIZ TRACE] QUIZ_TASK_CREATED', { msgId: assistantMsgId, goal: intent.goal || text });

      const initialAgentData: AgentMessageData = {
        goal: 'Auto Solve Assessment / Quiz',
        status: 'Starting Quiz Auto-Solver...',
        running: true,
        paused: false,
        currentStep: 0,
        timeline: [],
        logs: []
      };

      const agentMsg: Message = {
        id: assistantMsgId,
        tab_id: activeTabId,
        role: 'assistant',
        content: text,
        provider: settings.aiProvider,
        model: settings.aiModel || '',
        created_at: Date.now(),
        messageType: 'agent',
        agentData: initialAgentData
      };

      setMessages(prev => [...prev, agentMsg]);
      runQuizSolverForMessage(assistantMsgId, intent.goal || text);
    } else if (intent.type === 'agent') {
      // 1. Web Automation Agent Task
      const assistantMsgId = crypto.randomUUID();
      console.log('[AGENT TRACE] TASK_CREATED', { msgId: assistantMsgId, goal: intent.goal || text });

      const initialAgentData: AgentMessageData = {
        goal: intent.goal || text,
        status: 'Initializing browser agent...',
        running: true,
        paused: false,
        currentStep: 0,
        timeline: [],
        logs: []
      };

      const agentMsg: Message = {
        id: assistantMsgId,
        tab_id: activeTabId,
        role: 'assistant',
        content: text,
        provider: settings.aiProvider,
        model: settings.aiModel || '',
        created_at: Date.now(),
        messageType: 'agent',
        agentData: initialAgentData
      };

      setMessages(prev => [...prev, agentMsg]);
      runAgentForMessage(assistantMsgId, intent.goal || text);
    } else if (intent.type === 'intel') {
      // 2. Page Intelligence Task
      setIsGenerating(true);
      const tempAssistantId = crypto.randomUUID();
      setMessages(prev => [...prev, {
        id: tempAssistantId,
        tab_id: activeTabId,
        role: 'assistant',
        content: '',
        provider: settings.aiProvider,
        model: settings.aiModel || '',
        created_at: Date.now(),
        messageType: 'intel'
      }]);

      let streamText = '';
      try {
        const pageText = await extractPageContent();
        const provider = await getActiveProvider(settings.aiProvider);
        if (!provider) throw new Error('No AI provider configured');
        const key = await getApiKey(settings.aiProvider);

        let systemInstruction = 'You are Aria AI. Perform page analysis.';
        let userInstruction = `${intent.intelMode?.toUpperCase()} this page text:\n\n${pageText.slice(0, 6000)}`;

        if (intent.intelMode === 'translate') {
          systemInstruction = `You are a translator. Translate the text into ${intent.targetLang || 'Spanish'}.`;
        } else if (intent.intelMode === 'facts') {
          systemInstruction = 'Extract key facts and bullet points from the page text.';
        } else if (intent.intelMode === 'summarize') {
          systemInstruction = 'Provide a clean, comprehensive summary of the page.';
        }

        const stream = provider.chat([
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userInstruction }
        ], { model: settings.aiModel || '', apiKey: key || undefined });

        for await (const chunk of stream) {
          streamText += chunk;
          setMessages(prev => prev.map(m => m.id === tempAssistantId ? { ...m, content: streamText } : m));
        }

        const assistantMsg = await dbAddChatMessage({
          tab_id: activeTabId,
          role: 'assistant',
          content: streamText,
          provider: settings.aiProvider,
          model: settings.aiModel || ''
        });
        setMessages(prev => prev.filter(m => m.id !== tempAssistantId).concat({ ...assistantMsg, messageType: 'intel' }));
      } catch (e: any) {
        setMessages(prev => prev.map(m => m.id === tempAssistantId ? { ...m, content: 'Error: ' + e.message } : m));
      } finally {
        setIsGenerating(false);
      }
    } else {
      // 3. General Q&A Chat
      setIsGenerating(true);
      const tempAssistantId = crypto.randomUUID();
      setMessages(prev => [...prev, {
        id: tempAssistantId,
        tab_id: activeTabId,
        role: 'assistant',
        content: '',
        provider: settings.aiProvider,
        model: settings.aiModel || '',
        created_at: Date.now(),
        messageType: 'chat'
      }]);

      let streamText = '';
      try {
        const provider = await getActiveProvider(settings.aiProvider);
        if (!provider) throw new Error('No AI provider configured');
        const key = await getApiKey(settings.aiProvider);
        const pageText = await extractPageContent();

        const stream = provider.chat([
          { role: 'system', content: `You are Aria Browser AI Assistant, an integrated AI assistant inside an AI-powered web browser. You assist the user with web browsing, research, page analysis, and answering questions directly and helpfully.\n\nCurrent Page Context:\n${pageText.slice(0, 3000)}` },
          ...messages.filter(m => m.messageType !== 'agent').map(m => ({ role: m.role, content: m.content })),
          { role: 'user', content: text }
        ], { model: settings.aiModel || '', apiKey: key || undefined });

        for await (const chunk of stream) {
          streamText += chunk;
          setMessages(prev => prev.map(m => m.id === tempAssistantId ? { ...m, content: streamText } : m));
        }

        const assistantMsg = await dbAddChatMessage({
          tab_id: activeTabId,
          role: 'assistant',
          content: streamText,
          provider: settings.aiProvider,
          model: settings.aiModel || ''
        });
        setMessages(prev => prev.filter(m => m.id !== tempAssistantId).concat({ ...assistantMsg, messageType: 'chat' }));
      } catch (e: any) {
        setMessages(prev => prev.map(m => m.id === tempAssistantId ? { ...m, content: 'Error: ' + e.message } : m));
      } finally {
        setIsGenerating(false);
      }
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleClearHistory = async () => {
    if (activeTabId && confirm('Clear chat history?')) {
      await dbClearChatHistory(activeTabId);
      setMessages([]);
    }
  };

  if (!sidebarOpen) return null;

  return (
    <div className="flex flex-col h-full w-[360px] min-w-[360px] border-l border-slate-800 bg-[#0b0f19] select-none text-slate-200 shadow-2xl">
      {/* Unified Sidebar Header */}
      <div className="flex items-center justify-between px-3.5 py-3 border-b border-slate-800 bg-[#0f172a]">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 shadow-md">
            <Sparkles size={14} className="text-white animate-pulse" />
          </div>
          <div>
            <h2 className="font-semibold text-xs text-white leading-none">Aria Assistant</h2>
            <span className="text-[9px] text-slate-400 font-mono">
              {settings.aiProvider} ({settings.aiModel || 'default'})
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/* Settings Button */}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('aria-open-settings'))}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-all cursor-pointer"
            title="Settings"
          >
            <SettingsIcon size={14} />
          </button>

          {/* Debug Toggle Icon */}
          <button
            onClick={() => setShowDebugDrawer(!showDebugDrawer)}
            className={`p-1.5 rounded-lg text-xs transition-all cursor-pointer ${
              showDebugDrawer ? 'bg-purple-900/50 text-purple-300 border border-purple-700/50' : 'text-slate-400 hover:bg-slate-800'
            }`}
            title="Toggle Developer Debug Console"
          >
            <Bug size={14} />
          </button>

          {/* Close Sidebar */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-all cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Developer Debug Panel Drawer (Collapsible) */}
      {showDebugDrawer && (
        <div className="border-b border-slate-800 bg-slate-950 p-2 max-h-56 overflow-y-auto">
          <AgentDebug
            validation={null}
            execution={''}
            errors={debugErrors}
            parsedJson={debugParsedJson}
            cleanedResponse={''}
            rawLlmResponse={debugRawLlm}
            onClear={() => {
              setDebugRawLlm('');
              setDebugParsedJson(null);
              setDebugErrors([]);
            }}
          />
        </div>
      )}

      {/* Single Unified Chat Stream Component */}
      <div className="flex-1 overflow-hidden p-3 flex flex-col min-h-0">
        <SidePanelChat
          messages={messages}
          inputValue={inputValue}
          setInputValue={setInputValue}
          isGenerating={isGenerating}
          isAgentRunning={isAgentRunning}
          onSendMessage={handleSendMessage}
          onPauseAgent={pauseAgent}
          onResumeAgent={resumeAgent}
          onStopAgent={stopAgent}
          onClearHistory={handleClearHistory}
          onCopyMessage={handleCopy}
          copiedId={copiedId}
          messagesEndRef={messagesEndRef}
          providerName={settings.aiProvider}
        />
      </div>
    </div>
  );
};
