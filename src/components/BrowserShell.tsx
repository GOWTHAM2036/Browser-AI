import React, { useEffect, useRef, useState } from 'react';
import { useBrowserStore } from '../store/browserStore';
import { TabBar } from './TabBar';
import { Omnibox } from './Omnibox';
import { SidePanel } from './SidePanel';
import { ReaderMode } from './ReaderMode';
import { SettingsUI } from './Settings';
import { AgentCursor } from './agent/AgentCursor';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { listen, Event } from '@tauri-apps/api/event';
import { ArrowLeft, ArrowRight, RotateCw, Home, BookOpen, Sparkles, Settings as SettingsIcon, Minus, Square, X } from 'lucide-react';

export const BrowserShell: React.FC = () => {
  const {
    tabs,
    activeTabId,
    sidebarOpen,
    readerModeActive,
    settings,
    addTab,
    closeTab,
    setSidebarOpen,
    setReaderModeActive,
    reloadActiveTab,
    goBackActiveTab,
    goForwardActiveTab,
    updateWindowSize,
    addHistoryEntry,
    updateTab
  } = useBrowserStore();

  const [showSettings, setShowSettings] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeTab = tabs.find(t => t.id === activeTabId);

  // Initialize store and database
  useEffect(() => {
    useBrowserStore.getState().initStore();
  }, []);

  // Listen to native window resize events
  useEffect(() => {
    const handleResize = () => {
      updateWindowSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Listen for settings open request from SidePanel
  useEffect(() => {
    const handleOpenSettings = () => setShowSettings(true);
    window.addEventListener('aria-open-settings', handleOpenSettings);
    return () => window.removeEventListener('aria-open-settings', handleOpenSettings);
  }, []);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleGlobalShortcuts = async (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;
      
      if (isMeta && e.key.toLowerCase() === 't') {
        e.preventDefault();
        await addTab();
      } else if (isMeta && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        if (activeTabId) await closeTab(activeTabId);
      } else if (isMeta && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        const inputEl = document.querySelector('input[placeholder*="Search or type URL"]') as HTMLInputElement;
        inputEl?.focus();
        inputEl?.select();
      } else if (isMeta && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        await reloadActiveTab();
      } else if (isMeta && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        await setSidebarOpen(!sidebarOpen);
      }
    };

    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
  }, [activeTabId, sidebarOpen]);

  // Position and Size sync for the active child webview
  useEffect(() => {
    const syncWebviewBounds = async () => {
      if (!activeTabId || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const isCovered = readerModeActive || showSettings;

      // If covered, push it off-screen
      const x = isCovered ? -10000 : Math.round(rect.left);
      const y = isCovered ? -10000 : Math.round(rect.top);
      const width = isCovered ? 100 : Math.max(100, Math.round(rect.width));
      const height = isCovered ? 100 : Math.max(100, Math.round(rect.height));

      try {
        await invoke('resize_tab_webview', {
          webviewLabel: `tab-${activeTabId}`,
          x,
          y,
          width,
          height
        });
      } catch (e) {
        console.warn('Failed to sync webview bounds', e);
      }
    };

    // Sync bounds immediately
    syncWebviewBounds();

    // Setup ResizeObserver to track layout changes
    if (containerRef.current) {
      const observer = new ResizeObserver(() => {
        syncWebviewBounds();
      });
      observer.observe(containerRef.current);
      return () => observer.disconnect();
    }
  }, [activeTabId, sidebarOpen, readerModeActive, showSettings, settings.sidebarPosition]);

  // Listen for navigation updates inside the child webview (via custom page-content event)
  // Listen for navigation updates inside any child webview (via global tab-metadata-update event)
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupGlobalListener = async () => {
      unlisten = await listen<any>('tab-metadata-update', async (event: Event<any>) => {
        try {
          const { webview_label, payload } = event.payload;
          const tabId = webview_label.replace('tab-', '');
          
          // Safely attempt to parse JSON. If it's not JSON (e.g. raw page text), ignore it here.
          // Other listeners (like in SidePanel) handle raw text payloads.
          let data;
          try {
            data = JSON.parse(payload);
          } catch (e) {
            // Not JSON, likely raw page content intended for another listener
            return;
          }
          
          if (data.type === 'page_load') {
            await updateTab(tabId, {
              url: data.url,
              title: data.title || 'Untitled',
              favicon: data.favicon || undefined,
              loading: false,
              ...(data.canGoBack !== undefined ? { canGoBack: data.canGoBack } : {}),
              ...(data.canGoForward !== undefined ? { canGoForward: data.canGoForward } : {})
            });
            // Log to database history
            await addHistoryEntry(data.url, data.title);
          } else if (data.type === 'page_start_load') {
            await updateTab(tabId, {
              url: data.url,
              loading: true
            });
          }
        } catch {}
      });
    };

    setupGlobalListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // TitleBar Handlers
  const handleMinimize = async () => {
    const win = getCurrentWindow();
    await win.minimize();
  };

  const handleMaximize = async () => {
    const win = getCurrentWindow();
    if (await win.isMaximized()) {
      await win.unmaximize();
    } else {
      await win.maximize();
    }
  };

  const handleClose = async () => {
    const win = getCurrentWindow();
    await win.close();
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#0b0f19] select-none text-slate-200">
      {/* Titlebar with Tab Bar & Window Controls */}
      <div className="flex items-center justify-between bg-[#0f172a] h-9 select-none relative">
        {/* Left Side: Sparkles / Logo */}
        <div className="flex items-center gap-1.5 pl-3 pr-2 text-[#3b82f6]">
          <Sparkles size={14} className="animate-pulse" />
          <span className="text-xs font-black tracking-wider text-white">ARIA</span>
        </div>

        {/* Dynamic Tab Bar occupies the center */}
        <div className="flex-1 min-w-0 h-full">
          <TabBar />
        </div>

        {/* Windows Custom Window Controls */}
        <div className="flex items-center h-full select-none">
          <button
            onClick={handleMinimize}
            className="flex items-center justify-center w-11 h-full hover:bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
            title="Minimize"
          >
            <Minus size={13} />
          </button>
          <button
            onClick={handleMaximize}
            className="flex items-center justify-center w-11 h-full hover:bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
            title="Maximize"
          >
            <Square size={10} />
          </button>
          <button
            onClick={handleClose}
            className="flex items-center justify-center w-11 h-full hover:bg-red-600 text-slate-400 hover:text-white transition-colors cursor-pointer"
            title="Close"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Navigation Toolbar */}
      <div className="flex items-center px-4 py-1.5 bg-[#1e293b] border-b border-slate-800 gap-1 select-none">
        <button
          onClick={goBackActiveTab}
          disabled={!activeTab?.canGoBack}
          className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-all cursor-pointer"
          title="Back"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          onClick={goForwardActiveTab}
          disabled={!activeTab?.canGoForward}
          className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-all cursor-pointer"
          title="Forward"
        >
          <ArrowRight size={13} />
        </button>
        <button
          onClick={reloadActiveTab}
          className={`p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-all cursor-pointer ${
            activeTab?.loading ? 'animate-spin text-[#3b82f6]' : ''
          }`}
          title="Reload"
        >
          <RotateCw size={12} />
        </button>
        <button
          onClick={() => updateTab(activeTabId!, { url: settings.homepage })}
          className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-all cursor-pointer"
          title="Home"
        >
          <Home size={13} />
        </button>

        {/* Omnibox URL input */}
        <Omnibox />

        {/* Toolbar Action Buttons */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setReaderModeActive(!readerModeActive)}
            className={`p-1.5 rounded-lg hover:bg-slate-700 transition-all cursor-pointer ${
              readerModeActive ? 'text-[#3b82f6] bg-slate-800' : 'text-slate-400 hover:text-slate-200'
            }`}
            title="Reader Mode"
          >
            <BookOpen size={13} />
          </button>
          <button
            onClick={() => {
              console.log("[Toolbar] AI Panel clicked! Current state sidebarOpen:", sidebarOpen);
              setSidebarOpen(!sidebarOpen);
            }}
            className={`p-1.5 rounded-lg hover:bg-slate-700 transition-all cursor-pointer ${
              sidebarOpen ? 'text-purple-400 bg-slate-800' : 'text-slate-400 hover:text-slate-200'
            }`}
            title="AI Panel (Ctrl+Shift+A)"
          >
            <Sparkles size={13} />
          </button>
          <button
            onClick={() => {
              console.log("[Toolbar] Settings clicked! Current state showSettings:", showSettings);
              setShowSettings(!showSettings);
            }}
            className={`p-1.5 rounded-lg hover:bg-slate-700 transition-all cursor-pointer ${
              showSettings ? 'text-[#3b82f6] bg-slate-800' : 'text-slate-400 hover:text-slate-200'
            }`}
            title="Settings"
          >
            <SettingsIcon size={13} />
          </button>
        </div>
      </div>

      {/* Main Panel Layout (Content + SidePanel) */}
      <div className={`flex-1 flex overflow-hidden relative ${
        settings.sidebarPosition === 'left' ? 'flex-row-reverse' : 'flex-row'
      }`}>
        {/* Content Box: Reserves space for Webview, overlays overlays */}
        <div className="flex-1 h-full relative overflow-hidden bg-black">
          {/* Webview Position Marker */}
          <div ref={containerRef} id="aria-webview-container" className="w-full h-full" />

          {/* Reader Mode Overlay */}
          <ReaderMode />
        </div>

        {/* AI Side Panel */}
        <SidePanel />
      </div>

      {/* Settings Overlay — renders on top of EVERYTHING */}
      {showSettings && <SettingsUI onClose={() => setShowSettings(false)} />}

      {/* ARIA Agent Visual Cursor & Target Highlight Overlay */}
      <AgentCursor />
    </div>
  );
};
