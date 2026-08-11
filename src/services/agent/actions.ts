export type AgentAction =
  | { action: 'navigate'; url: string; target?: 'current_tab' | 'new_tab' }
  | { action: 'click'; element_id: string }
  | { action: 'type'; element_id: string; text: string }
  | { action: 'press'; element_id?: string; key: string }
  | { action: 'select'; element_id: string; value: string }
  | { action: 'scroll'; direction?: 'up' | 'down'; amount?: number }
  | { action: 'activate_tab'; tab_id?: string; index?: number }
  | { action: 'wait'; ms?: number }
  | { action: 'done'; reason: string }
  | { action: 'fail'; reason: string };

const actionSet = new Set<string>([
  'navigate',
  'click',
  'type',
  'press',
  'press_key',
  'select',
  'scroll',
  'activate_tab',
  'new_tab',
  'wait',
  'done',
  'fail'
]);

export function validateAgentAction(value: unknown): { success: true; data: AgentAction } | { success: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    console.log(`[AGENT ACTIONS] VALIDATION_FAIL: Action must be a JSON object, got: ${typeof value}`);
    return { success: false, error: 'Action must be a JSON object' };
  }
  const raw = { ...(value as Record<string, unknown>) };
  
  if (typeof raw.action !== 'string' || !actionSet.has(raw.action)) {
    console.log(`[AGENT ACTIONS] VALIDATION_FAIL: Unsupported action: ${String(raw.action)}`);
    return { success: false, error: `Unsupported or missing action: ${String(raw.action)}` };
  }

  // Alias/normalize press_key -> press
  if (raw.action === 'press_key') {
    console.log(`[AGENT ACTIONS] NORMALIZE: press_key → press (key=${raw.key})`);
    raw.action = 'press';
  }

  // Alias/normalize new_tab -> navigate with target="new_tab"
  if (raw.action === 'new_tab') {
    console.log(`[AGENT ACTIONS] NORMALIZE: new_tab → navigate target=new_tab (url=${raw.url})`);
    raw.action = 'navigate';
    raw.target = 'new_tab';
  }

  // Normalize done.result -> done.reason
  if (raw.action === 'done' && !raw.reason && typeof raw.result === 'string') {
    console.log(`[AGENT ACTIONS] NORMALIZE: done.result → done.reason`);
    raw.reason = raw.result;
  }

  const hasText = (name: string) => typeof raw[name] === 'string' && (raw[name] as string).trim().length > 0;

  switch (raw.action) {
    case 'click':
      if (!hasText('element_id')) return { success: false, error: 'click action requires element_id' };
      break;
    case 'type':
      if (!hasText('element_id') || !hasText('text')) return { success: false, error: 'type action requires element_id and text' };
      break;
    case 'press':
      if (!hasText('key')) return { success: false, error: 'press action requires key' };
      break;
    case 'select':
      if (!hasText('element_id') || !hasText('value')) return { success: false, error: 'select action requires element_id and value' };
      break;
    case 'navigate':
      if (!hasText('url')) return { success: false, error: 'navigate action requires url' };
      break;
    case 'done':
      if (!hasText('reason')) return { success: false, error: 'done action requires reason' };
      break;
    case 'fail':
      if (!hasText('reason')) return { success: false, error: 'fail action requires reason' };
      break;
  }

  console.log(`[AGENT ACTIONS] VALIDATED action=${raw.action}`);
  return { success: true, data: raw as unknown as AgentAction };
}

