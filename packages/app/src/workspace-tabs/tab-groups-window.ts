import { isWeb } from "@/constants/platform";
const WINDOW_KEY = "paseo-tab-group-window";
const HANDOFF_KEY = "paseo-tab-group-window-handoff";
export function getTabGroupWindow(): {
  key: string;
  groupId: string | null;
  excludedKeys?: string[];
} {
  if (!isWeb) return { key: "main", groupId: null };
  const saved = sessionStorage.getItem(WINDOW_KEY);
  if (saved) return JSON.parse(saved);
  const handoff = localStorage.getItem(HANDOFF_KEY);
  if (handoff) {
    const data = JSON.parse(handoff);
    if (Date.now() - data.at < 20000) {
      localStorage.removeItem(HANDOFF_KEY);
      const value = { key: data.key, groupId: data.groupId, excludedKeys: data.excludedKeys };
      sessionStorage.setItem(WINDOW_KEY, JSON.stringify(value));
      return value;
    }
  }
  const value = { key: "main", groupId: null };
  sessionStorage.setItem(WINDOW_KEY, JSON.stringify(value));
  return value;
}
export function prepareTabGroupWindow(groupId: string, excludedKeys: string[]): string {
  const key = crypto.randomUUID();
  localStorage.setItem(HANDOFF_KEY, JSON.stringify({ key, groupId, excludedKeys, at: Date.now() }));
  return key;
}
