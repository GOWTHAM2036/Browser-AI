import { invoke } from '@tauri-apps/api/core';
import { fetch } from '@tauri-apps/plugin-http';

export interface ChatOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  onProgress?: (status: string) => void;
}

export interface AIProvider {
  id: string;
  name: string;
  type: 'local' | 'cloud';
  isAvailable(): Promise<boolean>;
  listModels(): Promise<string[]>;
  chat(messages: { role: string; content: string }[], options: ChatOptions): AsyncIterableIterator<string>;
}

// === SECURE KEYCHAIN HELPERS ===
export async function saveApiKey(providerId: string, apiKey: string): Promise<void> {
  try {
    await invoke('save_credential', { service: 'aria-ai-keys', username: providerId, secret: apiKey });
  } catch {
    localStorage.setItem(`aria_key_${providerId}`, apiKey);
  }
}

export async function getApiKey(providerId: string): Promise<string | null> {
  try {
    const key = await invoke<string>('get_credential', { service: 'aria-ai-keys', username: providerId });
    if (key) return key;
  } catch {}
  return localStorage.getItem(`aria_key_${providerId}`);
}

export async function deleteApiKey(providerId: string): Promise<void> {
  try {
    await invoke('delete_credential', { service: 'aria-ai-keys', username: providerId });
  } catch {}
  localStorage.removeItem(`aria_key_${providerId}`);
}

// Helper to parse SSE streams
async function* parseSSEResponse(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterableIterator<string> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;

        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const choice = data.choices?.[0];
            const content = choice?.delta?.content || choice?.text || '';
            if (content) yield content;
          } catch (e) {
            // Ignore parsing errors for partial lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// === OLLAMA PROVIDER ===
export class OllamaProvider implements AIProvider {
  id = 'ollama';
  name = 'Ollama';
  type: 'local' | 'cloud' = 'local';
  private baseUrl = 'http://localhost:11434';

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.models?.map((m: any) => m.name) || [];
    } catch {
      return [];
    }
  }

  async *chat(messages: { role: string; content: string }[], options: ChatOptions): AsyncIterableIterator<string> {
    const available = await this.listModels();
    
    // Resolve target model name
    let targetModel = (options.model || '').trim();
    if (!targetModel) {
      targetModel = available[0] || 'qwen2.5:latest';
    } else {
      const match = available.find(m => m === targetModel || m.startsWith(targetModel + ':') || targetModel.startsWith(m.split(':')[0]));
      if (match) {
        targetModel = match;
      }
    }

    // 1. Check if model is installed. If not, trigger download
    if (!available.includes(targetModel) && targetModel) {
      if (options.onProgress) options.onProgress(`Model ${targetModel} not installed. Pulling...`);
      try {
        const pullRes = await fetch(`${this.baseUrl}/api/pull`, {
          method: 'POST',
          body: JSON.stringify({ name: targetModel, stream: true })
        });
        
        if (pullRes.ok && pullRes.body) {
          const pullReader = pullRes.body.getReader();
          const decoder = new TextDecoder();
          let pullBuffer = '';
          
          while (true) {
            const { done, value } = await pullReader.read();
            if (done) break;
            pullBuffer += decoder.decode(value);
            const lines = pullBuffer.split('\n');
            pullBuffer = lines.pop() || '';
            for (const line of lines) {
              if (line.trim()) {
                const data = JSON.parse(line);
                if (data.completed && data.total) {
                  const pct = Math.round((data.completed / data.total) * 100);
                  if (options.onProgress) options.onProgress(`Downloading model: ${pct}%`);
                } else if (data.status) {
                  if (options.onProgress) options.onProgress(data.status);
                }
              }
            }
          }
        }
      } catch (e) {
        yield `[Error pulling model: ${e}]`;
        return;
      }
    }

    const cleanMessages = messages
      .filter(m => m && typeof m.content === 'string' && m.content.trim().length > 0)
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user'),
        content: m.content
      }));

    // 2. Run chat completion
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: targetModel,
        messages: cleanMessages,
        stream: true
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let detail = res.statusText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error) detail = parsed.error;
      } catch {}
      throw new Error(`Ollama chat error: ${detail}`);
    }

    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) {
              const data = JSON.parse(line);
              const content = data.message?.content || '';
              if (content) yield content;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
  }
}

