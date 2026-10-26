import { create } from 'zustand';
import {
  AgentExecutionState,
  globalAgentStateMachine
} from '../services/agent/executionStateMachine';

export interface AgentExecutionStoreState {
  executionState: AgentExecutionState;
  runId: string | null;
  msgId: string | null;
  tabId: string | null;
  goal: string | null;
  pendingAction: string | null;
  confirmationMessage: string | null;

  // Actions
  pause: () => boolean;
  resume: () => boolean;
  stop: () => boolean;
  respondConfirmation: (confirmed: boolean) => void;
  syncState: () => void;
  reset: () => void;
}

export const useAgentExecutionStore = create<AgentExecutionStoreState>((set) => {
  // Subscribe to state machine updates
  globalAgentStateMachine.subscribe((state) => {
    set({
      executionState: state,
      runId: globalAgentStateMachine.getRunId(),
      msgId: globalAgentStateMachine.getMsgId(),
      tabId: globalAgentStateMachine.getTabId(),
      goal: globalAgentStateMachine.getGoal(),
      pendingAction: globalAgentStateMachine.getPendingAction(),
      confirmationMessage: globalAgentStateMachine.getPendingConfirmation()?.message || null
    });
  });

  return {
    executionState: globalAgentStateMachine.getState(),
    runId: globalAgentStateMachine.getRunId(),
    msgId: globalAgentStateMachine.getMsgId(),
    tabId: globalAgentStateMachine.getTabId(),
    goal: globalAgentStateMachine.getGoal(),
    pendingAction: globalAgentStateMachine.getPendingAction(),
    confirmationMessage: globalAgentStateMachine.getPendingConfirmation()?.message || null,

    pause: () => globalAgentStateMachine.requestPause(),
    resume: () => globalAgentStateMachine.requestResume(),
    stop: () => globalAgentStateMachine.requestStop(),
    respondConfirmation: (confirmed: boolean) =>
      globalAgentStateMachine.respondToConfirmation(confirmed),
    syncState: () =>
      set({
        executionState: globalAgentStateMachine.getState(),
        runId: globalAgentStateMachine.getRunId(),
        msgId: globalAgentStateMachine.getMsgId(),
        tabId: globalAgentStateMachine.getTabId(),
        goal: globalAgentStateMachine.getGoal(),
        pendingAction: globalAgentStateMachine.getPendingAction(),
        confirmationMessage: globalAgentStateMachine.getPendingConfirmation()?.message || null
      }),
    reset: () => {
      globalAgentStateMachine.reset();
      set({
        executionState: 'idle',
        runId: null,
        msgId: null,
        tabId: null,
        goal: null,
        pendingAction: null,
        confirmationMessage: null
      });
    }
  };
});
