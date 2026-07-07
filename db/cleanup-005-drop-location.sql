-- Cleanup 005 (2026-07-07): drop the location column — the team decided not
-- to track shelf locations. No data lost: zero rows had a location set.
--
-- Run against BOTH databases:
--   npx wrangler d1 execute ink-inventory --remote --file=db/cleanup-005-drop-location.sql
--   npx wrangler d1 execute ink-inventory --local  --file=db/cleanup-005-drop-location.sql

CREATE TABLE inks_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pantone       TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  color_family  TEXT    NOT NULL CHECK (color_family IN
                  ('RED','ORANGE','YELLOW','GREEN','BLUE','PURPLE','WHITE','BLACK','GREY','BROWN')),
  weight        REAL,
  quantity      INTEGER NOT NULL DEFAULT 1,
  status        TEXT    NOT NULL DEFAULT 'In Stock'
                        CHECK (status IN ('In Stock','Used Up')),
  date_added    TEXT,
  updated_at    TEXT
);

INSERT INTO inks_new
  SELECT id, pantone, description, color_family, weight, quantity, status, date_added, updated_at
  FROM inks;

DROP TABLE inks;
ALTER TABLE inks_new RENAME TO inks;

CREATE INDEX IF NOT EXISTS idx_inks_family ON inks(color_family);
CREATE INDEX IF NOT EXISTS idx_inks_status ON inks(status);

INSERT INTO log (ts, user_email, action, pantone, changes) VALUES
  (datetime('now') || 'Z', '(cleanup script)', 'update', '(schema)',
   'dropped the location column (unused; team decided not to track shelf locations)');