// === LM STUDIO PROVIDER ===
export class LMStudioProvider implements AIProvider {
  id = 'lm_studio';
  name = 'LM Studio';
  type: 'local' | 'cloud' = 'local';
  private baseUrl = 'http://localhost:1234/v1';

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.data?.map((m: any) => m.id) || [];
    } catch {
      return [];
    }
  }

  async *chat(messages: { role: string; content: string }[], options: ChatOptions): AsyncIterableIterator<string> {
    let targetModel = (options.model || '').trim();
    if (!targetModel) {
      const models = await this.listModels();
      targetModel = models[0] || 'default';
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: targetModel,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let detail = res.statusText;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) detail = parsed.error.message;
        else if (parsed.error) detail = String(parsed.error);
      } catch {}
      throw new Error(`LM Studio chat error: ${detail}`);
    }

    if (res.body) {
      yield* parseSSEResponse(res.body.getReader());
    }
  }
}

// === OPENAI PROVIDER ===
export class OpenAIProvider implements AIProvider {
  id = 'openai';
  name = 'OpenAI';
  type: 'local' | 'cloud' = 'cloud';
  private defaultModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'];

  async isAvailable(): Promise<boolean> {
    const key = await getApiKey(this.id);
    return !!key;
  }

  async listModels(): Promise<string[]> {
    return this.defaultModels;
  }

  async *chat(messages: { role: string; content: string }[], options: ChatOptions): AsyncIterableIterator<string> {
    const key = options.apiKey || (await getApiKey(this.id));
    if (!key) throw new Error('OpenAI API Key not configured');

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: true
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI error: ${res.statusText} - ${errText}`);
    }

    if (res.body) {
      yield* parseSSEResponse(res.body.getReader());
    }
  }
}

// === ANTHROPIC PROVIDER ===
export class AnthropicProvider implements AIProvider {
  id = 'anthropic';
  name = 'Anthropic Claude';
  type: 'local' | 'cloud' = 'cloud';
  private defaultModels = ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-20240229'];

  async isAvailable(): Promise<boolean> {
    const key = await getApiKey(this.id);
    return !!key;
  }

  async listModels(): Promise<string[]> {
    return this.defaultModels;
  }

  async *chat(messages: { role: string; content: string }[], options: ChatOptions): AsyncIterableIterator<string> {
    const key = options.apiKey || (await getApiKey(this.id));
    if (!key) throw new Error('Anthropic API Key not configured');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'dangerously-allow-html': 'true'
      },
      body: JSON.stringify({
        model: options.model,
        messages: messages.filter(m => m.role !== 'system'),
        system: messages.find(m => m.role === 'system')?.content,
        max_tokens: 4096,
        stream: true
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic error: ${res.statusText} - ${errText}`);
    }

    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              try {
                const data = JSON.parse(trimmed.slice(6));
                if (data.type === 'content_block_delta') {
                  const content = data.delta?.text || '';
                  if (content) yield content;
                }
              } catch {}
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
  }
}

// === GEMINI PROVIDER ===
export class GeminiProvider implements AIProvider {
  id = 'gemini';
  name = 'Google Gemini';
  type: 'local' | 'cloud' = 'cloud';
  private defaultModels = ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'];

  async isAvailable(): Promise<boolean> {
    const key = await getApiKey(this.id);
    return !!key;
  }

  async listModels(): Promise<string[]> {
    return this.defaultModels;
  }

  async *chat(messages: { role: string; content: string }[], options: ChatOptions): AsyncIterableIterator<string> {
    const key = options.apiKey || (await getApiKey(this.id));
    if (!key) throw new Error('Gemini API Key not configured');

    const modelName = options.model;
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?key=${key}&alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        }))
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini error: ${res.statusText} - ${errText}`);
    }

    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              try {
                const data = JSON.parse(trimmed.slice(6));
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (text) yield text;
              } catch (e) {
                // Ignore parsing errors for incomplete lines
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
  }
}

// === CUSTOM OPENAI COMPATIBLE ===
export class CustomOpenAIProvider implements AIProvider {
  id = 'custom';
  name = 'Custom OpenAI-Compatible';
  type: 'local' | 'cloud' = 'cloud';

  async isAvailable(): Promise<boolean> {
    const key = await getApiKey(this.id);
    const baseUrl = localStorage.getItem('aria_custom_url');
    return !!key && !!baseUrl;
  }

  async listModels(): Promise<string[]> {
    const baseUrl = localStorage.getItem('aria_custom_url');
    const key = await getApiKey(this.id);
    if (!baseUrl) return [];
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {}
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.data?.map((m: any) => m.id) || [];
    } catch {
      return [];
    }
  }

  async *chat(messages: { role: string; content: string }[], options: ChatOptions): AsyncIterableIterator<string> {
    const key = options.apiKey || (await getApiKey(this.id));
    const baseUrl = options.baseUrl || localStorage.getItem('aria_custom_url');
    if (!baseUrl) throw new Error('Custom Base URL not configured');

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: true
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Custom OpenAI error: ${res.statusText} - ${errText}`);
    }

    if (res.body) {
      yield* parseSSEResponse(res.body.getReader());
    }
  }
}

