import { useCallback, useEffect, useState } from 'react';
import { sendMessage } from '~/lib/messaging';
import type { ApiKeyStatus, GeminiTestResult } from '~/types/message';

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'success'; savedAt: string }
  | { kind: 'error'; message: string };

export type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; latencyMs: number; model: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'rate_limit'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'unknown'; message: string };

export function useApiKey() {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });

  const refresh = useCallback(async () => {
    const next = await sendMessage({ type: 'GET_API_KEY_STATUS' });
    setStatus(next);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'local') return;
      if ('geminiApiKey' in changes || 'geminiApiKeySavedAt' in changes) {
        refresh();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refresh]);

  const save = useCallback(async (key: string): Promise<boolean> => {
    setSaveState({ kind: 'saving' });
    const res = await sendMessage({ type: 'SAVE_API_KEY', payload: { key } });
    if (res.ok) {
      setStatus(res.status);
      const savedAt = res.status.present ? res.status.savedAt : new Date().toISOString();
      setSaveState({ kind: 'success', savedAt });
      setTestState({ kind: 'idle' });
      return true;
    } else {
      setSaveState({ kind: 'error', message: res.error });
      return false;
    }
  }, []);

  const remove = useCallback(async () => {
    await sendMessage({ type: 'DELETE_API_KEY' });
    setStatus({ present: false });
    setSaveState({ kind: 'idle' });
    setTestState({ kind: 'idle' });
  }, []);

  const test = useCallback(async () => {
    setTestState({ kind: 'testing' });
    const res: GeminiTestResult = await sendMessage({ type: 'TEST_API_KEY' });
    if (res.ok) {
      setTestState({ kind: 'ok', latencyMs: res.latencyMs, model: res.model });
    } else {
      setTestState({ kind: res.reason, message: res.message });
    }
  }, []);

  return { status, saveState, testState, save, remove, test, refresh };
}
