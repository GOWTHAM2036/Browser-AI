import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useBrowserStore } from '../store/browserStore';
import { saveApiKey, getApiKey, deleteApiKey, providers, getActiveProvider } from '../services/ai';
import { dbClearHistory, dbClearTabs } from '../services/db';
import { Settings, Cpu, Palette, Shield, Keyboard, Check, AlertCircle, RefreshCw, Camera, Mic, Video, Volume2 } from 'lucide-react';

export const SettingsUI: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { settings, updateSettings } = useBrowserStore();

  const [activeTab, setActiveTab] = useState<'general' | 'ai' | 'appearance' | 'privacy' | 'shortcuts'>('general');
  const [notification, setNotification] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  // Auto-dismiss notifications
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // AI Connection Test State
  const [selectedProviderId, setSelectedProviderId] = useState(settings.aiProvider || 'duckduckgo');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState(settings.aiModel || '');
  
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testError, setTestError] = useState('');

  // Media Permissions Test State
  const [mediaTesting, setMediaTesting] = useState(false);
  const [mediaStatus, setMediaStatus] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = React.useRef<MediaStream | null>(null);

  const startMediaTest = async (mode: 'both' | 'video' | 'audio' = 'both') => {
    setMediaTesting(true);
    setMediaStatus(`Requesting ${mode === 'both' ? 'Camera & Microphone' : mode === 'video' ? 'Camera' : 'Microphone'} access...`);
    setMediaError(null);
    try {
      const constraints = {
        video: mode === 'both' || mode === 'video',
        audio: mode === 'both' || mode === 'audio'
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;
      if (videoRef.current && (mode === 'both' || mode === 'video')) {
        videoRef.current.srcObject = stream;
      }
      setMediaStatus(`${mode === 'both' ? 'Camera & Microphone' : mode === 'video' ? 'Camera' : 'Microphone'} access granted successfully!`);
    } catch (err: any) {
      const name = err.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || err.message?.includes('Permission denied')) {
        setMediaError('PERMISSION_DECLINED');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setMediaError('NO_DEVICE_FOUND');
      } else {
        setMediaError(err.message || String(err));
      }
      setMediaStatus(null);
      setMediaTesting(false);
    }
  };

  const stopMediaTest = () => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setMediaTesting(false);
    setMediaStatus(null);
    setMediaError(null);
  };

  const handleResetPermissions = async () => {
    try {
      stopMediaTest();
      await invoke('reset_media_permissions');
      setNotification({ type: 'success', message: 'Saved permission decisions reset! Click Test Camera & Mic to re-prompt.' });
      setMediaError(null);
      setMediaStatus('Permission cache cleared. Click "Test Camera & Mic" to request permission again.');
    } catch (e: any) {
      setNotification({ type: 'error', message: 'Failed to reset permissions: ' + (e.message || String(e)) });
    }
  };

  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Load API key when selected provider changes
  useEffect(() => {
    getApiKey(selectedProviderId).then(key => {
      setApiKeyInput(key || '');
    });
    
    if (selectedProviderId === 'custom') {
      setCustomUrlInput(localStorage.getItem('aria_custom_url') || '');
    }

    // Load models
    loadModelsForProvider(selectedProviderId);
  }, [selectedProviderId]);

  const loadModelsForProvider = async (providerId: string) => {
    const provider = await getActiveProvider(providerId);
    if (provider) {
      const models = await provider.listModels();
      setAvailableModels(models);
      if (models.length > 0) {
        const isCurrentValid = models.includes(selectedModel);
        const modelToSet = isCurrentValid ? selectedModel : models[0];
        setSelectedModel(modelToSet);
        updateSettings({ aiProvider: providerId, aiModel: modelToSet });
      }
    } else {
      setAvailableModels([]);
    }
  };

  const handleTestConnection = async () => {
    setTestStatus('testing');
    setTestError('');
    try {
      const provider = await getActiveProvider(selectedProviderId);
      if (!provider) throw new Error('Selected provider not found');

      // Save key temporarily to test
      if (apiKeyInput.trim()) {
        await saveApiKey(selectedProviderId, apiKeyInput.trim());
      } else {
        await deleteApiKey(selectedProviderId);
      }

      if (selectedProviderId === 'custom' && customUrlInput.trim()) {
        localStorage.setItem('aria_custom_url', customUrlInput.trim());
      }

      // Check availability and fetch models
      const ok = await provider.isAvailable();
      if (!ok) {
        throw new Error('Connection failed. Verify API keys or Base URL.');
      }

      const models = await provider.listModels();
      setAvailableModels(models);
      setTestStatus('success');

      // Save configuration globally
      updateSettings({
        aiProvider: selectedProviderId,
        aiModel: selectedModel || models[0] || ''
      });

    } catch (e: any) {
      setTestStatus('error');
      setTestError(e.message || 'Unknown error occurred.');
    }
  };

  const handleSaveAISettings = async () => {
    try {
      if (apiKeyInput.trim()) {
        await saveApiKey(selectedProviderId, apiKeyInput.trim());
      } else {
        await deleteApiKey(selectedProviderId);
      }

      if (selectedProviderId === 'custom') {
        localStorage.setItem('aria_custom_url', customUrlInput.trim());
      }

      updateSettings({
        aiProvider: selectedProviderId,
        aiModel: selectedModel
      });
      setNotification({ type: 'success', message: 'AI configuration saved successfully.' });
    } catch (e: any) {
      setNotification({ type: 'error', message: `Failed to save: ${e.message}` });
    }
  };

  const handleClearBrowsingData = async () => {
    if (confirm('Are you sure you want to clear all history and tab sessions?')) {
      await dbClearHistory();
      await dbClearTabs();
      setNotification({ type: 'success', message: 'Browsing data cleared successfully. Restarting session...' });
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    }
  };

  return (
    <div className="absolute inset-0 bg-[#0b0f19] z-[9999] flex flex-col text-slate-200 select-none">
      {/* Top Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-[#0f172a]">
        <div className="flex items-center gap-2 font-bold text-sm text-white">
          <Settings size={18} className="text-[#3b82f6]" />
          Aria Browser Settings
        </div>
        <button
          onClick={onClose}
          className="px-4 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs font-semibold cursor-pointer"
        >
          Close Settings
        </button>
      </div>

      {/* Toast Notification Banner */}
      {notification && (
        <div className={`px-6 py-2.5 text-xs font-semibold transition-all duration-300 flex items-center justify-between border-b ${
          notification.type === 'success' 
            ? 'bg-green-950/40 text-green-400 border-green-800/50' 
            : 'bg-red-950/40 text-red-400 border-red-800/50'
        }`}>
          <span>{notification.message}</span>
          <button 
            onClick={() => setNotification(null)}
            className="text-slate-400 hover:text-slate-200 cursor-pointer font-bold ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Container */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Navigation bar */}
        <div className="w-60 border-r border-slate-800 bg-slate-900/40 p-4 space-y-1">
          <button
            onClick={() => setActiveTab('general')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-lg transition-all text-left cursor-pointer ${
              activeTab === 'general' ? 'bg-[#1e293b] text-white font-medium shadow' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Settings size={14} />
            General
          </button>
          <button
            onClick={() => setActiveTab('ai')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-lg transition-all text-left cursor-pointer ${
              activeTab === 'ai' ? 'bg-[#1e293b] text-white font-medium shadow' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Cpu size={14} />
            AI Providers
          </button>
          <button
            onClick={() => setActiveTab('appearance')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-lg transition-all text-left cursor-pointer ${
              activeTab === 'appearance' ? 'bg-[#1e293b] text-white font-medium shadow' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Palette size={14} />
            Appearance
          </button>
          <button
            onClick={() => setActiveTab('privacy')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-lg transition-all text-left cursor-pointer ${
              activeTab === 'privacy' ? 'bg-[#1e293b] text-white font-medium shadow' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Shield size={14} />
            Privacy & Security
          </button>
          <button
            onClick={() => setActiveTab('shortcuts')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-lg transition-all text-left cursor-pointer ${
              activeTab === 'shortcuts' ? 'bg-[#1e293b] text-white font-medium shadow' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <Keyboard size={14} />
            Keyboard Shortcuts
          </button>
        </div>

        {/* Right Content Panel */}
        <div className="flex-1 overflow-y-auto p-8 max-w-3xl">
          {activeTab === 'general' && (
            /* ================= GENERAL ================= */
            <div className="space-y-6 text-left">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider mb-4">General Settings</h2>
              
              {/* Homepage */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">Browser Homepage</label>
                <input
                  type="text"
                  value={settings.homepage}
                  onChange={(e) => updateSettings({ homepage: e.target.value })}
                  placeholder="https://example.com"
                  className="bg-[#0b0f19] border border-slate-700 rounded-lg py-2 px-3 text-xs outline-none focus:border-blue-500 max-w-md"
                />
              </div>

              {/* Search Engine */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">Default Search Engine</label>
                <select
                  value={settings.defaultSearchEngine}
                  onChange={(e) => updateSettings({ defaultSearchEngine: e.target.value as any })}
                  className="bg-[#0b0f19] border border-slate-700 rounded-lg py-2 px-3 text-xs outline-none focus:border-blue-500 max-w-md cursor-pointer"
                >
                  <option value="google">Google</option>
                  <option value="duckduckgo">DuckDuckGo</option>
                  <option value="brave">Brave Search</option>
                </select>
              </div>

              {/* Startup Behavior */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">On Startup</label>
                <div className="space-y-2 mt-1">
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="radio"
                      name="startup"
                      checked={settings.startupBehavior === 'newtab'}
                      onChange={() => updateSettings({ startupBehavior: 'newtab' })}
                      className="cursor-pointer"
                    />
                    Open new tab page
                  </label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="radio"
                      name="startup"
                      checked={settings.startupBehavior === 'restore'}
                      onChange={() => updateSettings({ startupBehavior: 'restore' })}
                      className="cursor-pointer"
                    />
                    Restore session tabs
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'ai' && (
            /* ================= AI CONFIGS ================= */
            <div className="space-y-6 text-left">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider mb-4">AI Integration Setup</h2>

              {/* Provider Selector */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">Choose AI Provider</label>
                <select
                  value={selectedProviderId}
                  onChange={(e) => setSelectedProviderId(e.target.value)}
                  className="bg-[#0b0f19] border border-slate-700 rounded-lg py-2 px-3 text-xs outline-none focus:border-blue-500 max-w-md cursor-pointer"
                >
                  {providers.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              {/* Custom Base URL */}
              {selectedProviderId === 'custom' && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-slate-300">OpenAI-Compatible Base URL</label>
                  <input
                    type="text"
                    value={customUrlInput}
                    onChange={(e) => setCustomUrlInput(e.target.value)}
                    placeholder="https://localhost:1234/v1"
                    className="bg-[#0b0f19] border border-slate-700 rounded-lg py-2 px-3 text-xs outline-none focus:border-blue-500 max-w-md"
                  />
                </div>
              )}

              {/* API Key Input */}
              {selectedProviderId !== 'ollama' && selectedProviderId !== 'lm_studio' && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-slate-300">API Access Key</label>
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="Enter credential key..."
                    className="bg-[#0b0f19] border border-slate-700 rounded-lg py-2 px-3 text-xs outline-none focus:border-blue-500 max-w-md"
                  />
                  <span className="text-[10px] text-slate-500">
                    *Keys are saved securely in your native system keychain/credentials store, never in LocalStorage.
                  </span>
                </div>
              )}

              {/* Model Selector */}
              {availableModels.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-semibold text-slate-300">Select Model</label>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="bg-[#0b0f19] border border-slate-700 rounded-lg py-2 px-3 text-xs outline-none focus:border-blue-500 max-w-md cursor-pointer"
                  >
                    {availableModels.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Controls */}
              <div className="flex items-center gap-3 mt-4">
                <button
                  onClick={handleTestConnection}
                  disabled={testStatus === 'testing'}
                  className="px-4 py-2 bg-[#1e293b] hover:bg-slate-800 border border-slate-700 rounded-lg text-xs font-semibold cursor-pointer flex items-center gap-1.5 text-white"
                >
                  {testStatus === 'testing' && <RefreshCw size={12} className="animate-spin" />}
                  Test Connection
                </button>

                <button
                  onClick={handleSaveAISettings}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-semibold text-white cursor-pointer"
                >
                  Save Configuration
                </button>
              </div>

              {/* Test Status Banner */}
              {testStatus === 'success' && (
                <div className="flex items-center gap-2 p-3 bg-green-950/30 border border-green-900 rounded-lg max-w-md text-xs text-green-400">
                  <Check size={14} className="text-green-500" />
                  Connection succeeded! Model list refreshed.
                </div>
              )}

              {testStatus === 'error' && (
                <div className="flex items-start gap-2 p-3 bg-red-950/30 border border-red-900 rounded-lg max-w-md text-xs text-red-400">
                  <AlertCircle size={14} className="text-red-500 mt-0.5 shrink-0" />
                  <div>
                    <span className="font-bold block mb-0.5">Connection failed</span>
                    <span className="text-[10px] text-red-350">{testError}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'appearance' && (
            /* ================= APPEARANCE ================= */
            <div className="space-y-6 text-left">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider mb-4">Appearance Settings</h2>

              {/* Theme Selector */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">Theme Preference</label>
                <select
                  value={settings.theme}
                  onChange={(e) => updateSettings({ theme: e.target.value as any })}
                  className="bg-[#0b0f19] border border-slate-700 rounded-lg py-2 px-3 text-xs outline-none focus:border-blue-500 max-w-md cursor-pointer"
                >
                  <option value="light">Light Mode</option>
                  <option value="dark">Dark Mode</option>
                  <option value="system">System Preference</option>
                </select>
              </div>

              {/* Sidebar Alignment */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">AI Side Panel Position</label>
                <select
                  value={settings.sidebarPosition}
                  onChange={(e) => updateSettings({ sidebarPosition: e.target.value as any })}
                  className="bg-[#0b0f19] border border-slate-700 rounded-lg py-2 px-3 text-xs outline-none focus:border-blue-500 max-w-md cursor-pointer"
                >
                  <option value="left">Left Side</option>
                  <option value="right">Right Side</option>
                </select>
              </div>
            </div>
          )}

          {activeTab === 'privacy' && (
            /* ================= PRIVACY ================= */
            <div className="space-y-6 text-left">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider mb-4">Privacy & Security</h2>

              {/* Tracking protection */}
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="tracking"
                  checked={settings.trackingProtection}
                  onChange={(e) => updateSettings({ trackingProtection: e.target.checked })}
                  className="w-4 h-4 cursor-pointer"
                />
                <label htmlFor="tracking" className="text-xs font-semibold text-slate-350 cursor-pointer">
                  Enable Trackers and Ad Blocking Protection (Recommended)
                </label>
              </div>

              {/* Camera & Microphone Media Permissions */}
              <div className="flex flex-col gap-3 pt-4 border-t border-slate-800">
                <div className="flex items-center gap-2">
                  <Camera size={16} className="text-purple-400" />
                  <Mic size={16} className="text-blue-400" />
                  <label className="text-xs font-bold text-white">Camera & Microphone Access</label>
                </div>
                <p className="text-[10px] text-slate-400 leading-relaxed max-w-md">
                  Websites and web apps loaded in Aria can access your camera and microphone via WebRTC / MediaDevices APIs. Access is granted per site prompt on HTTPS origins.
                </p>

                {/* Media Hardware Tester */}
                <div className="p-3 bg-[#0b0f19] border border-slate-800 rounded-xl space-y-3 max-w-md">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
                      <Video size={13} className="text-emerald-400" /> Hardware Test
                    </span>
                    {!mediaTesting ? (
                      <button
                        onClick={() => startMediaTest('both')}
                        className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 rounded-lg text-[11px] font-semibold text-white cursor-pointer transition-all flex items-center gap-1"
                      >
                        <Camera size={12} /> Test Camera & Mic
                      </button>
                    ) : (
                      <button
                        onClick={stopMediaTest}
                        className="px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-[11px] font-semibold text-white cursor-pointer transition-all"
                      >
                        Stop Test
                      </button>
                    )}
                  </div>

                  {/* Video Live Preview Box */}
                  {mediaTesting && (
                    <div className="relative rounded-lg overflow-hidden bg-black border border-slate-700 aspect-video flex items-center justify-center">
                      <video
                        ref={videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 bg-black/70 px-2 py-1 rounded text-[10px] text-emerald-400 font-mono">
                        <Volume2 size={12} className="animate-pulse" /> Live Stream Active
                      </div>
                    </div>
                  )}

                  {mediaStatus && (
                    <div className="text-[10px] text-emerald-400 font-mono bg-emerald-950/30 p-2 rounded border border-emerald-900/40">
                      {mediaStatus}
                    </div>
                  )}

                  {mediaError && mediaError === 'PERMISSION_DECLINED' && (
                    <div className="p-3 bg-amber-950/30 border border-amber-800/60 rounded-lg text-amber-200 text-xs space-y-2">
                      <div className="font-bold flex items-center gap-1.5 text-amber-400">
                        <AlertCircle size={14} /> Camera / Mic Permission Declined
                      </div>
                      <p className="text-[11px] leading-relaxed text-amber-300">
                        Permission was declined when prompted. Click below to request permission again or enable access in Windows/OS Settings.
                      </p>
                      
                      <div className="flex items-center gap-2 pt-1 flex-wrap">
                        <button
                          onClick={handleResetPermissions}
                          className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-slate-950 rounded-lg text-[11px] font-bold cursor-pointer transition-all flex items-center gap-1"
                        >
                          <RefreshCw size={12} /> Reset Saved Permission & Re-prompt
                        </button>
                        <button
                          onClick={() => startMediaTest('video')}
                          className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg text-[11px] font-semibold cursor-pointer transition-all"
                        >
                          Camera Only
                        </button>
                        <button
                          onClick={() => startMediaTest('audio')}
                          className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg text-[11px] font-semibold cursor-pointer transition-all"
                        >
                          Mic Only
                        </button>
                      </div>

                      <div className="text-[10px] text-slate-400 border-t border-amber-900/50 pt-2 space-y-1">
                        <div className="font-bold text-slate-300">Windows OS Permission Reset:</div>
                        <div>1. Open Windows <b>Settings</b> → <b>Privacy & security</b> → <b>Camera</b> (and <b>Microphone</b>).</div>
                        <div>2. Ensure <i>"Let desktop apps access your camera"</i> is turned <b>ON</b>.</div>
                      </div>
                    </div>
                  )}

                  {mediaError && mediaError !== 'PERMISSION_DECLINED' && (
                    <div className="text-[10px] text-red-400 font-mono bg-red-950/30 p-2 rounded border border-red-900/40">
                      {mediaError}
                    </div>
                  )}
                </div>
              </div>

              {/* Clear data */}
              <div className="flex flex-col gap-2 pt-4 border-t border-slate-800">
                <label className="text-xs font-bold text-white">Clear Browsing Cache & History</label>
                <p className="text-[10px] text-slate-500 leading-normal max-w-md">
                  This action clears all browser search autocomplete lines, history entries, and active tab profiles.
                </p>
                <button
                  onClick={handleClearBrowsingData}
                  className="px-4 py-2 bg-red-650 hover:bg-red-550 border border-red-900 rounded-lg text-xs font-semibold text-white max-w-max cursor-pointer mt-1"
                >
                  Clear Browsing Data
                </button>
              </div>
            </div>
          )}

          {activeTab === 'shortcuts' && (
            /* ================= SHORTCUTS ================= */
            <div className="space-y-6 text-left">
              <h2 className="text-sm font-bold text-white uppercase tracking-wider mb-4">Keyboard Shortcuts</h2>
              
              <div className="border border-slate-850 rounded-xl overflow-hidden bg-slate-900/10">
                <table className="w-full text-xs text-slate-300">
                  <thead>
                    <tr className="bg-slate-900/50 border-b border-slate-800 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                      <th className="py-2.5 px-4 text-left">Command Action</th>
                      <th className="py-2.5 px-4 text-left">Keyboard Shortcut Mapping</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    <tr>
                      <td className="py-2.5 px-4">Create New Tab</td>
                      <td className="py-2.5 px-4"><kbd className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">Ctrl + T</kbd> or <kbd className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">Cmd + T</kbd></td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-4">Close Active Tab</td>
                      <td className="py-2.5 px-4"><kbd className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">Ctrl + W</kbd> or <kbd className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">Cmd + W</kbd></td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-4">Focus Omnibox Address Input</td>
                      <td className="py-2.5 px-4"><kbd className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">Ctrl + L</kbd> or <kbd className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">Cmd + L</kbd></td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-4">Reload Active Page</td>
                      <td className="py-2.5 px-4"><kbd className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">Ctrl + R</kbd> or <kbd className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">Cmd + R</kbd></td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-4">Toggle AI Assistant Sidebar</td>
                      <td className="py-2.5 px-4"><kbd className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">Ctrl + Shift + A</kbd> or <kbd className="border border-slate-700 bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">Cmd + Shift + A</kbd></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
