import React, { useState, useEffect, useRef } from 'react';
import { useBrowserStore } from '../store/browserStore';
import { Search, Sparkles, History, Bookmark, ArrowRight } from 'lucide-react';
import { normalizeUrl } from '../services/utils';

export const Omnibox: React.FC = () => {
  const {
    tabs,
    activeTabId,
    history,
    bookmarks,
    sidebarOpen,
    settings,
    setSidebarOpen,
    setSidebarMode,
    navigateActiveTab,
    askAiActive,
    setAskAiActive
  } = useBrowserStore();

  const activeTab = tabs.find(t => t.id === activeTabId);
  const [inputValue, setInputValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionIdx, setSuggestionIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync input value with active tab URL
  useEffect(() => {
    if (activeTab) {
      setInputValue(activeTab.url === 'about:blank' ? '' : activeTab.url);
    }
  }, [activeTab?.url, activeTabId]);

  // Click outside suggestions closer
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setShowSuggestions(true);
    setSuggestionIdx(-1);
    
    // Auto-detect Ask AI prefix
    if (e.target.value.startsWith('/ai ')) {
      setAskAiActive(true);
    } else if (askAiActive && !e.target.value.startsWith('/ai ')) {
      setAskAiActive(false);
    }
  };

  // Get matching suggestions
  const getSuggestions = () => {
    if (!inputValue.trim()) return [];
    
    const query = inputValue.toLowerCase();
    
    // Suggest bookmarks
    const matchedBookmarks = bookmarks
      .filter(b => b.title.toLowerCase().includes(query) || b.url.toLowerCase().includes(query))
      .slice(0, 3)
      .map(b => ({ type: 'bookmark', title: b.title, url: b.url }));
      
    // Suggest history
    const matchedHistory = history
      .filter(h => h.title.toLowerCase().includes(query) || h.url.toLowerCase().includes(query))
      .slice(0, 5)
      .map(h => ({ type: 'history', title: h.title, url: h.url }));

    return [...matchedBookmarks, ...matchedHistory];
  };

  const suggestions = getSuggestions();

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSuggestionIdx(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSuggestionIdx(prev => Math.max(prev - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      
      let targetUrl = inputValue;
      if (suggestionIdx >= 0 && suggestions[suggestionIdx]) {
        targetUrl = suggestions[suggestionIdx].url;
      }

      if (e.ctrlKey || e.metaKey || askAiActive) {
        // "Ask AI" mode! Forward query directly to the AI panel
        const queryText = askAiActive ? targetUrl.replace(/^\/ai\s+/, '') : targetUrl;
        
        // Open sidebar & set chat mode
        if (!sidebarOpen) {
          await setSidebarOpen(true);
        }
        setSidebarMode('chat');
        
        // Trigger custom chat event to send query to AI Sidepanel
        const customEvent = new CustomEvent('aria-ask-ai', { detail: queryText });
        window.dispatchEvent(customEvent);

        // Reset input and close dropdown
        setInputValue(activeTab?.url || '');
        setAskAiActive(false);
        setShowSuggestions(false);
      } else {
        // Normal Navigation
        const target = normalizeUrl(targetUrl, settings.defaultSearchEngine);
        await navigateActiveTab(target);
        setInputValue(target);
        setShowSuggestions(false);
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      if (activeTab) setInputValue(activeTab.url);
    }
  };

  const handleSelectSuggestion = async (url: string) => {
    const target = normalizeUrl(url, settings.defaultSearchEngine);
    setInputValue(target);
    await navigateActiveTab(target);
    setShowSuggestions(false);
  };

  return (
    <div ref={containerRef} className="relative flex-1 max-w-2xl mx-4 select-none">
      <div className={`relative flex items-center bg-[#0b0f19] border rounded-lg transition-all duration-200 ${
        askAiActive 
          ? 'border-purple-600 ring-2 ring-purple-600/20' 
          : 'border-slate-700 focus-within:border-[#3b82f6] focus-within:ring-2 focus-within:ring-[#3b82f6]/20'
      }`}>
        <div className="pl-3 text-slate-400">
          {askAiActive ? (
            <Sparkles size={14} className="text-purple-400 animate-pulse" />
          ) : (
            <Search size={14} />
          )}
        </div>

        <input
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          placeholder={askAiActive ? "Ask AI about anything... (Enter to ask)" : "Search or type URL... (Cmd+Enter to Ask AI)"}
          className="w-full bg-transparent border-0 py-1.5 pl-2.5 pr-12 text-xs text-slate-200 outline-none placeholder-slate-500 font-sans"
        />

        <div className="absolute right-3 flex items-center gap-1.5 text-[10px] text-slate-500">
          {askAiActive ? (
            <span className="bg-purple-950 text-purple-300 border border-purple-800 px-1.5 py-0.5 rounded-md flex items-center gap-1">
              AI mode
            </span>
          ) : (
            <span className="border border-slate-700 bg-slate-900 px-1 py-0.5 rounded-md leading-none text-slate-400">
              Ctrl+Enter
            </span>
          )}
        </div>
      </div>

      {/* Autocomplete suggestions dropdown */}
      {showSuggestions && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 mt-1.5 bg-[#0b0f19] border border-slate-800 rounded-lg shadow-xl overflow-hidden z-[9999] max-h-64 overflow-y-auto">
          {suggestions.map((s, idx) => {
            const isSelected = idx === suggestionIdx;
            return (
              <div
                key={idx}
                onClick={() => handleSelectSuggestion(s.url)}
                onMouseEnter={() => setSuggestionIdx(idx)}
                className={`flex items-center gap-3 px-3 py-2 text-xs cursor-pointer border-l-2 transition-all ${
                  isSelected 
                    ? 'bg-[#1e293b] border-slate-400 text-white' 
                    : 'border-transparent text-slate-400 hover:bg-[#131b2e] hover:text-slate-300'
                }`}
              >
                <div className="text-slate-500">
                  {s.type === 'bookmark' ? <Bookmark size={12} className="text-yellow-500" /> : <History size={12} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate text-slate-200">{s.title}</div>
                  <div className="text-[10px] text-slate-500 truncate">{s.url}</div>
                </div>
                <ArrowRight size={12} className={`opacity-0 ${isSelected ? 'opacity-100' : ''}`} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