// === OPENROUTER PROVIDER ===
export class OpenRouterProvider implements AIProvider {
  id = 'openrouter';
  name = 'OpenRouter (Free & Premium)';
  type: 'local' | 'cloud' = 'cloud';
  private defaultModels = [
    'openrouter/free',
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'openai/gpt-oss-20b:free',
    'nvidia/nemotron-3.5-lightning:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3-nano-30b-a3b:free',
    'z-ai/glm-5.2:free',
    'cohere/north-mini-code:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'deepseek/deepseek-r1:free',
    'deepseek/deepseek-chat:free',
    'qwen/qwen-2.5-coder-32b-instruct:free',
    'mistralai/mistral-small-24b-instruct-2501:free',
    'microsoft/phi-3-medium-128k-instruct:free'
  ];

  async isAvailable(): Promise<boolean> {
    const key = await getApiKey(this.id);
    return !!key;
  }

  async listModels(): Promise<string[]> {
    try {
      const key = await getApiKey(this.id);
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: key ? { Authorization: `Bearer ${key}` } : {}
      });
      if (!res.ok) return this.defaultModels;
      const data = await res.json();
      const freeModels = (data.data || [])
        .filter((m: any) => typeof m.id === 'string' && (m.id.endsWith(':free') || m.id === 'openrouter/free' || (m.pricing && m.pricing.prompt === '0')))
        .map((m: any) => m.id);
      const combined = ['openrouter/free', ...freeModels, ...this.defaultModels];
      return Array.from(new Set(combined));
    } catch {
      return this.defaultModels;
    }
  }

  async *chat(messages: { role: string; content: string }[], options: ChatOptions): AsyncIterableIterator<string> {
    const key = options.apiKey || (await getApiKey(this.id));
    if (!key) throw new Error('OpenRouter API Key not configured');

    let modelToUse = options.model || 'openrouter/free';
    // If model name is from a local provider (like 'gemma3:4b', 'llama3', etc. with no slash) or dead endpoint, fix to openrouter/free
    if (!modelToUse.includes('/') || modelToUse.includes('gemini-2.0-flash-exp')) {
      modelToUse = 'openrouter/free';
    }

    let res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'https://github.com/Browser-AI/ARIA',
        'X-Title': 'ARIA Browser AI'
      },
      body: JSON.stringify({
        model: modelToUse,
        messages,
        stream: true
      })
    });

    // If specific model returned 400 (e.g. invalid model ID) or 404, fallback to openrouter/free
    if (!res.ok && (res.status === 400 || res.status === 404) && modelToUse !== 'openrouter/free') {
      console.warn(`[OpenRouter] Model ${modelToUse} returned ${res.status}. Falling back to openrouter/free...`);
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'HTTP-Referer': 'https://github.com/Browser-AI/ARIA',
          'X-Title': 'ARIA Browser AI'
        },
        body: JSON.stringify({
          model: 'openrouter/free',
          messages,
          stream: true
        })
      });
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter error (${res.status}): ${res.statusText} - ${errText}`);
    }

    if (res.body) {
      yield* parseSSEResponse(res.body.getReader());
    }
  }
}

// === PROVIDER REGISTER ===
export const providers: AIProvider[] = [
  new OpenRouterProvider(),
  new OllamaProvider(),
  new LMStudioProvider(),
  new OpenAIProvider(),
  new AnthropicProvider(),
  new GeminiProvider(),
  new CustomOpenAIProvider()
];

export async function getActiveProvider(providerId: string): Promise<AIProvider | undefined> {
  return providers.find(p => p.id === providerId);
}
