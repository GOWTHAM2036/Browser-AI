import React, { useState } from 'react';
import { 
  Send, 
  RefreshCw, 
  Copy, 
  Check, 
  Sparkles, 
  BookOpen, 
  Globe, 
  Play, 
  Pause, 
  StopCircle, 
  ChevronDown, 
  ChevronUp, 
  Terminal, 
  Bot,
  Zap
} from 'lucide-react';
import { Message } from '../../types';
import { marked } from 'marked';

interface SidePanelChatProps {
  messages: Message[];
  inputValue: string;
  setInputValue: (val: string) => void;
  isGenerating: boolean;
  isAgentRunning: boolean;
  onSendMessage: (text?: string) => Promise<void>;
  onPauseAgent: (msgId: string) => void;
  onResumeAgent: (msgId: string) => void;
  onStopAgent: (msgId: string) => void;
  onClearHistory: () => void;
  onCopyMessage: (text: string, id: string) => void;
  copiedId: string | null;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  providerName: string;
}

export const SidePanelChat: React.FC<SidePanelChatProps> = ({
  messages,
  inputValue,
  setInputValue,
  isGenerating,
  isAgentRunning,
  onSendMessage,
  onPauseAgent,
  onResumeAgent,
  onStopAgent,
  onClearHistory,
  onCopyMessage,
  copiedId,
  messagesEndRef,
  providerName
}) => {
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});

  const toggleLogs = (msgId: string) => {
    setExpandedLogs(prev => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  const handleQuickChip = (text: string) => {
    setInputValue(text);
    onSendMessage(text);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden text-slate-200 select-none">
      {/* Chat Messages Feed */}
      <div className="flex-1 overflow-y-auto pr-1 space-y-4 mb-3 scrollbar-thin select-text">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-4 p-4 text-center">
            <div className="p-4 rounded-2xl bg-gradient-to-b from-purple-900/30 to-slate-900/60 border border-purple-800/40 shadow-xl">
              <Bot size={36} className="text-purple-400 animate-pulse" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white mb-1">Aria Intelligent Assistant</h3>
              <p className="text-xs text-slate-400 max-w-[260px] leading-relaxed">
                Ask a question, request page intelligence, or instruct me to navigate & perform tasks.
              </p>
            </div>

            {/* Quick Action Suggestion Chips */}
            <div className="grid grid-cols-2 gap-2 w-full max-w-[280px] pt-2">
              <button
                onClick={() => handleQuickChip('Summarize this page')}
                className="flex items-center gap-2 p-2.5 bg-slate-900/80 hover:bg-slate-800 border border-slate-800 rounded-xl text-[11px] font-medium text-slate-300 transition-all text-left group cursor-pointer"
              >
                <BookOpen size={14} className="text-blue-400 group-hover:scale-110 transition-transform" />
                <span>Summarize Page</span>
              </button>

              <button
                onClick={() => handleQuickChip('Extract key points from this page')}
                className="flex items-center gap-2 p-2.5 bg-slate-900/80 hover:bg-slate-800 border border-slate-800 rounded-xl text-[11px] font-medium text-slate-300 transition-all text-left group cursor-pointer"
              >
                <Zap size={14} className="text-amber-400 group-hover:scale-110 transition-transform" />
                <span>Key Points</span>
              </button>

              <button
                onClick={() => handleQuickChip('Translate this page to Spanish')}
                className="flex items-center gap-2 p-2.5 bg-slate-900/80 hover:bg-slate-800 border border-slate-800 rounded-xl text-[11px] font-medium text-slate-300 transition-all text-left group cursor-pointer"
              >
                <Globe size={14} className="text-emerald-400 group-hover:scale-110 transition-transform" />
                <span>Translate</span>
              </button>

              <button
                onClick={() => handleQuickChip('Search on this page and click login')}
                className="flex items-center gap-2 p-2.5 bg-slate-900/80 hover:bg-slate-800 border border-slate-800 rounded-xl text-[11px] font-medium text-slate-300 transition-all text-left group cursor-pointer"
              >
                <Sparkles size={14} className="text-purple-400 group-hover:scale-110 transition-transform" />
                <span>Agent Task</span>
              </button>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const isUser = msg.role === 'user';
            const isAgent = msg.messageType === 'agent' && msg.agentData;

            if (isUser) {
              return (
                <div key={msg.id} className="flex flex-col items-end">
                  <div className="max-w-[90%] rounded-2xl px-3.5 py-2.5 text-xs shadow-md bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-br-none leading-relaxed">
                    {msg.content}
                  </div>
                  <span className="text-[9px] text-slate-500 font-bold uppercase mt-1 px-1 tracking-tight">
                    You
                  </span>
                </div>
              );
            }

            // Embedded Agent Card
            if (isAgent && msg.agentData) {
              const { goal, status, running, paused, currentStep, timeline, logs, result } = msg.agentData;
              const showLogs = expandedLogs[msg.id] || false;

              return (
                <div key={msg.id} className="flex flex-col items-start w-full">
                  <div className="w-full rounded-2xl p-3.5 bg-[#0f172a] border border-purple-800/40 shadow-xl rounded-bl-none space-y-3">
                    {/* Header Badge & Action Controls */}
                    <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                      <div className="flex items-center gap-2">
                        <div className="p-1 rounded-md bg-purple-950/60 border border-purple-700/40">
                          <Bot size={14} className="text-purple-400" />
                        </div>
                        <span className="text-xs font-semibold text-purple-200">
                          Browser Agent
                        </span>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider ${
                          running ? (paused ? 'bg-amber-950 text-amber-300 border border-amber-800/50' : 'bg-purple-950 text-purple-300 border border-purple-800/50 animate-pulse') : 'bg-slate-800 text-slate-400'
                        }`}>
                          {running ? (paused ? 'Paused' : 'Executing') : 'Finished'}
                        </span>
                      </div>

                      {/* Interactive Controls */}
                      {running && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => paused ? onResumeAgent(msg.id) : onPauseAgent(msg.id)}
                            className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-amber-400 border border-slate-700 transition-all cursor-pointer"
                            title={paused ? "Resume Task" : "Pause Task"}
                          >
                            {paused ? <Play size={11} fill="currentColor" /> : <Pause size={11} fill="currentColor" />}
                          </button>
                          <button
                            onClick={() => onStopAgent(msg.id)}
                            className="p-1 rounded bg-red-950/80 hover:bg-red-900 text-red-300 border border-red-800/50 transition-all cursor-pointer"
                            title="Stop Task"
                          >
                            <StopCircle size={11} fill="currentColor" />
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Goal */}
                    <div className="text-xs text-slate-200 font-medium bg-slate-950/50 p-2 rounded-lg border border-slate-800/60">
                      <span className="text-slate-500 font-mono text-[10px] uppercase block mb-0.5">Task Goal</span>
                      {goal}
                    </div>

                    {/* Live Status */}
                    {status && (
                      <div className="flex items-center gap-2 text-[11px] text-slate-300">
                        {running && !paused && <RefreshCw size={12} className="animate-spin text-purple-400" />}
                        <span className="font-mono text-purple-300 truncate">{status}</span>
                        {currentStep > 0 && (
                          <span className="ml-auto text-[9px] font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
                            Step {currentStep}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Timeline Feed */}
                    {timeline && timeline.length > 0 && (
                      <div className="space-y-2 border-t border-slate-800/60 pt-2 max-h-44 overflow-y-auto scrollbar-thin">
                        {timeline.map((item) => (
                          <div key={item.id} className="flex items-start gap-2 text-[10px] bg-slate-950/30 p-2 rounded-lg border border-slate-900">
                            <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold font-mono uppercase tracking-wider ${
                              item.actionType === 'click' ? 'bg-purple-950 text-purple-300 border border-purple-800/40' :
                              item.actionType === 'type' ? 'bg-blue-950 text-blue-300 border border-blue-800/40' :
                              item.actionType === 'navigate' ? 'bg-sky-950 text-sky-300 border border-sky-800/40' :
                              item.actionType === 'done' ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/40' :
                              'bg-slate-800 text-slate-300'
                            }`}>
                              {item.actionType}
                            </span>
                            <span className="text-slate-300 font-mono flex-1 truncate">
                              {item.target || item.result}
                            </span>
                            <span className={`w-1.5 h-1.5 rounded-full mt-1 ${
                              item.status === 'success' ? 'bg-emerald-500' :
                              item.status === 'error' ? 'bg-red-500' : 'bg-amber-500 animate-ping'
                            }`} />
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Final Result Card */}
                    {result && (
                      <div className="bg-gradient-to-r from-emerald-950/40 to-slate-900 p-2.5 rounded-xl border border-emerald-700/50 text-xs text-emerald-200">
                        <div className="font-semibold text-emerald-400 text-[10px] uppercase mb-0.5 tracking-wider">Final Result</div>
                        <div className="leading-relaxed">{result}</div>
                      </div>
                    )}

                    {/* Technical Logs Accordion */}
                    {logs && logs.length > 0 && (
                      <div className="border-t border-slate-800/60 pt-2">
                        <button
                          onClick={() => toggleLogs(msg.id)}
                          className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 font-mono transition-colors"
                        >
                          <Terminal size={10} />
                          <span>{showLogs ? 'Hide Technical Logs' : `Show Technical Logs (${logs.length})`}</span>
                          {showLogs ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                        </button>
                        {showLogs && (
                          <div className="mt-2 p-2 bg-slate-950 rounded-lg text-[9px] font-mono text-slate-400 max-h-32 overflow-y-auto space-y-1 border border-slate-900">
                            {logs.map((log, i) => (
                              <div key={i} className="border-b border-slate-900/50 pb-0.5">{log}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <span className="text-[9px] text-slate-500 font-mono mt-1 px-1 uppercase tracking-tight">
                    {msg.model || 'Agent'}
                  </span>
                </div>
              );
            }

            // Standard Markdown / Intelligence Assistant Response
            return (
              <div key={msg.id} className="flex flex-col items-start max-w-[95%]">
                <div className="rounded-2xl px-3.5 py-2.5 text-xs shadow-md bg-[#1e293b] text-slate-200 rounded-bl-none border border-slate-800/80 leading-relaxed">
                  <div 
                    className="prose prose-invert prose-xs max-w-none break-words leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: marked.parse(msg.content || '...') }}
                  />
                </div>
                <div className="flex items-center gap-2 mt-1 px-1">
                  <span className="text-[9px] text-slate-500 font-mono uppercase tracking-tight">
                    {msg.model || 'Aria AI'}
                  </span>
                  <button
                    onClick={() => onCopyMessage(msg.content, msg.id)}
                    className="text-slate-600 hover:text-slate-400 transition-colors cursor-pointer"
                  >
                    {copiedId === msg.id ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} />}
                  </button>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Single Unified Chat Input */}
      <div className="relative pt-1">
        <div className="relative flex items-center bg-[#0f172a] border border-slate-800 rounded-2xl focus-within:border-purple-600 focus-within:ring-2 focus-within:ring-purple-600/20 transition-all shadow-xl">
          <textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSendMessage();
              }
            }}
            placeholder="Ask anything or state a goal (e.g., 'Summarize page' or 'Click search')..."
            className="w-full bg-transparent px-3.5 py-3 pr-12 text-xs text-slate-100 placeholder-slate-500 focus:outline-none resize-none min-h-[44px] max-h-32 scrollbar-none"
            rows={1}
          />
          <button
            onClick={() => onSendMessage()}
            disabled={!inputValue.trim() || isGenerating || isAgentRunning}
            className={`absolute right-2.5 bottom-2.5 p-2 rounded-xl transition-all cursor-pointer ${
              inputValue.trim() && !isGenerating && !isAgentRunning
                ? 'bg-purple-600 text-white hover:bg-purple-500 shadow-lg shadow-purple-900/30'
                : 'bg-slate-800/60 text-slate-600 cursor-not-allowed'
            }`}
          >
            {isGenerating || isAgentRunning ? (
              <RefreshCw size={14} className="animate-spin text-purple-300" />
            ) : (
              <Send size={14} />
            )}
          </button>
        </div>

        <div className="flex items-center justify-between mt-2 px-1 text-[10px]">
          <button
            onClick={onClearHistory}
            className="text-slate-500 hover:text-red-400 font-semibold uppercase tracking-wider transition-colors cursor-pointer"
          >
            Clear Chat
          </button>
          <span className="text-slate-500 font-mono">
            {providerName}
          </span>
        </div>
      </div>
    </div>
  );
};
