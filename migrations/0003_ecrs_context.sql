-- Кто прислал фото с QR: после скачивания страницы отвечаем в тот же чат.
ALTER TABLE ecrs_jobs ADD COLUMN household_id INTEGER;
ALTER TABLE ecrs_jobs ADD COLUMN chat_id INTEGER;
ALTER TABLE ecrs_jobs ADD COLUMN added_by INTEGER;
ALTER TABLE ecrs_jobs ADD COLUMN status_message_id INTEGER;
ALTER TABLE ecrs_jobs ADD COLUMN source TEXT;
ALTER TABLE ecrs_jobs ADD COLUMN files_json TEXT;
