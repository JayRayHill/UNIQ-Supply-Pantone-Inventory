# Ink Inventory

An internal web app for the print shop that makes our ~320 leftover Pantone inks
**visible, searchable, and editable** — so designers can suggest an on-hand ink when
it's close enough to a customer's color, and the team can update inventory from the app.

**Stack: Cloudflare Pages + Pages Functions + D1 (SQLite).** The original Google Sheet
was a one-time import (`db/seed.sql`); the app is now the single source of truth.
No Google connection, no frameworks, no build step.

---

## What's in this repo

| Path | Role |
|------|------|
| `public/index.html` | The page (single-page app). |
| `public/styles.css` | All styling. Vanilla CSS, design tokens up top. |
| `public/app.js` | All client logic: filters, sort, search, swatches, add/edit modal, CIEDE2000 closest-match. |
| `public/pantone-data.js` | Bundled Pantone *Solid Coated 2024* hex lookup (3,219 colors) — swatches work offline. |
| `functions/api/inventory.js` | `GET /api/inventory` — read endpoint. |
| `functions/api/inks.js` | `POST` (add) / `PUT` (update) / `DELETE` — the single validated write path. Deletes are permanent but the full row is written to the audit log first. |
| `functions/api/_db.js` | Shared server helpers: validation, snapshot, audit log, Access gate. |
| `db/schema.sql` | D1 tables: `inks` + `log` (audit trail). |
| `db/seed.sql` | One-time import of the 320 inks from "Ink Inv.xlsx" (2026-07-06). |
| `db/cleanup-001-coated-dedupe.sql` | Post-import cleanup (already applied): renamed mislabeled `U` codes to coated base codes, merged 3 exact duplicate rows → 317 inks. |
| `db/cleanup-002-family-fixes.sql` | Hue audit fixes (already applied): 7730→GREEN, 7760→YELLOW, 7770→BROWN, 7710 merge, White 7706 / Black 7707 renames → 316 inks. |
| `db/cleanup-003-add-pink-family.sql` | Added a PINK family (table rebuild; superseded by 004). |
| `db/cleanup-004-remove-pink.sql` | Removed the PINK family again (already applied). |
| `wrangler.toml` | Local-dev config + D1 binding declaration. |

> **Honesty note on colors:** Pantone publishes no official sRGB values. The bundled
> table comes from a community copy of the *Solid Coated 2024* book (Lab values,
> converted with the standard D50→D65 Bradford adaptation) — good for "is this close?"
> decisions, not proofing. All our inks are coated. Unresolvable codes (e.g. CMYK-guide
> `P-115-5`) show a neutral **"no preview"** swatch; the app never invents a color.
> Verified against the import: **316 of 320 inks** get a swatch.

---

## One-time setup

Prereqs: the repo is connected to a Cloudflare Pages project (git integration), and
you have Node installed locally.

### 1. Pages build settings

In the Pages project → **Settings → Build**:
- Framework preset: **None**
- Build command: *(leave empty)*
- Build output directory: **`public`**

### 2. Log in to wrangler (Cloudflare's CLI)

```bash
cd "Ink Inventory App"
npx wrangler login        # opens browser, authorize your Cloudflare account
```

### 3. Create the database and load the data

```bash
# Create the D1 database (prints a database_id — paste it into wrangler.toml)
npx wrangler d1 create ink-inventory

# Create the tables, then import the 320 inks (remote = the real database)
npx wrangler d1 execute ink-inventory --remote --file=db/schema.sql
npx wrangler d1 execute ink-inventory --remote --file=db/seed.sql

# Sanity check — should print 320 and the family counts
npx wrangler d1 execute ink-inventory --remote \
  --command "SELECT color_family, COUNT(*) n FROM inks GROUP BY color_family ORDER BY n DESC"
```

### 4. Bind the database to the Pages project

Dashboard → **Workers & Pages → (this project) → Settings → Bindings → Add**:
- Type: **D1 database**
- Variable name: **`DB`** (exactly — the code reads `env.DB`)
- Database: **ink-inventory**

Then redeploy (Deployments → Retry, or just push a commit). Done — the app is live.

### 5. Lock it down with Cloudflare Access (do this before sharing the URL)

The app has no login of its own. Until you gate it, anyone with the URL can view AND
edit. In the Cloudflare dashboard:

1. **Zero Trust → Access → Applications → Add an application → Self-hosted**
2. Application domain: your `*.pages.dev` domain (and any custom domain you attach)
3. Policy: *Allow* → *Emails ending in* `@yourdomain.com`
4. (Optional) Identity provider: Google, so the team logs in with their work account.

Two bonuses once Access is on:
- The audit log records **who** made each change (Access passes the verified email
  to the API via the `Cf-Access-Authenticated-User-Email` header).
- Set the Pages environment variable **`REQUIRE_ACCESS=true`** (Settings → Variables)
  and the API will hard-refuse any request that didn't come through Access.

---

## Local development

```bash
# One-time: create the LOCAL copy of the database (a throwaway SQLite file)
npx wrangler d1 execute ink-inventory --local --file=db/schema.sql
npx wrangler d1 execute ink-inventory --local --file=db/seed.sql

# Run the app at http://localhost:8788 (static files + API + local D1)
npx wrangler pages dev
```

Local writes only touch the local database (under `.wrangler/`, gitignored).

---

## Everyday use

- **Filter** by color-family chips (multi-select) + the search box (code or description;
  a trailing "C" is ignored, so `186 C` finds `186`).
- **Sort** — **Rainbow** (default; hue order red→orange→yellow→green→blue→violet, with
  neutrals grouped at the end light→dark), Pantone code, or weight.
- **Add ink** — top-right button.
- **Edit** — click any card. `Location` is the field we're backfilling.
- **Mark used up** — in the edit modal. Hidden by default; toggle **Show used-up** to see
  history. Prefer this over Delete for real cans that ran out — it keeps the record.
- **Delete** — in the edit modal (with a confirm step). Permanent; for typos and true
  duplicates. The full row is written to the audit log before removal.
- **Families** — chips run rainbow-first: Red, Orange, Yellow, Green, Blue, Purple,
  White, Black, Grey, Brown. Pinks live in Red.
- **Multi-select** — the Select button turns card taps into selection; bulk actions
  (change family, delete) appear as a second row of the sticky header. "Select visible"
  grabs everything passing the current filters.
- **Show unmatched** — inks whose code can't be matched to a swatch are hidden by default;
  this toggle reveals them (e.g. to fix a mistyped code). They stay in the database either way.
- **Closest match** — type a `#hex` or Pantone code into "Closest to…"; cards re-sort by
  CIEDE2000 color distance with a ΔE badge on each swatch.
- **Coated display** — every shop ink is coated, so matched cards display the official
  finish suffix (`186 C`); the database stores the bare code.

Every add/edit is appended to the `log` table (timestamp, user email, action, what
changed). To read it: 
`npx wrangler d1 execute ink-inventory --remote --command "SELECT * FROM log ORDER BY id DESC LIMIT 20"`

### Data notes from the original import

- Quantity was sparse in the sheet (blank = 1 can); the import filled those with 1.
- One Pantone code arrived corrupted by Excel as `1/6/2026` (YELLOW family, 3.3 lb) —
  open its card in the app and type the correct code.
- `"12"` (YELLOW) is probably *Yellow 012*; renaming it in the app will light up its swatch.
- `P-115-5` and `P 144-15` are CMYK-guide codes with no solid-coated equivalent — they
  correctly show "no preview".

---

## History

The first version of this app targeted Google Apps Script with the Sheet as the live
database. It's preserved at the git tag **`apps-script-v1`** if ever needed.
