import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { Tab, BrowserSettings, HistoryItem, Bookmark, ReadingListItem } from '../types';
import { normalizeUrl } from '../services/utils';
import {
  dbLoadTabs,
  dbSaveTab,
  dbDeleteTab,
  dbAddHistory,
  dbGetHistory,
  dbGetBookmarks,
  dbAddBookmark,
  dbDeleteBookmark,
  dbGetReadingList,
  dbAddReadingListItem,
  dbMarkReadingListRead,
  dbDeleteReadingListItem
} from '../services/db';

interface BrowserState {
  tabs: Tab[];
  activeTabId: string | null;
  history: HistoryItem[];
  bookmarks: Bookmark[];
  readingList: ReadingListItem[];
  settings: BrowserSettings;
  sidebarOpen: boolean;
  sidebarMode: 'chat' | 'intelligence' | 'agent' | 'debug';
  sidebarWidth: number;
  readerModeActive: boolean;
  settingsOpen: boolean;
  askAiActive: boolean;
  windowWidth: number;
  windowHeight: number;

  // Actions
  initStore: () => Promise<void>;
  addTab: (url?: string) => Promise<string>;
  closeTab: (id: string) => Promise<void>;
  setActiveTabId: (id: string) => Promise<void>;
  updateTab: (id: string, updates: Partial<Tab>) => Promise<void>;
  reorderTabs: (srcIndex: number, dstIndex: number) => Promise<void>;
  setSidebarOpen: (open: boolean) => Promise<void>;
  setSidebarMode: (mode: 'chat' | 'intelligence' | 'agent' | 'debug') => void;
  setReaderModeActive: (active: boolean) => Promise<void>;
  setSettingsOpen: (open: boolean) => Promise<void>;
  setAskAiActive: (active: boolean) => void;
  updateWindowSize: (width: number, height: number) => Promise<void>;

  // Navigation
  navigateActiveTab: (url: string) => Promise<void>;
  goBackActiveTab: () => Promise<void>;
  goForwardActiveTab: () => Promise<void>;
  reloadActiveTab: () => Promise<void>;

  // History & Bookmarks
  addHistoryEntry: (url: string, title: string) => Promise<void>;
  addBookmarkEntry: (url: string, title: string, favicon?: string) => Promise<void>;
  deleteBookmarkEntry: (id: string) => Promise<void>;

  // Reading List
  addReadingItem: (url: string, title: string, excerpt?: string) => Promise<void>;
  toggleReadingItemRead: (id: string, read: boolean) => Promise<void>;
  deleteReadingItem: (id: string) => Promise<void>;

  // Settings
  updateSettings: (updates: Partial<BrowserSettings>) => void;
}

const DEFAULT_SETTINGS: BrowserSettings = {
  theme: 'dark',
  fontSize: 14,
  sidebarPosition: 'right',
  defaultSearchEngine: 'duckduckgo',
  homepage: 'https://duckduckgo.com',
  startupBehavior: 'newtab',
  trackingProtection: true,
  aiProvider: 'openrouter',
  aiModel: 'openrouter/free'
};

