-- Начальная схема. Деньги — в минорных единицах (копейки), время — ISO 8601 в UTC.

CREATE TABLE households (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT 'Семья',
  timezone        TEXT NOT NULL DEFAULT 'Europe/Minsk',
  currency        TEXT NOT NULL DEFAULT 'BYN',
  report_weekly   INTEGER NOT NULL DEFAULT 1,
  report_monthly  INTEGER NOT NULL DEFAULT 1,
  report_target   TEXT NOT NULL DEFAULT 'group' CHECK (report_target IN ('group', 'private')),
  created_at      TEXT NOT NULL
);

CREATE TABLE members (
  telegram_id   INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households (id),
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at    TEXT NOT NULL
);
CREATE INDEX members_household ON members (household_id);

CREATE TABLE invites (
  code          TEXT PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households (id),
  created_by    INTEGER NOT NULL,
  expires_at    TEXT NOT NULL,
  used_by       INTEGER,
  used_at       TEXT
);

CREATE TABLE chats (
  chat_id       INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households (id),
  type          TEXT NOT NULL CHECK (type IN ('private', 'group', 'supergroup')),
  title         TEXT,
  created_at    TEXT NOT NULL
);
-- Одна общая группа на семью
CREATE UNIQUE INDEX chats_one_group_per_household ON chats (household_id) WHERE type != 'private';

CREATE TABLE categories (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households (id),
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  emoji         TEXT NOT NULL,
  color         TEXT NOT NULL,
  description   TEXT,
  sort_order    INTEGER NOT NULL,
  is_system     INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT,
  UNIQUE (household_id, code)
);

CREATE TABLE receipts (
  id                INTEGER PRIMARY KEY,
  household_id      INTEGER NOT NULL REFERENCES households (id),
  added_by          INTEGER NOT NULL,              -- кто прислал = кто заплатил
  chat_id           INTEGER NOT NULL,              -- откуда прислан
  message_id        INTEGER,                       -- сообщение-сводка бота
  store_name        TEXT,
  purchased_at      TEXT NOT NULL,
  total_minor       INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('photo', 'pdf', 'text', 'miniapp')),
  doc_type          TEXT NOT NULL CHECK (doc_type IN ('store_receipt', 'erip', 'online_order', 'manual')),
  erip_account      TEXT,
  status            TEXT NOT NULL CHECK (status IN ('processing', 'draft', 'confirmed', 'failed')),
  has_sum_mismatch  INTEGER NOT NULL DEFAULT 0,
  confidence        TEXT,                          -- 'low' | 'medium' | 'high'
  ai_model          TEXT,
  raw_json          TEXT,                          -- сырой ответ ИИ для отладки
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX receipts_household_date ON receipts (household_id, purchased_at);
CREATE INDEX receipts_household_member_date ON receipts (household_id, added_by, purchased_at);

-- Файлы чека в Telegram (альбом = несколько файлов). Сами файлы не храним.
CREATE TABLE receipt_files (
  id                INTEGER PRIMARY KEY,
  receipt_id        INTEGER NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  household_id      INTEGER NOT NULL,
  position          INTEGER NOT NULL,
  tg_file_id        TEXT NOT NULL,
  tg_file_unique_id TEXT NOT NULL,
  mime              TEXT NOT NULL,
  UNIQUE (household_id, tg_file_unique_id)
);
CREATE INDEX receipt_files_receipt ON receipt_files (receipt_id);

CREATE TABLE items (
  id               INTEGER PRIMARY KEY,
  receipt_id       INTEGER NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  name             TEXT NOT NULL,
  quantity         REAL NOT NULL DEFAULT 1,
  total_minor      INTEGER NOT NULL,               -- итог строки после скидки
  discount_minor   INTEGER NOT NULL DEFAULT 0,
  category_id      INTEGER NOT NULL REFERENCES categories (id),
  category_source  TEXT NOT NULL CHECK (category_source IN ('ai', 'rule', 'user'))
);
CREATE INDEX items_receipt ON items (receipt_id);
CREATE INDEX items_category ON items (category_id);

CREATE TABLE category_rules (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES households (id),
  match_type    TEXT NOT NULL CHECK (match_type IN ('item', 'store', 'erip_account')),
  pattern       TEXT NOT NULL,                     -- нормализованное значение
  category_id   INTEGER NOT NULL REFERENCES categories (id),
  hits          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (household_id, match_type, pattern)
);

-- Идемпотентность вебхука; чистится по cron
CREATE TABLE processed_updates (
  update_id  INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Склейка альбомов (media_group_id): части копятся здесь, обработка — одним заданием
CREATE TABLE media_groups (
  media_group_id     TEXT PRIMARY KEY,
  household_id       INTEGER NOT NULL,
  chat_id            INTEGER NOT NULL,
  added_by           INTEGER NOT NULL,
  status_message_id  INTEGER,
  created_at         TEXT NOT NULL
);

CREATE TABLE media_group_parts (
  media_group_id    TEXT NOT NULL,
  message_id        INTEGER NOT NULL,
  tg_file_id        TEXT NOT NULL,
  tg_file_unique_id TEXT NOT NULL,
  mime              TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (media_group_id, message_id)
);
