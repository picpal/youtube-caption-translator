import type { ApiKeyStatus } from '~/types/message';

const KEY = 'geminiApiKey';
const SAVED_AT = 'geminiApiKeySavedAt';

export function maskKey(key: string): string {
  if (key.length < 4) return '••••';
  return '••••' + key.slice(-4);
}

export async function saveApiKey(rawKey: string): Promise<{ maskedKey: string; savedAt: string }> {
  const key = rawKey.trim();
  if (key.length === 0) throw new Error('API key must not be empty');
  const savedAt = new Date().toISOString();
  await chrome.storage.local.set({ [KEY]: key, [SAVED_AT]: savedAt });
  return { maskedKey: maskKey(key), savedAt };
}

export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
  const record = await chrome.storage.local.get([KEY, SAVED_AT]);
  const key = record[KEY] as string | undefined;
  const savedAt = record[SAVED_AT] as string | undefined;
  if (!key || !savedAt) return { present: false };
  return { present: true, maskedKey: maskKey(key), savedAt };
}

export async function getApiKey(): Promise<string | null> {
  const record = await chrome.storage.local.get(KEY);
  return (record[KEY] as string | undefined) ?? null;
}

export async function deleteApiKey(): Promise<void> {
  await chrome.storage.local.remove([KEY, SAVED_AT]);
}
