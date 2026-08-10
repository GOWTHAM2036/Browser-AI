import React from 'react';
import { Bug } from 'lucide-react';

interface DebugValidationResult {
  success: boolean;
  error?: string;
}

interface AgentDebugProps {
  validation: DebugValidationResult | null;
  execution: string;
  errors: string[];
  parsedJson: any;
  cleanedResponse: string;
  rawLlmResponse: string;
  onClear: () => void;
}

export const AgentDebug: React.FC<AgentDebugProps> = ({
  validation,
  execution,
  errors,
  parsedJson,
  cleanedResponse,
  rawLlmResponse,
  onClear
}) => {
  return (
    <div className="flex-1 flex flex-col min-h-0 space-y-3 overflow-y-auto pr-1">
      <div className="flex items-center justify-between border-b border-slate-800 pb-2">
        <div className="flex items-center gap-1.5">
          <Bug size={14} className="text-purple-400 animate-pulse" />
          <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">Agent Debugger</span>
        </div>
        <button
          onClick={onClear}
          className="text-[9px] text-slate-500 hover:text-slate-300 transition-all border border-slate-800 bg-[#0f172a] py-0.5 px-2 rounded cursor-pointer"
        >
          Clear Debug
        </button>
      </div>

      {/* Validation Result Status */}
      <div className="bg-[#0f172a]/70 border border-slate-800 rounded-xl p-3 flex flex-col gap-1.5">
        <span className="text-slate-500 text-[9px] font-semibold uppercase tracking-wider">Validation Status</span>
        {validation ? (
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase ${
              validation.success 
                ? 'bg-green-950 text-green-300 border border-green-800/40' 
                : 'bg-red-950 text-red-300 border border-red-800/40'
            }`}>
              {validation.success ? 'Passed' : 'Failed'}
            </span>
            {!validation.success && (
              <span className="text-red-400 text-[10px] font-medium leading-normal">
                {validation.error}
              </span>
            )}
          </div>
        ) : (
          <span className="text-slate-600 text-[10px]">No validation data. Start the agent first.</span>
        )}
      </div>

      {/* Action Execution Result */}
      <div className="bg-[#0f172a]/70 border border-slate-800 rounded-xl p-3 flex flex-col gap-1">
        <span className="text-slate-500 text-[9px] font-semibold uppercase tracking-wider">Execution Outcome</span>
        <span className="text-slate-200 text-[10px] font-mono leading-relaxed break-words">
          {execution || 'No action execution logged.'}
        </span>
      </div>

      {/* Session Error Log */}
      <div className="bg-[#0f172a]/70 border border-slate-800 rounded-xl p-3 flex flex-col gap-1.5">
        <span className="text-slate-500 text-[9px] font-semibold uppercase tracking-wider">Session Errors ({errors.length})</span>
        {errors.length === 0 ? (
          <span className="text-slate-600 text-[10px]">No errors encountered in this session.</span>
        ) : (
          <div className="max-h-32 overflow-y-auto space-y-1 font-mono text-[9px] text-red-400">
            {errors.map((err, idx) => (
              <div key={idx} className="border-b border-slate-900/40 pb-1 last:border-b-0">
                {err}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Parsed JSON */}
      <div className="bg-[#0f172a]/70 border border-slate-800 rounded-xl p-3 flex flex-col gap-1.5 min-h-[120px] flex-1">
        <span className="text-slate-500 text-[9px] font-semibold uppercase tracking-wider">Parsed JSON Action</span>
        {parsedJson ? (
          <pre className="flex-1 overflow-auto bg-slate-950/60 p-2 rounded border border-slate-800/50 font-mono text-[10px] text-emerald-400 select-text">
            {JSON.stringify(parsedJson, null, 2)}
          </pre>
        ) : (
          <span className="text-slate-650 text-[10px]">No parsed action data.</span>
        )}
      </div>

      {/* Cleaned Response */}
      <div className="bg-[#0f172a]/70 border border-slate-800 rounded-xl p-3 flex flex-col gap-1.5 min-h-[120px] flex-1">
        <span className="text-slate-500 text-[9px] font-semibold uppercase tracking-wider">Cleaned Response</span>
        {cleanedResponse ? (
          <pre className="flex-1 overflow-auto bg-slate-950/60 p-2 rounded border border-slate-800/50 font-mono text-[10px] text-slate-300 whitespace-pre-wrap select-text">
            {cleanedResponse}
          </pre>
        ) : (
          <span className="text-slate-650 text-[10px]">No cleaned response data.</span>
        )}
      </div>

      {/* Raw LLM Response */}
      <div className="bg-[#0f172a]/70 border border-slate-800 rounded-xl p-3 flex flex-col gap-1.5 min-h-[120px] flex-1">
        <span className="text-slate-500 text-[9px] font-semibold uppercase tracking-wider">Raw LLM Response</span>
        {rawLlmResponse ? (
          <pre className="flex-1 overflow-auto bg-slate-950/60 p-2 rounded border border-slate-800/50 font-mono text-[10px] text-slate-400 whitespace-pre-wrap select-text">
            {rawLlmResponse}
          </pre>
        ) : (
          <span className="text-slate-650 text-[10px]">No raw LLM data.</span>
        )}
      </div>
    </div>
  );
};
