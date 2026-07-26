// Seeds the dev Chrome profile's Preferences file so our extension's action
// button starts pinned to the toolbar, before Chrome ever launches.
//
// Chrome only reads Preferences at process startup and only writes its
// current in-memory state back to disk at shutdown — patching the file
// while Chrome is running has no effect and gets silently overwritten on
// exit. This must run pre-launch, which is why it's only called from the
// "fresh spawn" branch of dev-chrome.mjs (never when reusing an already-
// running instance).
//
// Key: `extensions.pinned_extensions` (list of extension ID strings).
// Confirmed by inspecting an actual Chrome 150 profile's Preferences file:
// a profile with no pin/unpin history has no such key at all under
// `extensions` (Chrome only serializes it once it has a non-default value),
// so there was nothing to reverse-engineer from an existing example — this
// key name/shape is Chromium's long-standing `prefs::kPinnedExtensions`
// ("extensions.pinned_extensions"). Verified end-to-end for this task by
// seeding it pre-launch and confirming the toolbar screenshot shows the
// extension pinned (see dev-chrome-tooling-report.md).
import fs from 'node:fs';
import path from 'node:path';
import { PROFILE_DIR } from './config.mjs';

const PREFERENCES_PATH = path.join(PROFILE_DIR, 'Default', 'Preferences');

/**
 * @param {string} extensionId
 * @returns {{ seeded: boolean, alreadyPinned?: boolean, error?: string }}
 */
export function seedPinnedExtension(extensionId) {
  try {
    fs.mkdirSync(path.dirname(PREFERENCES_PATH), { recursive: true });

    let prefs = {};
    if (fs.existsSync(PREFERENCES_PATH)) {
      const raw = fs.readFileSync(PREFERENCES_PATH, 'utf8').trim();
      prefs = raw ? JSON.parse(raw) : {};
    }

    prefs.extensions ??= {};
    const pinned = new Set(prefs.extensions.pinned_extensions ?? []);
    const alreadyPinned = pinned.has(extensionId);
    pinned.add(extensionId);
    prefs.extensions.pinned_extensions = Array.from(pinned);

    fs.writeFileSync(PREFERENCES_PATH, JSON.stringify(prefs));
    return { seeded: true, alreadyPinned };
  } catch (err) {
    return { seeded: false, error: err.message };
  }
}

export const PIN_FALLBACK_INSTRUCTIONS_KO = [
  '확장 프로그램이 툴바에 자동으로 고정되지 않았습니다.',
  "Chrome 툴바 오른쪽의 퍼즐 아이콘(확장 프로그램 메뉴)을 클릭하세요.",
  "목록에서 'YouTube Play Assistant' 옆의 압정(📌) 아이콘을 클릭해 툴바에 고정하세요.",
  '고정 후에는 툴바의 아이콘을 바로 클릭해 사이드 패널을 열 수 있습니다.',
];
