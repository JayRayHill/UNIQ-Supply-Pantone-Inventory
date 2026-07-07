-- Ink Inventory schema for Cloudflare D1 (SQLite).
-- Run once before seed.sql — see README "Database setup".

-- The inventory itself. One row per ink can (or batch of identical cans).
CREATE TABLE IF NOT EXISTS inks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Pantone code stored as TEXT, always. "7706", "165 U", "Rhodamine Red",
  -- "P-115-5" all live here exactly as typed — no coercion possible in SQL.
  pantone       TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  -- One of the eleven families; enforced by the CHECK and by server validation.
  color_family  TEXT    NOT NULL CHECK (color_family IN
                  ('RED','ORANGE','YELLOW','GREEN','BLUE','PURPLE','PINK','WHITE','BLACK','GREY','BROWN')),
  weight        REAL,                          -- lbs; NULL = unknown
  quantity      INTEGER NOT NULL DEFAULT 1,    -- number of cans
  location      TEXT    NOT NULL DEFAULT '',   -- shelf/bin; being backfilled via the app
  status        TEXT    NOT NULL DEFAULT 'In Stock'
                        CHECK (status IN ('In Stock','Used Up')),
  date_added    TEXT,                          -- ISO date; NULL for the original import
  updated_at    TEXT                           -- ISO timestamp of last edit
);

CREATE INDEX IF NOT EXISTS idx_inks_family ON inks(color_family);
CREATE INDEX IF NOT EXISTS idx_inks_status ON inks(status);

-- Audit trail: one row per write (add / update). Never shown in the UI —
-- it's just there if we ever need to answer "who changed this and when?".
CREATE TABLE IF NOT EXISTS log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,                   -- ISO timestamp
  user_email  TEXT NOT NULL DEFAULT '(unknown)',
  action      TEXT NOT NULL,                   -- 'add' | 'update'
  pantone     TEXT NOT NULL,
  changes     TEXT NOT NULL DEFAULT ''
);
