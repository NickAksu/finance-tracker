import type { TelegramThemeParams, TelegramWebApp } from "../telegram";

/** WebApp SDK, если страница открыта внутри Telegram (initData не пустой). */
export function getWebApp(): TelegramWebApp | null {
  const webApp = window.Telegram?.WebApp;
  return webApp && webApp.initData ? webApp : null;
}

// themeParams Telegram → наши CSS-переменные (их же использует Tailwind через @theme в index.css).
const THEME_VARS: [cssVar: string, param: keyof TelegramThemeParams][] = [
  ["--tg-bg", "bg_color"],
  ["--tg-text", "text_color"],
  ["--tg-hint", "hint_color"],
  ["--tg-link", "link_color"],
  ["--tg-button", "button_color"],
  ["--tg-button-text", "button_text_color"],
  ["--tg-secondary-bg", "secondary_bg_color"],
];

/**
 * Переносит тему Telegram в CSS-переменные на <html>. Отсутствующие параметры не задаются —
 * тогда работают светлые/тёмные значения по умолчанию из index.css.
 */
export function applyTelegramTheme(webApp: TelegramWebApp): void {
  const root = document.documentElement;
  for (const [cssVar, param] of THEME_VARS) {
    const value = webApp.themeParams[param];
    if (value) root.style.setProperty(cssVar, value);
    else root.style.removeProperty(cssVar);
  }
  root.dataset.theme = webApp.colorScheme;
  root.style.colorScheme = webApp.colorScheme;
}

/**
 * Номер чека из deep link:
 * - `start_param` вида `r_123` (Direct Link `t.me/<bot>/<app>?startapp=r_123` из группы);
 * - путь `/r/123` (кнопка web_app в личном чате открывает `${PUBLIC_URL}/r/123`).
 */
export function getReceiptIdFromLaunch(startParam: string | undefined, pathname: string): number | null {
  const fromStart = startParam ? /^r_(\d+)$/.exec(startParam) : null;
  const fromPath = /^\/r\/(\d+)\/?$/.exec(pathname);
  const raw = fromStart?.[1] ?? fromPath?.[1];
  if (!raw) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
