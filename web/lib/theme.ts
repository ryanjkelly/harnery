/**
 * Light, dark, or follow the operating system. The choice lives in this
 * browser's localStorage; `THEME_INIT_SCRIPT` runs in <head> before the first
 * paint so a page never flashes the wrong theme, and `setThemePreference`
 * applies a change at once and tells other open tabs.
 */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "harnery.theme";
export const THEME_EVENT = "harnery:theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** Inline script for <head>: resolve the stored choice and set the `dark` class. */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var m=window.matchMedia("(prefers-color-scheme: dark)");function a(){var p=null;try{p=localStorage.getItem(k)}catch(e){}var d=p==="dark"||(p!=="light"&&m.matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light"}a();m.addEventListener("change",a);window.addEventListener("storage",function(e){if(e.key===k)a()});window.addEventListener(${JSON.stringify(THEME_EVENT)},a)}catch(e){}})();`;

export function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage blocked: the change still applies to this page below.
    const dark =
      preference === "dark" ||
      (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    return;
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}
