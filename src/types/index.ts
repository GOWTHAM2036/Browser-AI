export interface Tab {
  id: string;
  url: string;
  title: string;
  position: number;
  pinned: boolean;
  loading: boolean;
  favicon?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  visited_at: number;
  visit_count: number;
}

export interface BookmarkFolder {
  id: string;
  name: string;
  parent_id?: string;
  created_at: number;
}

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  folder_id?: string;
  created_at: number;
}

export interface AgentStepItem {
  id: string;
  timestamp: string;
  actionType: string;
  target: string;
  result: string;
  status: 'success' | 'error' | 'pending' | 'info';
}

export interface AgentMessageData {
  goal: string;
  status: string;
  running: boolean;
  paused: boolean;
  currentStep: number;
  timeline: AgentStepItem[];
  logs: string[];
  result?: string | null;
}

export interface Message {
  id: string;
  tab_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  provider: string;
  model: string;
  created_at: number;
  messageType?: 'chat' | 'intel' | 'agent';
  agentData?: AgentMessageData;
}

export interface ReadingListItem {
  id: string;
  url: string;
  title: string;
  excerpt?: string;
  saved_at: number;
  read: boolean;
}

export interface AIProviderConfig {
  id: string;
  name: string;
  type: 'local' | 'cloud';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled: boolean;
}

export interface BrowserSettings {
  theme: 'light' | 'dark' | 'system';
  fontSize: number; // 12, 14, 16, 18 etc.
  sidebarPosition: 'left' | 'right';
  defaultSearchEngine: 'google' | 'duckduckgo' | 'brave' | 'custom';
  customSearchUrl?: string;
  homepage: string;
  startupBehavior: 'restore' | 'newtab';
  trackingProtection: boolean;
  aiProvider: string;
  aiModel: string;
}
