import React, { useState, useEffect, useRef } from 'react';
import { useBrowserStore } from '../store/browserStore';
import { listen, Event as TauriEvent } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Sparkles, Bug, X } from 'lucide-react';
import { getActiveProvider, getApiKey } from '../services/ai';
import { normalizeAgentUrl } from '../services/agent';
import { dbGetChatHistory, dbAddChatMessage, dbClearChatHistory } from '../services/db';
import { Message, AgentStepItem, AgentMessageData } from '../types';
import { extractJsonFromText } from '../services/utils';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

// Sub-components
import { SidePanelChat } from './sidepanel/SidePanelChat';
import { AgentDebug } from './sidepanel/AgentDebug';

export function detectUserIntent(query: string): { 
  type: 'agent' | 'intel' | 'chat'; 
  goal?: string; 
  intelMode?: 'summarize' | 'translate' | 'facts'; 
  targetLang?: string; 
} {
  const lower = query.trim().toLowerCase();

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

  // 2. Browser Action / Automation Intent
  const actionKeywords = [
    'click', 'type', 'search for', 'search ', 'navigate', 'go to', 'fill out',
    'fill ', 'press', 'scroll', 'open ', 'buy ', 'order ', 'book ', 'login',
    'sign in', 'submit', 'find on page', 'select'
  ];

  const isAction = actionKeywords.some(keyword => lower.includes(keyword));
  if (isAction) {
    return { type: 'agent', goal: query.trim() };
  }

  // 3. Q&A / Conversation Intent
  return { type: 'chat' };
}

