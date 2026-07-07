-- Cleanup 004 (2026-07-07): remove the PINK color family (added in cleanup 003,
-- decided against). Any ink that made it into PINK goes back to RED, then the
-- table is rebuilt with the family constraint without PINK.
--
-- Run against BOTH databases:
--   npx wrangler d1 execute ink-inventory --remote --file=db/cleanup-004-remove-pink.sql
--   npx wrangler d1 execute ink-inventory --local  --file=db/cleanup-004-remove-pink.sql

UPDATE inks SET color_family = 'RED' WHERE color_family = 'PINK';

CREATE TABLE inks_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pantone       TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  color_family  TEXT    NOT NULL CHECK (color_family IN
                  ('RED','ORANGE','YELLOW','GREEN','BLUE','PURPLE','WHITE','BLACK','GREY','BROWN')),
  weight        REAL,
  quantity      INTEGER NOT NULL DEFAULT 1,
  location      TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'In Stock'
                        CHECK (status IN ('In Stock','Used Up')),
  date_added    TEXT,
  updated_at    TEXT
);

INSERT INTO inks_new
  SELECT id, pantone, description, color_family, weight, quantity, location, status, date_added, updated_at
  FROM inks;

DROP TABLE inks;
ALTER TABLE inks_new RENAME TO inks;

CREATE INDEX IF NOT EXISTS idx_inks_family ON inks(color_family);
CREATE INDEX IF NOT EXISTS idx_inks_status ON inks(status);

INSERT INTO log (ts, user_email, action, pantone, changes) VALUES
  (datetime('now') || 'Z', '(cleanup script)', 'update', '(schema)',
   'removed the PINK color family (any PINK inks returned to RED)');
