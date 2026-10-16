// Минимальные типы window.Telegram.WebApp (https://core.telegram.org/bots/webapps#initializing-mini-apps).
// Расширяем по мере необходимости (BackButton, MainButton, HapticFeedback — фаза 5).

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export interface TelegramWebAppInitDataUnsafe {
  query_id?: string;
  user?: TelegramWebAppUser;
  start_param?: string;
  auth_date?: number;
  hash?: string;
  chat_type?: string;
  chat_instance?: string;
}

export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  bottom_bar_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  section_separator_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
}

export interface TelegramWebApp {
  /** Сырой query string для отправки на сервер. Пустая строка вне Telegram. */
  initData: string;
  initDataUnsafe: TelegramWebAppInitDataUnsafe;
  version: string;
  platform: string;
  colorScheme: "light" | "dark";
  themeParams: TelegramThemeParams;
  isExpanded: boolean;
  ready(): void;
  expand(): void;
  close(): void;
  onEvent(eventType: "themeChanged", handler: () => void): void;
  offEvent(eventType: "themeChanged", handler: () => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}