export const SidePanel: React.FC = () => {
  const {
    activeTabId,
    tabs,
    settings,
    sidebarOpen,
    setSidebarOpen,
    navigateActiveTab
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

  const scanPageDOM = (tabId: string): Promise<any> => {
    return new Promise(async (resolve, reject) => {
      const eventName = `page-content-tab-${tabId}`;
      let unlisten: (() => void) | null = null;
      
      const timeout = setTimeout(() => {
        if (unlisten) unlisten();
        reject(new Error('DOM scan timed out'));
      }, 8000);

      unlisten = await listen<string>(eventName, (event: TauriEvent<string>) => {
        if (event.payload.startsWith('AGENT_DOM_SCAN:')) {
          clearTimeout(timeout);
          if (unlisten) unlisten();
          try {
            const data = JSON.parse(event.payload.substring('AGENT_DOM_SCAN:'.length));
            resolve(data);
          } catch (e) {
            reject(e);
          }
        } else if (event.payload.startsWith('AGENT_DOM_ERROR:')) {
          clearTimeout(timeout);
          if (unlisten) unlisten();
          reject(new Error(event.payload.substring('AGENT_DOM_ERROR:'.length)));
        }
      });

      try {
        try {
          await injectHelpers(tabId);
        } catch (e) {}

        const js = `
          (function() {
            try {
              document.querySelectorAll('[data-agent-id]').forEach(el => el.removeAttribute('data-agent-id'));
              const interactiveSelectors = ['a', 'button', 'input', 'select', 'textarea', '[role="button"]', '[role="link"]', '[contenteditable="true"]'];
              const elements = document.querySelectorAll(interactiveSelectors.join(','));
              const items = [];
              let idCounter = 0;
              elements.forEach(el => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                if (rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
                const agentId = 'agent-' + idCounter++;
                el.setAttribute('data-agent-id', agentId);
                let text = '';
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                  text = el.placeholder || el.value || el.getAttribute('aria-label') || '';
                } else {
                  text = el.innerText || el.textContent || el.getAttribute('aria-label') || '';
                  text = text.trim().replace(/\\s+/g, ' ').slice(0, 100);
                }
                items.push({
                  id: agentId,
                  tagName: el.tagName,
                  role: el.getAttribute('role') || el.tagName.toLowerCase(),
                  text: text,
                  placeholder: el.placeholder || '',
                  type: el.type || ''
                });
              });
              const pageText = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 12000);
              const pageInfo = { title: document.title, url: window.location.href, pageText: pageText, elements: items.slice(0, 150) };
              const successText = 'AGENT_DOM_SCAN:' + JSON.stringify(pageInfo);
              window.location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent(successText);
            } catch(e) {
              const errorText = 'AGENT_DOM_ERROR:' + e.toString();
              window.location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent(errorText);
            }
          })()
        `;
        await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: js });
      } catch (e) {
        clearTimeout(timeout);
        if (unlisten) unlisten();
        reject(e);
      }
    });
  };

  const runInjectedAction = (tabId: string, actionJs: string): Promise<any> => {
    return new Promise(async (resolve, reject) => {
      const eventName = `page-content-tab-${tabId}`;
      let unlisten: (() => void) | null = null;
      
      const timeout = setTimeout(() => {
        if (unlisten) unlisten();
        reject(new Error('Action execution timed out'));
      }, 12000);

      unlisten = await listen<string>(eventName, (event: TauriEvent<string>) => {
        if (event.payload.startsWith('AGENT_ACTION_RESULT:')) {
          clearTimeout(timeout);
          if (unlisten) unlisten();
          try {
            const data = JSON.parse(event.payload.substring('AGENT_ACTION_RESULT:'.length));
            resolve(data);
          } catch (e) {
            reject(e);
          }
        }
      });

      try {
        await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: actionJs });
      } catch (e) {
        clearTimeout(timeout);
        if (unlisten) unlisten();
        reject(e);
      }
    });
  };

  const updateWebviewHud = async (
    tabId: string,
    overrides?: {
      task?: string;
      step?: number;
      url?: string;
      status?: string;
      currentAction?: string;
      nextAction?: string;
      running?: boolean;
      paused?: boolean;
    }
  ) => {
    if (!tabId) return;
    const activeTabObj = tabs.find(t => t.id === tabId);
    const payload = {
      task: overrides?.task || 'Browser Agent Task',
      step: overrides?.step || 0,
      url: overrides?.url || (activeTabObj?.url || ''),
      status: overrides?.status || '',
      currentAction: overrides?.currentAction || '',
      nextAction: overrides?.nextAction || '',
      running: overrides?.running !== undefined ? overrides.running : false,
      paused: overrides?.paused !== undefined ? overrides.paused : false
    };
    const js = `
      if (window.__updateAgentHud) {
        window.__updateAgentHud(${JSON.stringify(payload)});
      }
    `;
    try {
      await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js });
    } catch (e) {}
  };

  const injectHelpers = async (tabId: string): Promise<void> => {
    const helpersJs = `
      (function() {
        if (window.__agent_helper_injected) return;
        window.__agent_helper_injected = true;

        window.addEventListener('beforeunload', function() {
          if (window.__agent_unloading) return;
          window.__agent_unloading = true;
          try {
            var payload = 'AGENT_ACTION_RESULT:' + JSON.stringify({ success: true, navigating: true });
            window.location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent(payload);
          } catch(e) {}
        });

        window.__getOverlayRoot = function() {
          let overlay = document.getElementById('__agent_overlay_root__');
          if (!overlay || !document.body || !document.body.contains(overlay)) {
            if (overlay) {
              try { overlay.remove(); } catch(e) {}
            }
            if (!document.body) return null;
            overlay = document.createElement('div');
            overlay.id = '__agent_overlay_root__';
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;box-sizing:border-box;';
            document.body.appendChild(overlay);
          }
          return overlay;
        };

        window.__getCursor = function() {
          const overlay = window.__getOverlayRoot();
          if (!overlay) return null;
          let cursor = document.getElementById('__agent_cursor__');
          if (!cursor || !overlay.contains(cursor)) {
            if (cursor) {
              try { cursor.remove(); } catch(e) {}
            }
            cursor = document.createElement('div');
            cursor.id = '__agent_cursor__';
            cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="filter: drop-shadow(0 2px 5px rgba(0,0,0,0.3))"><path d="M4.5 3V19L9.2 14.3L14.7 21L17.7 18.5L12.3 12L18 12L4.5 3Z" fill="white" stroke="#a855f7" stroke-width="2" stroke-linejoin="round"/></svg>';
            cursor.style.cssText = 'position:fixed;top:100px;left:100px;width:24px;height:24px;transition:none;z-index:2147483647;pointer-events:none;';
            overlay.appendChild(cursor);
          }
          return cursor;
        };

        const rootOverlay = window.__getOverlayRoot();
        const cursor = window.__getCursor();
        if (window.__agent_cursor_x === undefined) {
          window.__agent_cursor_x = window.innerWidth / 2;
          window.__agent_cursor_y = window.innerHeight / 2;
          if (cursor) {
            cursor.style.left = window.__agent_cursor_x + 'px';
            cursor.style.top = window.__agent_cursor_y + 'px';
          }
        }

        window.__agent_post_result = function(payloadObj) {
          var payloadStr = 'AGENT_ACTION_RESULT:' + JSON.stringify(payloadObj);
          try {
            window.location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent(payloadStr);
          } catch(e) {}
        };

        window.__animateCursorTo = function(targetX, targetY, duration, callback) {
          const cursor = window.__getCursor();
          if (!cursor) { callback(); return; }
          const startX = window.__agent_cursor_x;
          const startY = window.__agent_cursor_y;
          const startTime = performance.now();

          function step(now) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const t = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;
            const currentX = startX + (targetX - startX) * t;
            const currentY = startY + (targetY - startY) * t;

            cursor.style.left = currentX + 'px';
            cursor.style.top = currentY + 'px';
            window.__agent_cursor_x = currentX;
            window.__agent_cursor_y = currentY;

            if (progress < 1) {
              requestAnimationFrame(step);
            } else {
              callback();
            }
          }
          requestAnimationFrame(step);
        };

        window.__agentClick = function(elementId, callback) {
          const el = document.querySelector('[data-agent-id="' + elementId + '"]');
          if (!el) { callback(false, "Element not found: " + elementId); return; }
          el.scrollIntoView({ behavior: "smooth", block: "center" });

          setTimeout(function() {
            const rect = el.getBoundingClientRect();
            const targetX = rect.left + rect.width / 2;
            const targetY = rect.top + rect.height / 2;

            window.__animateCursorTo(targetX, targetY, 600, function() {
              const root = window.__getOverlayRoot();
              if (!root) { el.click(); callback(true); return; }

              const ripple = document.createElement("div");
              ripple.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border-radius:50%;background:rgba(168,85,247,0.4);border:2px solid #a855f7;width:10px;height:10px;left:" + targetX + "px;top:" + targetY + "px;transform:translate(-50%,-50%);transition:all 0.5s ease-out;";
              root.appendChild(ripple);
              
              const highlight = document.createElement("div");
              highlight.style.cssText = "position:fixed;pointer-events:none;z-index:2147483645;border:3px solid #a855f7;border-radius:6px;box-shadow:0 0 15px rgba(168,85,247,0.5);left:" + (rect.left - 4) + "px;top:" + (rect.top - 4) + "px;width:" + (rect.width + 8) + "px;height:" + (rect.height + 8) + "px;";
              root.appendChild(highlight);

              const infoLabel = document.createElement("div");
              infoLabel.textContent = "🖱️ Click: " + elementId;
              const labelTop = rect.top - 35 < 10 ? rect.bottom + 10 : rect.top - 35;
              infoLabel.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;left:" + targetX + "px;top:" + labelTop + "px;transform:translateX(-50%);background:linear-gradient(135deg,#a855f7,#7e22ce);color:white;font:bold 11px system-ui;padding:4px 10px;border-radius:8px;box-shadow:0 4px 10px rgba(168,85,247,0.3);white-space:nowrap;";
              root.appendChild(infoLabel);

              requestAnimationFrame(function() {
                ripple.style.width = "60px";
                ripple.style.height = "60px";
                ripple.style.opacity = "0";
              });

              setTimeout(function() {
                try { ripple.remove(); } catch(e) {}
                try { highlight.remove(); } catch(e) {}
                try { infoLabel.remove(); } catch(e) {}
              }, 1200);

              setTimeout(function() {
                if (window.__agent_unloading) return;
                el.click();
                callback(true);
              }, 250);
            });
          }, 400);
        };

        window.__agentType = function(elementId, text, callback) {
          const el = document.querySelector('[data-agent-id="' + elementId + '"]');
          if (!el) { callback(false, "Element not found: " + elementId); return; }
          el.scrollIntoView({ behavior: "smooth", block: "center" });

          setTimeout(function() {
            const rect = el.getBoundingClientRect();
            const targetX = rect.left + 15;
            const targetY = rect.top + rect.height / 2;

            window.__animateCursorTo(targetX, targetY, 600, function() {
              const root = window.__getOverlayRoot();
              if (!root) {
                el.focus(); el.value = text;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                callback(true);
                return;
              }

              const highlight = document.createElement("div");
              highlight.style.cssText = "position:fixed;pointer-events:none;z-index:2147483645;border:3px solid #3b82f6;border-radius:6px;box-shadow:0 0 15px rgba(59,130,246,0.5);left:" + (rect.left - 4) + "px;top:" + (rect.top - 4) + "px;width:" + (rect.width + 8) + "px;height:" + (rect.height + 8) + "px;";
              root.appendChild(highlight);

              const infoLabel = document.createElement("div");
              infoLabel.textContent = "⌨️ Typing...";
              const labelTop = rect.top - 35 < 10 ? rect.bottom + 10 : rect.top - 35;
              infoLabel.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;left:" + (rect.left + rect.width / 2) + "px;top:" + labelTop + "px;transform:translateX(-50%);background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:white;font:bold 11px system-ui;padding:4px 10px;border-radius:8px;box-shadow:0 4px 10px rgba(59,130,246,0.3);white-space:nowrap;";
              root.appendChild(infoLabel);

              el.focus();
              let currentVal = "";
              let charIdx = 0;

              function typeChar() {
                if (window.__agent_unloading) return;
                if (charIdx < text.length) {
                  currentVal += text[charIdx];
                  el.value = currentVal;
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  infoLabel.textContent = '⌨️ Typing: "' + currentVal + '"';
                  charIdx++;
                  setTimeout(typeChar, 80);
                } else {
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                  setTimeout(function() {
                    try { highlight.remove(); } catch(e) {}
                    try { infoLabel.remove(); } catch(e) {}
                    callback(true);
                  }, 400);
                }
              }
              typeChar();
            });
          }, 400);
        };

        window.__updateAgentHud = function(data) {
          const overlay = window.__getOverlayRoot();
          if (!overlay) return;
          let hud = document.getElementById('__agent_hud__');
          if (!hud) {
            hud = document.createElement('div');
            hud.id = '__agent_hud__';
            hud.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(15,23,42,0.9);backdrop-filter:blur(8px);border:1px solid rgba(168,85,247,0.4);border-radius:12px;padding:10px 20px;color:white;font-size:12px;display:flex;flex-direction:column;gap:5px;box-shadow:0 10px 25px rgba(0,0,0,0.5);pointer-events:none;min-width:300px;z-index:2147483647;';
            overlay.appendChild(hud);
          }
          const statusColor = data.running ? (data.paused ? '#f59e0b' : '#10b981') : '#64748b';
          hud.innerHTML = \`
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
              <div style="display:flex;align-items:center;gap:8px;">
                <div style="width:8px;height:8px;border-radius:50%;background:\${statusColor};"></div>
                <span style="font-weight:bold;text-transform:uppercase;letter-spacing:1px;font-size:10px;">
                  \${data.running ? (data.paused ? 'Paused' : 'Active') : 'Idle'}
                </span>
              </div>
              <span style="margin-left:auto;font-family:monospace;font-size:10px;opacity:0.6;">Step \${data.step}</span>
            </div>
            <div style="font-size:13px;font-weight:500;color:#e2e8f0;margin-top:2px;">\${data.task}</div>
            <div style="font-size:10px;color:#94a3b8;border-top:1px solid rgba(255,255,255,0.1);padding-top:5px;margin-top:2px;">\${data.status}</div>
          \`;
        };
      })();
    `;
    try {
      await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: helpersJs });
      await updateWebviewHud(tabId);
    } catch (e) {
      console.error('Failed to inject agent helpers', e);
    }
  };

  const cleanupHelpers = async (tabId: string) => {
    const cleanupJs = `
      (function() {
        const root = document.getElementById('__agent_overlay_root__');
        if (root) root.remove();
        window.__agent_helper_injected = false;
      })();
    `;
    try {
      await invoke('eval_tab_webview', { webviewLabel: `tab-${tabId}`, js: cleanupJs });
    } catch(e) {}
  };

  const executeClick = async (tabId: string, elementId: string): Promise<void> => {
    await injectHelpers(tabId);
    const js = `window.__agentClick("${elementId}", (success, err) => window.__agent_post_result({ success, error: err }));`;
    const res = await runInjectedAction(tabId, js);
    if (!res.success) throw new Error(res.error || 'Click failed');
  };

  const executeType = async (tabId: string, elementId: string, text: string): Promise<void> => {
    await injectHelpers(tabId);
    const js = `window.__agentType("${elementId}", ${JSON.stringify(text)}, (success, err) => window.__agent_post_result({ success, error: err }));`;
    const res = await runInjectedAction(tabId, js);
    if (!res.success) throw new Error(res.error || 'Type failed');
  };

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const validateSchema = (json: any): { success: boolean; error?: string } => {
    if (typeof json !== 'object' || json === null) return { success: false, error: 'Not a JSON object' };
    const required = ['thought', 'action'];
    for (const field of required) {
      if (!(field in json)) return { success: false, error: `Missing field: ${field}` };
    }
    return { success: true };
  };

  // Autonomous Agent Loop embedded in single chat interface
  const runAgentForMessage = async (msgId: string, goal: string) => {
    if (!activeTabId || !goal.trim()) return;

    setIsAgentRunning(true);
    agentCancelRef.current[msgId] = false;
    agentPausedRef.current[msgId] = false;

    let currentStep = 0;
    const maxSteps = 20;
    const history: string[] = [];
    let timeline: AgentStepItem[] = [];
    let logs: string[] = [];
    let finalResult: string | null = null;

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

    while (currentStep < maxSteps) {
      if (agentCancelRef.current[msgId]) break;
      while (agentPausedRef.current[msgId]) await sleep(500);

      currentStep++;
      updateMessageState({ currentStep, status: 'Scanning page DOM...' });
      await updateWebviewHud(activeTabId, { step: currentStep, status: 'Scanning page DOM...', task: goal, running: true });

      let domData: any;
      try {
        domData = await scanPageDOM(activeTabId);
      } catch (err: any) {
        logs.push('Error scanning page: ' + err.message);
        updateMessageState({ logs: [...logs], status: 'Error: ' + err.message, running: false });
        await updateWebviewHud(activeTabId, { status: 'Error: ' + err.message, running: false });
        break;
      }

      updateMessageState({ status: 'Thinking & analyzing page elements...' });
      await updateWebviewHud(activeTabId, { status: 'Thinking & analyzing...' });

      const elementsStr = domData.elements.slice(0, 50).map((el: any) => `- ${el.id}: ${el.text} (${el.tagName})`).join('\n');
      const systemPrompt = `You are an autonomous browser agent. Goal: ${goal}. 
Respond STRICTLY with JSON: { "thought": "...", "action": "click|type|navigate|scroll|extract|done", "elementId": "...", "text": "...", "url": "...", "result": "..." }`;
      const userPrompt = `URL: ${domData.url}\nElements:\n${elementsStr}\nHistory: ${history.join(', ')}`;

      let responseText = '';
      try {
        const provider = await getActiveProvider(settings.aiProvider);
        if (!provider) throw new Error('No AI provider configured');
        const key = await getApiKey(settings.aiProvider);
        const stream = provider.chat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ], { model: settings.aiModel || '', apiKey: key || undefined });

        for await (const chunk of stream) responseText += chunk;
      } catch (err: any) {
        finalResult = 'Error: ' + err.message;
        updateMessageState({ result: finalResult, running: false, status: 'Failed' });
        await updateWebviewHud(activeTabId, { status: 'Error: ' + err.message, running: false });
        break;
      }

      setDebugRawLlm(responseText);

      let nextAction: any;
      try {
        nextAction = extractJsonFromText(responseText);
        setDebugParsedJson(nextAction);
        const v = validateSchema(nextAction);
        if (!v.success) throw new Error(v.error);
      } catch (err: any) {
        logs.push('Parse error: ' + err.message);
        setDebugErrors(prev => [...prev, 'Parse error: ' + err.message]);
        updateMessageState({ logs: [...logs], status: 'Parse error: ' + err.message });
        await updateWebviewHud(activeTabId, { status: 'Parse error: ' + err.message });
        continue;
      }

      const actionType = nextAction.action.toLowerCase();
      logs.push(`Thought: ${nextAction.thought}`);
      const actionDesc = `${actionType.toUpperCase()}: ${nextAction.elementId || nextAction.url || ''}`;
      updateMessageState({ logs: [...logs], status: actionDesc });
      await updateWebviewHud(activeTabId, { status: actionDesc });

      const newTimelineItem: AgentStepItem = {
        id: crypto.randomUUID(),
        timestamp: new Date().toLocaleTimeString(),
        actionType,
        target: nextAction.elementId || nextAction.url || '',
        result: nextAction.thought || '',
        status: 'pending'
      };
      timeline = [...timeline, newTimelineItem];
      updateMessageState({ timeline: [...timeline] });

      try {
        if (actionType === 'click') {
          await executeClick(activeTabId, nextAction.elementId);
          history.push(`Clicked ${nextAction.elementId}`);
        } else if (actionType === 'type') {
          await executeType(activeTabId, nextAction.elementId, nextAction.text);
          history.push(`Typed into ${nextAction.elementId}`);
        } else if (actionType === 'navigate') {
          await navigateActiveTab(normalizeAgentUrl(nextAction.url));
          await sleep(3000);
        } else if (actionType === 'done') {
          finalResult = nextAction.result || 'Goal achieved successfully!';
          timeline = timeline.map(it => it.id === newTimelineItem.id ? { ...it, status: 'success' } : it);
          updateMessageState({
            result: finalResult,
            timeline: [...timeline],
            running: false,
            status: 'Completed'
          });
          await updateWebviewHud(activeTabId, { status: 'Goal achieved!', running: false });
          break;
        }
        timeline = timeline.map(it => it.id === newTimelineItem.id ? { ...it, status: 'success' } : it);
        updateMessageState({ timeline: [...timeline] });
      } catch (err: any) {
        logs.push('Action failed: ' + err.message);
        timeline = timeline.map(it => it.id === newTimelineItem.id ? { ...it, status: 'error', result: err.message } : it);
        updateMessageState({
          logs: [...logs],
          timeline: [...timeline],
          status: 'Action failed: ' + err.message
        });
        await updateWebviewHud(activeTabId, { status: 'Action failed: ' + err.message });
      }

      await sleep(1000);
    }

    updateMessageState({ running: false, status: 'Finished.' });
    await cleanupHelpers(activeTabId);
    setIsAgentRunning(false);

    // Save final message state to DB
    const finalMsg = messages.find(m => m.id === msgId);
    if (finalMsg && finalMsg.agentData) {
      const serializedContent = '__AGENT_DATA__:' + JSON.stringify(finalMsg.agentData);
      await dbAddChatMessage({
        tab_id: activeTabId,
        role: 'assistant',
        content: serializedContent,
        provider: settings.aiProvider,
        model: settings.aiModel || ''
      });
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
    if (!text || !activeTabId || isGenerating || isAgentRunning) return;
    if (!textToSend) setInputValue('');

    // Add user message to state & DB
    const userMsg = await dbAddChatMessage({
      tab_id: activeTabId,
      role: 'user',
      content: text,
      provider: settings.aiProvider,
      model: settings.aiModel || ''
    });
    setMessages(prev => [...prev, userMsg]);

    // Parse Intent: Agent action vs Intelligence vs Chat Q&A
    const intent = detectUserIntent(text);

    if (intent.type === 'agent') {
      // 1. Web Automation Agent Task
      const assistantMsgId = crypto.randomUUID();
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
          { role: 'system', content: `You are Aria Browser AI Assistant. Current Page Context:\n${pageText.slice(0, 3000)}` },
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
