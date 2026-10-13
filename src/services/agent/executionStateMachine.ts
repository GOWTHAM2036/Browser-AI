import { AgentAction } from './actions';

export type AgentExecutionState =
  | 'idle'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'completed'
  | 'error';

export const VALID_TRANSITIONS: Record<AgentExecutionState, readonly AgentExecutionState[]> = {
  idle: ['running'],
  running: ['pausing', 'paused', 'stopping', 'completed', 'error'],
  pausing: ['paused', 'stopping', 'error'],
  paused: ['running', 'stopping'],
  stopping: ['idle', 'completed', 'error'],
  completed: ['running', 'idle'],
  error: ['running', 'idle']
};

export function canTransition(from: AgentExecutionState, to: AgentExecutionState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Checks if an action is financial, destructive, or consequential,
 * requiring explicit user confirmation before proceeding.
 */
export function isConsequentialAction(
  action: AgentAction,
  targetName?: string
): { isConsequential: boolean; reason: string } {
  const dangerousPatterns = [
    /\b(buy|purchase|checkout|pay|payment|order|place\s+order)\b/i,
    /\b(delete|remove|destroy|drop|wipe|erase|terminate)\b/i,
    /\b(cancel\s+subscription|unsubscribe)\b/i,
    /\b(transfer|send\s+money|wire)\b/i,
    /\b(change\s+password|delete\s+account)\b/i
  ];

  let testStr = '';
  if ('text' in action && action.text) testStr += ' ' + action.text;
  if ('url' in action && action.url) testStr += ' ' + action.url;
  if ('key' in action && action.key) testStr += ' ' + action.key;
  if (targetName) testStr += ' ' + targetName;

  for (const pattern of dangerousPatterns) {
    if (pattern.test(testStr)) {
      return {
        isConsequential: true,
        reason: `Consequential action detected (${pattern.source}). User confirmation recommended.`
      };
    }
  }

  return { isConsequential: false, reason: '' };
}

export class AgentExecutionStateMachine {
  private state: AgentExecutionState = 'idle';
  private runId: string | null = null;
  private msgId: string | null = null;
  private tabId: string | null = null;
  private goal: string | null = null;
  private pendingAction: string | null = null;
  private abortController: AbortController | null = null;
  private resumeResolver: (() => void) | null = null;
  private listeners = new Set<(state: AgentExecutionState, prev: AgentExecutionState) => void>();
  private pendingConfirmation: {
    message: string;
    resolve: (confirmed: boolean) => void;
  } | null = null;

  getState(): AgentExecutionState {
    return this.state;
  }

  getRunId(): string | null {
    return this.runId;
  }

  getMsgId(): string | null {
    return this.msgId;
  }

  getTabId(): string | null {
    return this.tabId;
  }

  getGoal(): string | null {
    return this.goal;
  }

  getPendingAction(): string | null {
    return this.pendingAction;
  }

  getSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  isPaused(): boolean {
    return this.state === 'paused';
  }

  isPausing(): boolean {
    return this.state === 'pausing';
  }

  isRunning(): boolean {
    return this.state === 'running';
  }

  isStopping(): boolean {
    return this.state === 'stopping';
  }

  isAborted(): boolean {
    return !!this.abortController?.signal.aborted || this.state === 'stopping' || this.state === 'idle';
  }

  setPendingAction(action: string | null): void {
    this.pendingAction = action;
    this.notify(this.state);
  }

  startRun(runId: string, msgId: string, tabId: string, goal: string): boolean {
    if (!canTransition(this.state, 'running')) {
      console.warn(`[STATE_MACHINE] Cannot start run: Invalid transition from '${this.state}' to 'running'`);
      return false;
    }

    this.runId = runId;
    this.msgId = msgId;
    this.tabId = tabId;
    this.goal = goal;
    this.pendingAction = 'Initializing agent run...';
    this.abortController = new AbortController();
    this.resumeResolver = null;
    this.pendingConfirmation = null;

    this.transitionTo('running');
    return true;
  }

  requestPause(): boolean {
    if (this.state === 'running') {
      this.transitionTo('pausing');
      this.setPendingAction('Pausing at next safe boundary...');
      return true;
    }
    if (this.state === 'pausing' || this.state === 'paused') {
      return true;
    }
    return false;
  }

  confirmPaused(): void {
    if (this.state === 'pausing' || canTransition(this.state, 'paused')) {
      this.transitionTo('paused');
      this.setPendingAction('Agent paused. Page is fully interactive.');
    }
  }

  requestResume(): boolean {
    if (!canTransition(this.state, 'running')) {
      console.warn(`[STATE_MACHINE] Cannot resume: Invalid transition from '${this.state}' to 'running'`);
      return false;
    }

    this.transitionTo('running');
    this.setPendingAction('Resuming execution: re-evaluating page...');

    if (this.resumeResolver) {
      const resolve = this.resumeResolver;
      this.resumeResolver = null;
      resolve();
    }
    return true;
  }

  requestStop(): boolean {
    if (this.state === 'idle') return false;
    if (this.state === 'stopping') return true;

    if (canTransition(this.state, 'stopping')) {
      this.transitionTo('stopping');
      this.setPendingAction('Stopping agent and cleaning up...');

      // Abort active controller
      this.abortController?.abort();

      // Unblock any pause await
      if (this.resumeResolver) {
        const resolve = this.resumeResolver;
        this.resumeResolver = null;
        resolve();
      }

      // Reject confirmation
      if (this.pendingConfirmation) {
        this.pendingConfirmation.resolve(false);
        this.pendingConfirmation = null;
      }
      return true;
    }
    return false;
  }

  confirmStopped(): void {
    if (canTransition(this.state, 'idle')) {
      this.transitionTo('idle');
    }
    this.cleanup();
  }

  finishRun(success: boolean, _resultText?: string): void {
    const targetState: AgentExecutionState = success ? 'completed' : 'error';
    if (canTransition(this.state, targetState)) {
      this.transitionTo(targetState);
    } else if (canTransition(this.state, 'idle')) {
      this.transitionTo('idle');
    }
    this.cleanup();
  }

  /**
   * Safely pauses the loop until resume is triggered or abort is requested.
   */
  async waitForResume(signal?: AbortSignal | null): Promise<boolean> {
    if (this.state === 'pausing') {
      this.confirmPaused();
    }

    if (this.state !== 'paused') {
      return !this.isAborted();
    }

    return new Promise<boolean>((resolve) => {
      const activeSignal = signal || this.abortController?.signal;

      const onAbort = () => {
        if (activeSignal) activeSignal.removeEventListener('abort', onAbort);
        resolve(false);
      };

      if (activeSignal?.aborted) {
        return resolve(false);
      }

      if (activeSignal) {
        activeSignal.addEventListener('abort', onAbort);
      }

      this.resumeResolver = () => {
        if (activeSignal) activeSignal.removeEventListener('abort', onAbort);
        resolve(!activeSignal?.aborted && !this.isAborted());
      };
    });
  }

  async requestUserConfirmation(message: string): Promise<boolean> {
    this.requestPause();
    this.confirmPaused();
    this.setPendingAction(`Confirmation required: ${message}`);

    return new Promise<boolean>((resolve) => {
      this.pendingConfirmation = { message, resolve };
    });
  }

  respondToConfirmation(confirmed: boolean): void {
    if (this.pendingConfirmation) {
      const { resolve } = this.pendingConfirmation;
      this.pendingConfirmation = null;
      resolve(confirmed);
      if (confirmed) {
        this.requestResume();
      } else {
        this.setPendingAction('Action declined by user');
      }
    }
  }

  getPendingConfirmation(): { message: string } | null {
    return this.pendingConfirmation ? { message: this.pendingConfirmation.message } : null;
  }

  reset(): void {
    this.state = 'idle';
    this.cleanup();
    this.notify('idle');
  }

  subscribe(listener: (state: AgentExecutionState, prev: AgentExecutionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private transitionTo(newState: AgentExecutionState): void {
    const prev = this.state;
    this.state = newState;
    this.notify(prev);
  }

  private cleanup(): void {
    this.runId = null;
    this.pendingAction = null;
    this.abortController = null;
    this.resumeResolver = null;
    this.pendingConfirmation = null;
  }

  private notify(prev: AgentExecutionState): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state, prev);
      } catch (e) {
        console.error('[STATE_MACHINE] Listener error:', e);
      }
    }
  }
}

export const globalAgentStateMachine = new AgentExecutionStateMachine();
