import type { AppMessage, AppResponse } from '~/types/message';

export async function sendMessage<T extends AppMessage['type']>(
  msg: Extract<AppMessage, { type: T }>,
): Promise<AppResponse<T>> {
  return chrome.runtime.sendMessage(msg) as Promise<AppResponse<T>>;
}
