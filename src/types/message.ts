export type ApiKeyStatus =
  | { present: false }
  | { present: true; maskedKey: string; savedAt: string };

export type GeminiTestResult =
  | { ok: true; latencyMs: number; model: string }
  | { ok: false; reason: 'unauthorized' | 'rate_limit' | 'network' | 'unknown'; message: string };

export type AppMessage =
  | { type: 'SAVE_API_KEY'; payload: { key: string } }
  | { type: 'GET_API_KEY_STATUS' }
  | { type: 'DELETE_API_KEY' }
  | { type: 'TEST_API_KEY' };

export type AppResponseMap = {
  SAVE_API_KEY: { ok: true; status: ApiKeyStatus } | { ok: false; error: string };
  GET_API_KEY_STATUS: ApiKeyStatus;
  DELETE_API_KEY: { ok: true };
  TEST_API_KEY: GeminiTestResult;
};

export type AppResponse<T extends AppMessage['type']> = AppResponseMap[T];
