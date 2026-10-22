-- Очередь электронных чеков mch.ecrs.by. Страницу скачивает домашний телефон.

CREATE TABLE ecrs_jobs (
  id           INTEGER PRIMARY KEY,
  uid          TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'done', 'failed')),
  html         TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  lease_until  TEXT
);
CREATE INDEX ecrs_jobs_claim ON ecrs_jobs (status, lease_until, id);
CREATE INDEX ecrs_jobs_uid ON ecrs_jobs (uid);
