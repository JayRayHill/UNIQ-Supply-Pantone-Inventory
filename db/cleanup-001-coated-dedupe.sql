-- Cleanup 001 (2026-07-06): every ink in the shop is COATED, so "U" (uncoated)
-- suffixes from the original sheet were mislabels. Rename them to the plain
-- coated code, then merge rows that are now exact duplicates.
--
-- Run against BOTH databases:
--   npx wrangler d1 execute ink-inventory --remote --file=db/cleanup-001-coated-dedupe.sql
--   npx wrangler d1 execute ink-inventory --local  --file=db/cleanup-001-coated-dedupe.sql

-- 1) Strip the uncoated suffix from the five mislabeled codes.
UPDATE inks SET pantone = '165'  WHERE pantone = '165 U';
UPDATE inks SET pantone = '186'  WHERE pantone = '186U';
UPDATE inks SET pantone = '2035' WHERE pantone = '2035 U';
UPDATE inks SET pantone = '2039' WHERE pantone = '2039 U';
UPDATE inks SET pantone = '2092' WHERE pantone = '2092 U';

-- 2) Merge EXACT duplicates (same code + family + weight + description):
--    keep the oldest row, give it the summed quantity, drop the rest.
--    Rows with the same code but DIFFERENT can weights (e.g. 186 in 1 lb and
--    3.3 lb cans, 1225, 7527) are real separate cans and are kept.
UPDATE inks SET quantity = (
  SELECT SUM(i2.quantity) FROM inks i2
  WHERE i2.pantone = inks.pantone
    AND i2.color_family = inks.color_family
    AND IFNULL(i2.weight, -1) = IFNULL(inks.weight, -1)
    AND i2.description = inks.description
)
WHERE id IN (
  SELECT MIN(id) FROM inks
  GROUP BY pantone, color_family, IFNULL(weight, -1), description
  HAVING COUNT(*) > 1
);

DELETE FROM inks WHERE id NOT IN (
  SELECT MIN(id) FROM inks
  GROUP BY pantone, color_family, IFNULL(weight, -1), description
);

-- 3) Leave an audit trail.
INSERT INTO log (ts, user_email, action, pantone, changes) VALUES
  (datetime('now') || 'Z', '(cleanup script)', 'update', '165 U/186U/2035 U/2039 U/2092 U',
   'renamed uncoated-suffixed codes to coated base codes (all shop inks are coated)'),
  (datetime('now') || 'Z', '(cleanup script)', 'update', '2035/2039/212',
   'merged exact duplicate rows into single rows with quantity 2');
