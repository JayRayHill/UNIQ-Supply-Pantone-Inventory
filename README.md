# Ink Inventory

An internal web app for the print shop that makes our ~320 leftover Pantone inks
**visible, searchable, and editable** — so designers can suggest an on-hand ink
when it's close enough to a customer's color, and the team can update inventory
without touching the raw spreadsheet.

Built with **Google Apps Script** (HtmlService web app) using our existing Google
Sheet as the database. No servers, no frameworks — it deploys as a single page.

---

## What's in this folder

| File | Role |
|------|------|
| `Code.gs` | Server. The only code that touches the Sheet. Parsing, caching, validated writes, audit log. |
| `Index.html` | Page markup. Pulls the other partials in via the Apps Script `include()` pattern. |
| `Stylesheet.html` | All CSS (inlined into the page). |
| `JavaScript.html` | All client logic: filtering, sorting, Pantone→hex swatches, close-match, the add/edit modal. |
| `PantoneData.html` | Bundled community Pantone *solid coated 2024* hex lookup (3,219 entries, converted from the book's Lab values) so swatches render offline. |
| `appsscript.json` | Manifest: web-app access settings + OAuth scopes. |
| `.claspignore` | Tells `clasp` which files to upload. |

> **Honesty note on colors:** Pantone doesn't publish official sRGB values. The bundled
> table comes from a community copy of the *Solid Coated 2024* book (Lab values converted
> to hex with the standard D50→D65 Bradford adaptation) — good enough for "is this close?"
> decisions, not for proofing. All our inks are coated, so everything matches against the
> coated book. Codes we can't resolve (e.g. CMYK-guide codes like `P-115-5`) show a neutral
> **"no preview"** swatch. We never invent a color. Verified coverage against the current
> inventory: **316 of 320 inks** get a swatch.

---

## How the Sheet is interpreted

One tab (default name **`Inventory`**), with a header row 1:

```
Pantone | Description | Weight | Location | Quantity | Pantone(stray, ignored)
```

- **Color-family header rows** — a row with only column A filled, containing one of
  `WHITE BLACK YELLOW ORANGE RED PURPLE BLUE GREEN BROWN GREY`. Every ink row beneath a
  header belongs to that family until the next header. This is parsed into a `colorFamily`
  field per ink.
- **Pantone codes are always read/written as plain text** (via display values + a forced
  `@` text format), so `7706`, `165 U`, `186U`, `P-115-5`, and `Rhodamine Red` never coerce
  to numbers or dates.
- **Quantity is sparse** — blank means 1. The app keeps it sparse (only writes quantity when >1).
- **Location** starts empty; the app is how we backfill it.

The app **adds two managed columns** on the right the first time it writes (or when you run
`setupSheet`): **`Status`** (`In Stock` / `Used Up`) and **`Date Added`**. It also creates a
separate **`Log`** tab and appends an audit row on every write
(timestamp, user email, action, Pantone, what changed). Rows are **never deleted** — "used up"
inks are hidden by default with a toggle to show them.

---

## First-time setup (clasp)

You'll need Node installed. `clasp` is Google's CLI for Apps Script. Run everything from
inside this folder:

```bash
cd "Ink Inventory App"
```

### 1. Log in

```bash
npx clasp login
```

This opens a browser to authorize `clasp` with your Google account. Log in with the
Workspace account that should own the script. (Global install alternative:
`npm i -g @google/clasp` then `clasp login`.)

> If your Workspace admin has the Apps Script API turned off, enable it once for your
> account at <https://script.google.com/home/usersettings> (toggle **Google Apps Script API → On**).

### 2. Create the Apps Script project

Because the data already lives in **your existing** sheet, pick one of these. (Note:
`clasp create --type sheets` would make a *brand-new blank* spreadsheet — not what we want.)

**A) Standalone project, targeting your Sheet by ID (recommended — simplest with clasp)**

```bash
npx clasp create --type webapp --title "Ink Inventory" --rootDir .
```

Then tell it which spreadsheet to use (no code edit needed):

- Open the project: `npx clasp open-script`
- **Project Settings → Script Properties → Add script property**
  `SPREADSHEET_ID` = the id from your sheet URL
  (`https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`).

**B) Bound to your existing Sheet** — makes `SpreadsheetApp.getActiveSpreadsheet()` "just
work" with no Script Property. You create the empty project from the Sheet, then attach clasp:

1. Open your sheet → **Extensions → Apps Script**. An empty project opens.
2. **Project Settings** (gear) → copy the **Script ID**.
3. Back in this folder, clone into it and push:
   ```bash
   npx clasp clone <SCRIPT_ID> --rootDir .
   ```
   `clone` writes `.clasp.json`. It may pull down a starter `Code.gs`/`appsscript.json` —
   overwrite by keeping the files in this folder, then `clasp push --force`.

Either way, `.clasp.json` now holds your `scriptId`. Don't commit it to a shared repo.

### 3. Push the code

```bash
npx clasp push
```

Re-run this any time you change a file locally. Watch mode: `npx clasp push --watch`.

### 4. Confirm the tab name

The app expects a tab called **`Inventory`**. If yours is named differently, edit
`SHEET_NAME` at the top of `Code.gs` and push again.

### 5. (Optional) run setup once

In the Apps Script editor (`npx clasp open-script`), select the `setupSheet` function and click
**Run**. It creates the `Status` / `Date Added` columns and forces the Pantone column to
text. (The app also does this lazily on the first write, so this step is optional.) The
first run will prompt you to authorize the OAuth scopes.

### 6. Deploy as a web app

```bash
npx clasp deploy --description "v1"
```

Then in the editor: **Deploy → Manage deployments → (your deployment) → Edit** and confirm:

- **Execute as:** `Me`
- **Who has access:** `Anyone within <your Workspace domain>`

Copy the **Web app URL** and share it with the team. (These settings are pre-declared in
`appsscript.json` as `executeAs: USER_DEPLOYING`, `access: DOMAIN`, but the deployment UI is
where they take effect.)

---

## Test copy vs. real sheet

- **Bound project:** the script is tied to whichever spreadsheet it was created in. To move
  from a test copy to production, either (a) put this same code on the real sheet, or (b)
  switch to the standalone approach and set the `SPREADSHEET_ID` Script Property.
- **Standalone project:** just change the `SPREADSHEET_ID` Script Property to point at the
  test copy or the real sheet. No code change, no re-push. Re-deploy isn't needed for a
  property change, but do reload the app.

There's a tiny built-in sanity check: run `debugCounts` in the editor — it logs the total
ink count and the per-family counts so you can confirm parsing matches the sheet
(expected: WHITE 1, BLACK 1, YELLOW 15, ORANGE 36, RED 64, PURPLE 14, BLUE 70, GREEN 60,
BROWN 44, GREY 15 = 320).

---

## Everyday use

- **Filter** by color-family chips (multi-select) and/or the search box (matches code +
  description). Filters combine.
- **Sort** by Pantone code or weight.
- **Add ink** — top-right button. Inserts the row under the correct family header.
- **Edit** — click any card. Backfill `Location`, fix weights, etc. Family is locked on edit
  (it determines which block the row lives in).
- **Mark used up** — inside the edit modal. Hidden by default; toggle **Show used-up** to see
  history.
- **Closest match** — type a `#hex` or a Pantone code into the "Closest to…" box; cards
  re-sort by CIEDE2000 color distance with a ΔE badge.

Every add/edit/status change is appended to the **`Log`** tab automatically.
