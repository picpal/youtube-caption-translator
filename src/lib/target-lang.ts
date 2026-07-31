// The translation TARGET language — a pipeline setting, not a panel display
// preference (background reads it per job), which is why it lives apart
// from panel-prefs. One global value, edited from both the panel's 번역
// 언어 select and the Options page's 기본 번역 언어 select — both write
// this same key.
export const TARGET_LANG_STORAGE_KEY = 'translationTargetLang';

export type TargetLang = 'ko' | 'en' | 'ja' | 'zh';

export const TARGET_LANGS: readonly TargetLang[] = ['ko', 'en', 'ja', 'zh'];
export const DEFAULT_TARGET_LANG: TargetLang = 'ko';

/** UI labels (the panel/Options UI itself stays Korean). */
export const TARGET_LANG_LABELS: Record<TargetLang, string> = {
  ko: '한국어',
  en: '영어',
  ja: '일본어',
  zh: '중국어',
};

/** English language names, for embedding in Gemini prompts. */
export const TARGET_LANG_NAMES: Record<TargetLang, string> = {
  ko: 'Korean',
  en: 'English',
  ja: 'Japanese',
  zh: 'Chinese (Simplified)',
};

export async function getTargetLang(): Promise<TargetLang> {
  const record = await chrome.storage.local.get(TARGET_LANG_STORAGE_KEY);
  const raw = record[TARGET_LANG_STORAGE_KEY];
  return TARGET_LANGS.includes(raw as TargetLang) ? (raw as TargetLang) : DEFAULT_TARGET_LANG;
}

export async function saveTargetLang(lang: TargetLang): Promise<void> {
  await chrome.storage.local.set({ [TARGET_LANG_STORAGE_KEY]: lang });
}
