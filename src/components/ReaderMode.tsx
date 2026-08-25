import React, { useState, useEffect, useRef } from 'react';
import { useBrowserStore } from '../store/browserStore';
import { listen, Event } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Readability } from '@mozilla/readability';
import { X, Play, Pause, Square, BookOpen, Plus, Check } from 'lucide-react';

interface ArticleData {
  title: string;
  content: string;
  textContent: string;
  excerpt?: string;
  byline?: string;
  siteName?: string;
}

export const ReaderMode: React.FC = () => {
  const {
    activeTabId,
    tabs,
    readerModeActive,
    setReaderModeActive,
    readingList,
    addReadingItem,
    deleteReadingItem
  } = useBrowserStore();

  const activeTab = tabs.find(t => t.id === activeTabId);

  const [article, setArticle] = useState<ArticleData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Reader Style Settings
  const [fontSize, setFontSize] = useState(16);
  const [lineHeight] = useState(1.6);
  const [fontFamily, setFontFamily] = useState<'sans' | 'serif' | 'mono'>('serif');
  const [theme, setTheme] = useState<'light' | 'dark' | 'sepia'>('sepia');

  // TTS State
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Parse page content when reader mode is activated
  useEffect(() => {
    if (readerModeActive && activeTabId) {
      loadReaderContent();
    } else {
      // Stop TTS if exited
      handleStopTTS();
    }
  }, [readerModeActive, activeTabId]);

  const loadReaderContent = async () => {
    setLoading(true);
    setError('');
    setArticle(null);

    const eventName = `page-content-tab-${activeTabId}`;
    let unlisten: (() => void) | null = null;

    const timeout = setTimeout(() => {
      if (unlisten) unlisten();
      setError('Timeout extracting webpage HTML');
      setLoading(false);
    }, 6000);

    unlisten = await listen<string>(eventName, (event: Event<string>) => {
      clearTimeout(timeout);
      if (unlisten) unlisten();
      
      try {
        const html = event.payload;
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Run Mozilla Readability
        const reader = new Readability(doc);
        const parsed = reader.parse();
        
        if (parsed) {
          setArticle({
            title: parsed.title,
            content: parsed.content,
            textContent: parsed.textContent,
            excerpt: parsed.excerpt || undefined,
            byline: parsed.byline || undefined,
            siteName: parsed.siteName || undefined
          });
        } else {
          setError('Failed to extract readable article content.');
        }
      } catch (e: any) {
        setError(`Error parsing page: ${e.message}`);
      } finally {
        setLoading(false);
      }
    });

    try {
      // Inject script to extract document outerHTML safely via chunked transport
      const js = `
        (function() {
          try {
            var rawStr = document.documentElement.outerHTML || '';
            var CHUNK_SIZE = 600;
            var total = Math.ceil(rawStr.length / CHUNK_SIZE) || 1;
            var msgId = 'msg_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);

            if (total === 1 && rawStr.length < 1500) {
              location.href = 'https://tauri-ipc-bridge/data?payload=' + encodeURIComponent(rawStr);
              return;
            }

            for (var i = 0; i < total; i++) {
              (function(idx) {
                setTimeout(function() {
                  var slice = rawStr.substring(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
                  var chunkUrl = 'https://tauri-ipc-bridge/chunk?id=' + encodeURIComponent(msgId) +
                                 '&index=' + idx +
                                 '&total=' + total +
                                 '&data=' + encodeURIComponent(slice);
                  location.href = chunkUrl;
                }, idx * 25);
              })(i);
            }
          } catch(e) {}
        })();
      `;
      await invoke('eval_tab_webview', { webviewLabel: `tab-${activeTabId}`, js: js });
    } catch (e: any) {
      clearTimeout(timeout);
      if (unlisten) unlisten();
      setError(`Extraction error: ${e.message}`);
      setLoading(false);
    }
  };

  // Text to Speech
  const handlePlayTTS = () => {
    if (!article) return;

    if (isPaused) {
      window.speechSynthesis.resume();
      setIsPlaying(true);
      setIsPaused(false);
      return;
    }

    window.speechSynthesis.cancel(); // Clear any active speech

    const cleanText = article.textContent.replace(/\s+/g, ' ').slice(0, 15000); // Limit length
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utteranceRef.current = utterance;

    utterance.onend = () => {
      setIsPlaying(false);
      setIsPaused(false);
    };

    utterance.onerror = () => {
      setIsPlaying(false);
      setIsPaused(false);
    };

    window.speechSynthesis.speak(utterance);
    setIsPlaying(true);
    setIsPaused(false);
  };

  const handlePauseTTS = () => {
    if (isPlaying) {
      window.speechSynthesis.pause();
      setIsPlaying(false);
      setIsPaused(true);
    }
  };

  const handleStopTTS = () => {
    window.speechSynthesis.cancel();
    setIsPlaying(false);
    setIsPaused(false);
  };

  // Save to Reading list
  const isSaved = activeTab ? readingList.some(item => item.url === activeTab.url) : false;

  const handleSaveToReadingList = async () => {
    if (!activeTab || !article) return;
    if (isSaved) {
      const savedItem = readingList.find(item => item.url === activeTab.url);
      if (savedItem) await deleteReadingItem(savedItem.id);
    } else {
      await addReadingItem(activeTab.url, article.title, article.excerpt);
    }
  };

  if (!readerModeActive) return null;

  // Background and text styles based on theme
  const getThemeClasses = () => {
    if (theme === 'dark') return 'bg-slate-950 text-slate-300';
    if (theme === 'sepia') return 'bg-[#f4ecd8] text-[#5b4636]';
    return 'bg-white text-slate-800';
  };

  const getFontFamilyClass = () => {
    if (fontFamily === 'serif') return 'font-serif';
    if (fontFamily === 'mono') return 'font-mono';
    return 'font-sans';
  };

  return (
    <div className={`absolute inset-x-0 bottom-0 top-[80px] z-[999] flex flex-col ${getThemeClasses()} overflow-hidden`}>
      {/* Top Toolbar */}
      <div className={`flex items-center justify-between px-6 py-3 border-b ${
        theme === 'dark' ? 'border-slate-850 bg-slate-900' : 'border-slate-300/40 bg-slate-100/50'
      }`}>
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <BookOpen size={14} className="text-[#3b82f6]" />
          Reader Mode
        </div>

        {/* Layout controls */}
        <div className="flex items-center gap-4 text-xs">
          {/* Font Controls */}
          <div className="flex items-center gap-1.5 border-r border-slate-300/60 pr-4">
            <button
              onClick={() => setFontFamily('sans')}
              className={`px-2 py-0.5 rounded cursor-pointer ${fontFamily === 'sans' ? 'bg-[#3b82f6] text-white' : 'hover:bg-slate-200/50'}`}
            >
              Sans
            </button>
            <button
              onClick={() => setFontFamily('serif')}
              className={`px-2 py-0.5 rounded cursor-pointer ${fontFamily === 'serif' ? 'bg-[#3b82f6] text-white' : 'hover:bg-slate-200/50'}`}
            >
              Serif
            </button>
            <button
              onClick={() => setFontFamily('mono')}
              className={`px-2 py-0.5 rounded cursor-pointer ${fontFamily === 'mono' ? 'bg-[#3b82f6] text-white' : 'hover:bg-slate-200/50'}`}
            >
              Mono
            </button>
          </div>

          {/* Sizing Controls */}
          <div className="flex items-center gap-2 border-r border-slate-300/60 pr-4">
            <button
              onClick={() => setFontSize(prev => Math.max(12, prev - 1))}
              className="px-2 py-0.5 rounded border border-slate-400/30 hover:bg-slate-200/50 cursor-pointer font-bold"
            >
              A-
            </button>
            <span className="font-semibold">{fontSize}px</span>
            <button
              onClick={() => setFontSize(prev => Math.min(26, prev + 1))}
              className="px-2 py-0.5 rounded border border-slate-400/30 hover:bg-slate-200/50 cursor-pointer font-bold"
            >
              A+
            </button>
          </div>

          {/* Theme Selector */}
          <div className="flex items-center gap-1.5 border-r border-slate-300/60 pr-4">
            <button
              onClick={() => setTheme('light')}
              className={`w-5 h-5 rounded-full border border-slate-400/30 bg-white cursor-pointer ${theme === 'light' ? 'ring-2 ring-blue-500' : ''}`}
              title="Light"
            />
            <button
              onClick={() => setTheme('sepia')}
              className={`w-5 h-5 rounded-full border border-slate-400/30 bg-[#f4ecd8] cursor-pointer ${theme === 'sepia' ? 'ring-2 ring-blue-500' : ''}`}
              title="Sepia"
            />
            <button
              onClick={() => setTheme('dark')}
              className={`w-5 h-5 rounded-full border border-slate-400/30 bg-slate-900 cursor-pointer ${theme === 'dark' ? 'ring-2 ring-blue-500' : ''}`}
              title="Dark"
            />
          </div>

          {/* TTS Controls */}
          <div className="flex items-center gap-2 border-r border-slate-300/60 pr-4">
            {!isPlaying ? (
              <button
                onClick={handlePlayTTS}
                className="p-1.5 rounded-full bg-green-600 hover:bg-green-500 text-white cursor-pointer"
                title="Play Audio Description"
              >
                <Play size={11} fill="white" />
              </button>
            ) : (
              <button
                onClick={handlePauseTTS}
                className="p-1.5 rounded-full bg-yellow-600 hover:bg-yellow-500 text-white cursor-pointer"
                title="Pause"
              >
                <Pause size={11} fill="white" />
              </button>
            )}
            {(isPlaying || isPaused) && (
              <button
                onClick={handleStopTTS}
                className="p-1.5 rounded-full bg-red-650 hover:bg-red-550 text-white cursor-pointer"
                title="Stop"
              >
                <Square size={11} fill="white" />
              </button>
            )}
          </div>

          {/* Save to Reading List */}
          <button
            onClick={handleSaveToReadingList}
            className={`flex items-center gap-1.5 py-1 px-3 rounded-lg border text-xs font-semibold cursor-pointer ${
              isSaved 
                ? 'bg-green-700/20 border-green-700 text-green-500 hover:bg-green-700/30' 
                : 'bg-blue-600 border-blue-500 hover:bg-blue-500 text-white'
            }`}
          >
            {isSaved ? (
              <>
                <Check size={12} />
                Saved
              </>
            ) : (
              <>
                <Plus size={12} />
                Save Reading List
              </>
            )}
          </button>
        </div>

        {/* Exit Button */}
        <button
          onClick={() => setReaderModeActive(false)}
          className="p-1.5 rounded-lg border border-slate-400/30 hover:bg-slate-200/50 cursor-pointer"
          title="Exit Reader Mode"
        >
          <X size={14} />
        </button>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-6 py-8 select-text">
        {loading && (
          <div className="flex flex-col items-center justify-center h-full max-w-xl mx-auto py-20">
            <div className="w-10 h-10 border-4 border-[#3b82f6] border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-sm">Formatting reader contents...</p>
          </div>
        )}

        {error && (
          <div className="max-w-xl mx-auto py-20 text-center">
            <p className="text-red-500 text-sm font-semibold mb-4">{error}</p>
            <button
              onClick={loadReaderContent}
              className="px-4 py-2 rounded bg-[#3b82f6] text-white text-xs font-semibold cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}

        {article && (
          <article 
            className={`max-w-xl md:max-w-2xl mx-auto leading-relaxed text-left ${getFontFamilyClass()}`}
            style={{ fontSize: `${fontSize}px`, lineHeight: lineHeight }}
          >
            {/* Header info */}
            <header className="mb-8 border-b border-slate-500/20 pb-4 select-text">
              {article.siteName && (
                <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1">
                  {article.siteName}
                </div>
              )}
              <h1 className="text-2xl md:text-3xl font-bold mb-2 text-slate-900 dark:text-white leading-tight">
                {article.title}
              </h1>
              {article.byline && (
                <div className="text-xs italic text-slate-500 font-sans">
                  By {article.byline}
                </div>
              )}
            </header>

            {/* Main content body */}
            <div
              className={`prose ${theme === 'dark' ? 'prose-invert' : ''} max-w-full select-text`}
              dangerouslySetInnerHTML={{ __html: article.content }}
            />
          </article>
        )}
      </div>
    </div>
  );
};
