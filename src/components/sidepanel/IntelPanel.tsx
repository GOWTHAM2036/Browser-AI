import React from 'react';
import { BookOpen, Globe, ChevronDown, Check, RefreshCw } from 'lucide-react';
import { marked } from 'marked';

interface IntelPanelProps {
  intelResult: string;
  intelLoading: boolean;
  targetLang: string;
  setTargetLang: (lang: string) => void;
  showLangDropdown: boolean;
  setShowLangDropdown: (show: boolean) => void;
  onSummarize: () => void;
  onTranslate: () => void;
  onExtractKeyPoints: () => void;
  languages: { code: string; label: string }[];
}

export const IntelPanel: React.FC<IntelPanelProps> = ({
  intelResult,
  intelLoading,
  targetLang,
  setTargetLang,
  showLangDropdown,
  setShowLangDropdown,
  onSummarize,
  onTranslate,
  onExtractKeyPoints,
  languages
}) => {
  return (
    <div className="flex-1 flex flex-col min-h-0 space-y-4">
      {/* Quick Actions */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={onSummarize}
          disabled={intelLoading}
          className="flex items-center justify-center gap-2 bg-[#1e293b] hover:bg-slate-700 text-slate-200 py-2.5 rounded-xl text-xs font-semibold border border-slate-800 transition-all cursor-pointer"
        >
          <BookOpen size={14} className="text-blue-400" />
          Summarize
        </button>
        <button
          onClick={onExtractKeyPoints}
          disabled={intelLoading}
          className="flex items-center justify-center gap-2 bg-[#1e293b] hover:bg-slate-700 text-slate-200 py-2.5 rounded-xl text-xs font-semibold border border-slate-800 transition-all cursor-pointer"
        >
          <Check size={14} className="text-green-400" />
          Key Points
        </button>
      </div>

      <div className="relative">
        <button
          onClick={onTranslate}
          disabled={intelLoading}
          className="w-full flex items-center justify-center gap-2 bg-[#1e293b] hover:bg-slate-700 text-slate-200 py-2.5 rounded-xl text-xs font-semibold border border-slate-800 transition-all cursor-pointer"
        >
          <Globe size={14} className="text-purple-400" />
          Translate to {targetLang}
        </button>
        <button
          onClick={() => setShowLangDropdown(!showLangDropdown)}
          className="absolute right-0 top-0 h-full px-3 flex items-center justify-center text-slate-500 hover:text-slate-300 transition-colors border-l border-slate-800"
        >
          <ChevronDown size={14} />
        </button>

        {showLangDropdown && (
          <div className="absolute top-full mt-1 w-full bg-[#1e293b] border border-slate-800 rounded-xl shadow-2xl z-20 py-1 max-h-48 overflow-y-auto">
            {languages.map((lang) => (
              <button
                key={lang.code}
                onClick={() => {
                  setTargetLang(lang.code);
                  setShowLangDropdown(false);
                }}
                className={`w-full text-left px-4 py-2 text-xs transition-colors hover:bg-slate-800 ${
                  targetLang === lang.code ? 'text-blue-400 bg-slate-800/50' : 'text-slate-300'
                }`}
              >
                {lang.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Result Area */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Intelligence Report</span>
          {intelLoading && <RefreshCw size={12} className="animate-spin text-blue-500" />}
        </div>
        <div className="flex-1 bg-slate-950/40 border border-slate-800/60 rounded-2xl p-4 overflow-y-auto text-sm leading-relaxed text-slate-300 prose prose-invert prose-sm max-w-none scrollbar-thin">
          {!intelResult && !intelLoading ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-600 opacity-50 text-center px-4">
              <RefreshCw size={24} className="mb-2 opacity-20" />
              <p>Select an action above to analyze the current page.</p>
            </div>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: marked.parse(intelResult) }} />
          )}
        </div>
      </div>
    </div>
  );
};
