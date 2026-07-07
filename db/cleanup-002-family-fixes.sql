-- Cleanup 002 (2026-07-06): fix color-family mislabels found by a hue audit
-- (each ink's swatch hue compared against the family it was filed under).
-- Only clear-cut conflicts are fixed; judgment calls (teals filed as green,
-- olives as green, maroons as brown, hot pinks as red) are left as the team
-- filed them.
--
-- Run against BOTH databases:
--   npx wrangler d1 execute ink-inventory --remote --file=db/cleanup-002-family-fixes.sql
--   npx wrangler d1 execute ink-inventory --local  --file=db/cleanup-002-family-fixes.sql

-- 7730 is a green (#499661) but was filed under RED.
UPDATE inks SET color_family = 'GREEN', description = 'green'
WHERE pantone = '7730' AND color_family = 'RED';

-- 7710 is a teal (#00a7b6). One can was filed under YELLOW while the same
-- code already sits in BLUE (same 3.3 lb size) — merge quantities.
-- NOTE for the shop: if the physical can in the yellow section is actually a
-- yellow ink, its label was mistyped — check the can and re-add with the
-- right code if so.
UPDATE inks SET quantity = quantity + IFNULL(
  (SELECT quantity FROM inks WHERE pantone = '7710' AND color_family = 'YELLOW'), 0)
WHERE pantone = '7710' AND color_family = 'BLUE';
DELETE FROM inks WHERE pantone = '7710' AND color_family = 'YELLOW';

-- 7760 is an old gold (#90842c) but was filed under BLUE.
UPDATE inks SET color_family = 'YELLOW', description = 'gold'
WHERE pantone = '7760' AND color_family = 'BLUE';

-- 7770 is an olive brown (#625939) but was filed under BLUE.
UPDATE inks SET color_family = 'BROWN', description = 'olive brown'
WHERE pantone = '7770' AND color_family = 'BLUE';

-- 7706 / 7707 are the shop's WHITE and BLACK product inks whose item numbers
-- collide with real Pantone teals — so their swatches rendered teal. Rename so
-- the lookup uses honest white/black swatches (the numbers stay searchable).
UPDATE inks SET pantone = 'White 7706'
WHERE pantone = '7706' AND color_family = 'WHITE';
UPDATE inks SET pantone = 'Black 7707'
WHERE pantone = '7707' AND color_family = 'BLACK';

-- Audit trail.
INSERT INTO log (ts, user_email, action, pantone, changes) VALUES
  (datetime('now') || 'Z', '(cleanup script)', 'update', '7730',
   'family RED -> GREEN (swatch is green; hue audit)'),
  (datetime('now') || 'Z', '(cleanup script)', 'update', '7710',
   'merged YELLOW-filed can into BLUE row (teal color); qty now 3 — physical check recommended'),
  (datetime('now') || 'Z', '(cleanup script)', 'update', '7760',
   'family BLUE -> YELLOW (old gold)'),
  (datetime('now') || 'Z', '(cleanup script)', 'update', '7770',
   'family BLUE -> BROWN (olive brown)'),
  (datetime('now') || 'Z', '(cleanup script)', 'update', 'White 7706 / Black 7707',
   'renamed from 7706/7707: product item numbers collide with Pantone teals; now render honest white/black swatches');