export const useBrowserStore = create<BrowserState>((set, get) => {
  // Helper to calculate active webview bounds
  const getWebviewBounds = (state: BrowserState) => {
    // If settings or reader mode are active, push webview off-screen to prevent occlusion
    if (state.settingsOpen || state.readerModeActive) {
      return {
        x: -10000,
        y: -10000,
        width: 100,
        height: 100
      };
    }

    const topChromeHeight = 80; // 36px titlebar + 44px navigation bar
    const sidebarWidth = state.sidebarOpen ? state.sidebarWidth : 0;

    let x = 0;
    let width = state.windowWidth;

    if (state.sidebarOpen) {
      if (state.settings.sidebarPosition === 'left') {
        x = sidebarWidth;
        width = state.windowWidth - sidebarWidth;
      } else {
        width = state.windowWidth - sidebarWidth;
      }
    }

    return {
      x,
      y: topChromeHeight,
      width: Math.max(width, 200),
      height: Math.max(state.windowHeight - topChromeHeight, 200)
    };
  };

  // Sync active webview layout on size changes
  const syncActiveWebviewLayout = async (state: BrowserState) => {
    if (!state.activeTabId) return;
    const bounds = getWebviewBounds(state);
    try {
      await invoke('resize_tab_webview', {
        webviewLabel: `tab-${state.activeTabId}`,
        ...bounds
      });
    } catch (e) {
      console.warn('Failed to resize active webview', e);
    }
  };

  return {
    tabs: [],
    activeTabId: null,
    history: [],
    bookmarks: [],
    readingList: [],
    settings: DEFAULT_SETTINGS,
    sidebarOpen: false,
    sidebarMode: 'chat',
    sidebarWidth: 360,
    readerModeActive: false,
    settingsOpen: false,
    askAiActive: false,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,

    initStore: async () => {
      // 1. Load settings from LocalStorage
      const savedSettings = localStorage.getItem('aria_settings');
      let settings = savedSettings ? { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) } : DEFAULT_SETTINGS;
      if (settings.aiProvider === 'ollama' || !settings.aiProvider) {
        settings.aiProvider = 'openrouter';
      }
      if (settings.aiProvider === 'openrouter') {
        if (!settings.aiModel || !settings.aiModel.includes('/') || settings.aiModel.includes('gemini-2.0-flash-exp')) {
          settings.aiModel = 'openrouter/free';
        }
      }
      localStorage.setItem('aria_settings', JSON.stringify(settings));
      set({ settings });

      // Apply theme
      document.documentElement.classList.toggle('dark', settings.theme === 'dark' || (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches));

      // 2. Load lists from SQLite
      const history = await dbGetHistory();
      const bookmarks = await dbGetBookmarks();
      const readingList = await dbGetReadingList();

      set({ history, bookmarks, readingList });

      // 3. Load saved tabs session
      if (settings.startupBehavior === 'restore') {
        const tabs = await dbLoadTabs();
        if (tabs.length > 0) {
          set({ tabs });
          // Activate the last active tab or the first tab
          await get().setActiveTabId(tabs[0].id);
          return;
        }
      }

      // Default: create initial empty tab
      await get().addTab(settings.homepage);
    },

    addTab: async (url) => {
      const settings = get().settings;
      const initialUrl = url || settings.homepage;
      const newTab: Tab = {
        id: crypto.randomUUID(),
        url: initialUrl,
        title: 'New Tab',
        position: get().tabs.length,
        pinned: false,
        loading: true
      };

      const updatedTabs = [...get().tabs, newTab];
      set({ tabs: updatedTabs });
      await dbSaveTab(newTab);

      // Create backend webview
      const bounds = getWebviewBounds(get() as BrowserState);
      try {
        await invoke('create_tab_webview', {
          windowLabel: 'main',
          webviewLabel: `tab-${newTab.id}`,
          url: initialUrl,
          ...bounds
        });
      } catch (e) {
        console.error('Failed to create webview', e);
      }

      await get().setActiveTabId(newTab.id);
      return newTab.id;
    },

    closeTab: async (id) => {
      const tabs = get().tabs;
      const tabToClose = tabs.find(t => t.id === id);
      if (!tabToClose) return;

      const remainingTabs = tabs.filter(t => t.id !== id).map((t, idx) => ({ ...t, position: idx }));

      // Destroy backend webview
      try {
        await invoke('destroy_tab_webview', { webviewLabel: `tab-${id}` });
      } catch (e) {
        console.warn('Failed to destroy webview', e);
      }

      await dbDeleteTab(id);
      for (const tab of remainingTabs) {
        await dbSaveTab(tab);
      }

      if (remainingTabs.length === 0) {
        set({ tabs: [], activeTabId: null, readerModeActive: false });
        await get().addTab();
        return;
      }

      set({ tabs: remainingTabs });

      // If we closed the active tab, switch to another one
      if (get().activeTabId === id) {
        const nextActiveTab = remainingTabs[Math.max(0, tabToClose.position - 1)];
        await get().setActiveTabId(nextActiveTab.id);
      }
    },

    setActiveTabId: async (id) => {
      const currentActiveId = get().activeTabId;
      if (currentActiveId === id) return;

      // Update state first
      set({ activeTabId: id, readerModeActive: false });

      // Move old active webview off-screen
      if (currentActiveId) {
        try {
          await invoke('resize_tab_webview', {
            webviewLabel: `tab-${currentActiveId}`,
            x: -10000,
            y: -10000,
            width: 100,
            height: 100
          });
        } catch (e) {
          console.warn('Failed to hide old active webview', e);
        }
      }

      // Move new active webview back to layout bounds
      const activeState = get() as BrowserState;
      await syncActiveWebviewLayout(activeState);
    },

    updateTab: async (id, updates) => {
      const tabs = get().tabs.map(t => {
        if (t.id === id) {
          const updated = { ...t, ...updates };
          dbSaveTab(updated);
          return updated;
        }
        return t;
      });
      set({ tabs });
    },

    reorderTabs: async (srcIndex, dstIndex) => {
      const tabs = [...get().tabs];
      const [removed] = tabs.splice(srcIndex, 1);
      tabs.splice(dstIndex, 0, removed);

      const reordered = tabs.map((t, idx) => ({ ...t, position: idx }));
      set({ tabs: reordered });

      for (const tab of reordered) {
        await dbSaveTab(tab);
      }
    },

    setSidebarOpen: async (open) => {
      set({ sidebarOpen: open });
      // Layout bounds change when sidebar toggles, so resize active webview!
      await syncActiveWebviewLayout(get() as BrowserState);
    },

    setSidebarMode: (mode) => set({ sidebarMode: mode }),
    setReaderModeActive: async (active) => {
      set({ readerModeActive: active });
      await syncActiveWebviewLayout(get() as BrowserState);
    },
    setSettingsOpen: async (open) => {
      set({ settingsOpen: open });
      await syncActiveWebviewLayout(get() as BrowserState);
    },
    setAskAiActive: (active) => set({ askAiActive: active }),

    updateWindowSize: async (width, height) => {
      set({ windowWidth: width, windowHeight: height });
      await syncActiveWebviewLayout(get() as BrowserState);
    },

    // NAVIGATION ACTIONS
    navigateActiveTab: async (url) => {
      const activeId = get().activeTabId;
      if (!activeId) return;

      const formattedUrl = normalizeUrl(url, get().settings.defaultSearchEngine);
      await get().updateTab(activeId, { url: formattedUrl, loading: true });

      try {
        await invoke('navigate_tab_webview', {
          webviewLabel: `tab-${activeId}`,
          url: formattedUrl
        });
      } catch (e) {
        console.error('Failed to navigate webview', e);
      }
    },

    goBackActiveTab: async () => {
      const activeId = get().activeTabId;
      if (!activeId) return;
      try {
        await get().updateTab(activeId, { loading: true });
        await invoke('eval_tab_webview', {
          webviewLabel: `tab-${activeId}`,
          js: 'window.history.back()'
        });
      } catch (e) {
        console.error('Go back failed', e);
      }
    },

    goForwardActiveTab: async () => {
      const activeId = get().activeTabId;
      if (!activeId) return;
      try {
        await get().updateTab(activeId, { loading: true });
        await invoke('eval_tab_webview', {
          webviewLabel: `tab-${activeId}`,
          js: 'window.history.forward()'
        });
      } catch (e) {
        console.error('Go forward failed', e);
      }
    },

    reloadActiveTab: async () => {
      const activeId = get().activeTabId;
      if (!activeId) return;
      try {
        await get().updateTab(activeId, { loading: true });
        await invoke('eval_tab_webview', {
          webviewLabel: `tab-${activeId}`,
          js: 'window.location.reload()'
        });
      } catch (e) {
        console.error('Reload failed', e);
      }
    },

    // HISTORY & BOOKMARKS
    addHistoryEntry: async (url, title) => {
      await dbAddHistory(url, title);
      const history = await dbGetHistory();
      set({ history });
    },

    addBookmarkEntry: async (url, title, favicon) => {
      const newBookmark = await dbAddBookmark(url, title, favicon);
      set({ bookmarks: [newBookmark, ...get().bookmarks] });
    },

    deleteBookmarkEntry: async (id) => {
      await dbDeleteBookmark(id);
      set({ bookmarks: get().bookmarks.filter(b => b.id !== id) });
    },

    // READING LIST
    addReadingItem: async (url, title, excerpt) => {
      const newItem = await dbAddReadingListItem(url, title, excerpt);
      set({ readingList: [newItem, ...get().readingList] });
    },

    toggleReadingItemRead: async (id, read) => {
      await dbMarkReadingListRead(id, read);
      set({
        readingList: get().readingList.map(item =>
          item.id === id ? { ...item, read } : item
        )
      });
    },

    deleteReadingItem: async (id) => {
      await dbDeleteReadingListItem(id);
      set({ readingList: get().readingList.filter(item => item.id !== id) });
    },

    // SETTINGS
    updateSettings: (updates) => {
      const updatedSettings = { ...get().settings, ...updates };
      set({ settings: updatedSettings });
      localStorage.setItem('aria_settings', JSON.stringify(updatedSettings));

      // Apply theme class
      document.documentElement.classList.toggle('dark', updatedSettings.theme === 'dark' || (updatedSettings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches));

      // Trigger size sync in case layout constraints changed
      syncActiveWebviewLayout(get() as BrowserState);
    }
  };
});
