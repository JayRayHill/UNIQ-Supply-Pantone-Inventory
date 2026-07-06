/**
 * Code.gs — SERVER for the Ink Inventory web app
 * ==============================================================================
 * This file runs on Google's servers (Apps Script). It is the ONLY code that is
 * allowed to touch the Google Sheet. The browser (Index.html + JavaScript.html)
 * never talks to the Sheet directly — it calls the functions in this file using
 * `google.script.run.someFunction(args)`.
 *
 * Mental model if you're coming from HTML/CSS:
 *   - Think of each `function foo()` below as an API endpoint.
 *   - The Sheet is the database. We read the whole thing, turn it into clean
 *     JSON objects, and hand that to the browser.
 *   - Writes are funneled through ONE guarded path so two people saving at the
 *     same time can't corrupt the sheet.
 *
 * The sheet layout we parse (one tab):
 *   Row 1        -> column headers:  Pantone | Description | Weight | Location | Quantity | Pantone(stray)
 *   Then repeating blocks of:
 *     - a "family header" row (only column A filled, e.g. "BLUE")
 *     - the ink rows that belong to that family
 *   This app ADDS two managed columns on the right when missing: Status, Date Added.
 * ============================================================================== */

/* ----------------------------------------------------------------------------
 * CONFIGURATION
 * -------------------------------------------------------------------------- */

// The tab (sheet) that holds the inks. Change if your tab is named differently.
var SHEET_NAME = 'Inventory';

// A separate tab we append an audit row to on every write. Created automatically.
var LOG_SHEET_NAME = 'Log';

// Fallback spreadsheet id. LEAVE BLANK to use the bound spreadsheet
// (the one this script is attached to). To point at a specific sheet without
// editing code, set a Script Property named SPREADSHEET_ID instead (see README).
var SPREADSHEET_ID_FALLBACK = '';

// How long (seconds) a cached read of the inventory stays fresh. 5 minutes.
var CACHE_SECONDS = 300;
var CACHE_KEY = 'inventory_json_v1';

// The ten valid color families. A row is treated as a "family header" only when
// column A (uppercased) is one of these AND the rest of the row is empty.
var COLOR_FAMILIES = ['WHITE', 'BLACK', 'YELLOW', 'ORANGE', 'RED', 'PURPLE', 'BLUE', 'GREEN', 'BROWN', 'GREY'];

// Logical column header names we care about (matched case-insensitively in row 1).
var COL = {
  PANTONE: 'pantone',
  DESCRIPTION: 'description',
  WEIGHT: 'weight',
  LOCATION: 'location',
  QUANTITY: 'quantity',
  STATUS: 'status',
  DATE_ADDED: 'date added'
};

var STATUS_IN_STOCK = 'In Stock';
var STATUS_USED_UP = 'Used Up';


/* ----------------------------------------------------------------------------
 * WEB APP ENTRY POINTS
 * -------------------------------------------------------------------------- */

/**
 * doGet — Apps Script calls this when someone opens the web app URL.
 * It stitches the HTML/CSS/JS partials together and returns one page.
 */
function doGet() {
  var page = HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Ink Inventory')
    // Let the page size itself to the device (good on a shop-floor tablet).
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  return page;
}

/**
 * include — used inside Index.html as <?!= include('Stylesheet') ?> to inline
 * the CSS and JS partials. HtmlService works best when everything ships as one
 * document, so this is the standard Apps Script "include" pattern.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


/* ----------------------------------------------------------------------------
 * SPREADSHEET / SHEET HELPERS
 * -------------------------------------------------------------------------- */

/** Return the Spreadsheet object, honoring the Script Property override. */
function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID_FALLBACK;
  if (id) return SpreadsheetApp.openById(id);
  var bound = SpreadsheetApp.getActiveSpreadsheet();
  if (!bound) {
    throw new Error('No spreadsheet found. Set a Script Property "SPREADSHEET_ID" or bind the script to a sheet.');
  }
  return bound;
}

/** Return the inventory tab, throwing a clear error if it is missing. */
function getSheet_() {
  var sheet = getSpreadsheet_().getSheetByName(SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet tab "' + SHEET_NAME + '" was not found. Check SHEET_NAME in Code.gs.');
  }
  return sheet;
}

/**
 * Build a lookup of { logicalName -> zero-based column index } from row 1.
 * Only the FIRST match of each header name wins, so the stray duplicate
 * "Pantone" column on the far right is naturally ignored.
 */
function mapHeaders_(headerRow) {
  var map = {};
  for (var c = 0; c < headerRow.length; c++) {
    var name = String(headerRow[c]).trim().toLowerCase();
    if (name && !(name in map)) map[name] = c;
  }
  return map;
}

/**
 * Read-only header lookup used by the READ path. Never mutates the sheet.
 * If the managed columns don't exist yet, they're simply absent from the map
 * (reads then default Status -> "In Stock" and Date Added -> "").
 * Returns { headers, headerMap, lastCol }.
 */
function readHeaderMap_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  return { headers: headers, headerMap: mapHeaders_(headers), lastCol: lastCol };
}

/**
 * Ensure the managed columns (Status, Date Added) exist. If missing, append them
 * to the header row and return an updated header map. Also force the Pantone
 * column to PLAIN TEXT so codes like 7706 or "1/6" never re-coerce to numbers/dates.
 * Returns { headers, headerMap, lastCol }.
 */
function ensureColumns_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var headerMap = mapHeaders_(headers);

  // Add any managed column that isn't present yet, on the far right.
  [['Status', COL.STATUS], ['Date Added', COL.DATE_ADDED]].forEach(function (pair) {
    var label = pair[0], key = pair[1];
    if (!(key in headerMap)) {
      lastCol += 1;
      sheet.getRange(1, lastCol).setValue(label);
      headerMap[key] = lastCol - 1; // zero-based
      headers.push(label);
    }
  });

  // Format the entire Pantone column (below the header) as plain text.
  if (COL.PANTONE in headerMap) {
    var maxRows = Math.max(sheet.getMaxRows() - 1, 1);
    sheet.getRange(2, headerMap[COL.PANTONE] + 1, maxRows, 1).setNumberFormat('@');
  }

  return { headers: headers, headerMap: headerMap, lastCol: lastCol };
}

/** True when a row is a color-family header (only column A filled with a family name). */
function isFamilyHeaderRow_(displayRow, hm) {
  var a = String(displayRow[hm[COL.PANTONE]] || '').trim();
  if (!a) return false;
  if (COLOR_FAMILIES.indexOf(a.toUpperCase()) === -1) return false;
  // Every other meaningful column must be empty for it to count as a header.
  var others = [COL.DESCRIPTION, COL.WEIGHT, COL.LOCATION, COL.QUANTITY];
  for (var i = 0; i < others.length; i++) {
    var idx = hm[others[i]];
    if (idx != null && String(displayRow[idx] || '').trim() !== '') return false;
  }
  return true;
}


/* ----------------------------------------------------------------------------
 * READ ENDPOINT (with caching)
 * -------------------------------------------------------------------------- */

/**
 * getInventory — the main read endpoint the browser calls on load.
 * Returns { inks: [...], families: {...counts...}, generatedAt, cached }.
 * Uses a 5-minute CacheService layer so repeated loads feel instant.
 */
function getInventory() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(CACHE_KEY);
  if (hit) {
    var cachedObj = JSON.parse(hit);
    cachedObj.cached = true;
    return cachedObj;
  }
  var fresh = readInventoryFromSheet_();
  // Cache can only store strings, and has a ~100KB per-key limit; our payload
  // is well under that for ~320 inks.
  try { cache.put(CACHE_KEY, JSON.stringify(fresh), CACHE_SECONDS); } catch (e) { /* oversize -> skip cache */ }
  fresh.cached = false;
  return fresh;
}

/** Force a fresh read (used internally right after a write). */
function readInventoryFromSheet_() {
  var sheet = getSheet_();
  var meta = readHeaderMap_(sheet); // read-only; no writes on the read path
  var hm = meta.headerMap;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return { inks: [], families: emptyFamilyCounts_(), generatedAt: new Date().toISOString() };
  }

  // Read DISPLAY values (what the cell shows, always strings). This is the key
  // trick that keeps Pantone codes as text and dodges number/date coercion.
  var numCols = meta.lastCol;
  var display = sheet.getRange(2, 1, lastRow - 1, numCols).getDisplayValues();

  var inks = [];
  var counts = emptyFamilyCounts_();
  var currentFamily = null;

  for (var r = 0; r < display.length; r++) {
    var row = display[r];
    var rowNumber = r + 2; // actual sheet row (1-based; +1 for header, +1 for zero-index)

    // Skip a stray repeated header row if present.
    if (String(row[hm[COL.PANTONE]] || '').trim().toLowerCase() === 'pantone') continue;

    if (isFamilyHeaderRow_(row, hm)) {
      currentFamily = String(row[hm[COL.PANTONE]]).trim().toUpperCase();
      continue;
    }

    var pantone = String(row[hm[COL.PANTONE]] || '').trim();
    if (!pantone) continue; // blank separator row

    var ink = {
      rowNumber: rowNumber,
      pantone: pantone,
      description: cell_(row, hm, COL.DESCRIPTION),
      weight: toNumberOrNull_(cell_(row, hm, COL.WEIGHT)),
      // Quantity is sparse: blank means we have exactly one can.
      quantity: toNumberOrNull_(cell_(row, hm, COL.QUANTITY)) || 1,
      location: cell_(row, hm, COL.LOCATION),
      colorFamily: currentFamily,
      status: cell_(row, hm, COL.STATUS) || STATUS_IN_STOCK,
      dateAdded: cell_(row, hm, COL.DATE_ADDED)
    };
    inks.push(ink);
    if (currentFamily && counts.hasOwnProperty(currentFamily)) counts[currentFamily]++;
  }

  return { inks: inks, families: counts, generatedAt: new Date().toISOString() };
}

function cell_(row, hm, key) {
  var idx = hm[key];
  if (idx == null) return '';
  return String(row[idx] == null ? '' : row[idx]).trim();
}

function emptyFamilyCounts_() {
  var o = {};
  COLOR_FAMILIES.forEach(function (f) { o[f] = 0; });
  return o;
}

function toNumberOrNull_(s) {
  if (s === '' || s == null) return null;
  var n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}


/* ----------------------------------------------------------------------------
 * WRITE ENDPOINTS
 * All three below delegate to writeOperation_(), which holds the lock, validates,
 * writes, logs, busts the cache, and returns a fresh inventory snapshot.
 * -------------------------------------------------------------------------- */

/** Add a brand-new ink under the correct family header. */
function addInk(payload) {
  return writeOperation_('add', payload);
}

/** Edit any field of an existing ink (identified by rowNumber + pantone). */
function updateInk(payload) {
  return writeOperation_('update', payload);
}

/** Flip an ink's Status between In Stock and Used Up (never deletes the row). */
function setInkStatus(payload) {
  return writeOperation_('status', payload);
}

/**
 * writeOperation_ — the single guarded write path.
 * @param {string} action  'add' | 'update' | 'status'
 * @param {Object} payload data from the browser (already JSON, but untrusted)
 * @return {Object} { ok:true, inventory:{...}, message } or throws with a message
 */
function writeOperation_(action, payload) {
  // 1) LOCK: wait up to 20s for exclusive access so concurrent saves serialize.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw new Error('The inventory is busy (another save is in progress). Please try again.');
  }
  try {
    var sheet = getSheet_();
    var meta = ensureColumns_(sheet);
    var hm = meta.headerMap;

    var result;
    if (action === 'add') {
      result = doAdd_(sheet, hm, payload);
    } else if (action === 'update') {
      result = doUpdate_(sheet, hm, payload);
    } else if (action === 'status') {
      result = doStatus_(sheet, hm, payload);
    } else {
      throw new Error('Unknown action: ' + action);
    }

    // 2) LOG every write to the audit tab.
    appendLog_(action, result.pantone, result.changes);

    // 3) Bust the read cache so the next getInventory() reflects the write.
    CacheService.getScriptCache().remove(CACHE_KEY);

    // 4) Hand back a fresh snapshot so the UI can re-render without a 2nd call.
    var inventory = readInventoryFromSheet_();
    CacheService.getScriptCache().put(CACHE_KEY, JSON.stringify(inventory), CACHE_SECONDS);
    return { ok: true, message: result.message, inventory: inventory };
  } finally {
    // ALWAYS release the lock, even if something above threw.
    lock.releaseLock();
  }
}


/* ---- individual write implementations ---- */

function doAdd_(sheet, hm, payload) {
  var v = validateInk_(payload, /*requireFamily=*/true);

  // Find the row of the target family header, then the last row of that block.
  var lastRow = sheet.getLastRow();
  var display = sheet.getRange(1, 1, lastRow, meta_(sheet).lastCol).getDisplayValues();
  var headerRow = -1;
  var blockEnd = -1;

  for (var r = 1; r < display.length; r++) { // r is zero-based within display; sheet row = r+1
    var row = display[r];
    if (isFamilyHeaderRow_(row, hm)) {
      var fam = String(row[hm[COL.PANTONE]]).trim().toUpperCase();
      if (fam === v.colorFamily) {
        headerRow = r + 1;         // sheet row of the matched header
      } else if (headerRow !== -1 && blockEnd === -1) {
        blockEnd = r;              // sheet row just before the NEXT header (r+1 - 1)
      }
    }
  }
  if (headerRow === -1) {
    throw new Error('Could not find the "' + v.colorFamily + '" header row in the sheet.');
  }
  // If no later header was found, the block runs to the end of the sheet.
  var insertAfter = (blockEnd === -1) ? lastRow : blockEnd;

  sheet.insertRowAfter(insertAfter);
  var newRow = insertAfter + 1;
  writeRow_(sheet, hm, newRow, v, /*isNew=*/true);

  return {
    pantone: v.pantone,
    message: 'Added ' + v.pantone + ' to ' + v.colorFamily + '.',
    changes: 'family=' + v.colorFamily + '; weight=' + v.weight + '; qty=' + v.quantity + '; loc=' + (v.location || '(blank)')
  };
}

function doUpdate_(sheet, hm, payload) {
  var rowNumber = parseInt(payload.rowNumber, 10);
  if (!rowNumber || rowNumber < 2) throw new Error('Missing or invalid row reference for update.');

  // Guard against a stale UI: confirm the row still holds the expected pantone.
  var existingPantone = String(sheet.getRange(rowNumber, hm[COL.PANTONE] + 1).getDisplayValue()).trim();
  if (payload.originalPantone != null && existingPantone !== String(payload.originalPantone).trim()) {
    throw new Error('This ink changed since you loaded the page (row now shows "' + existingPantone + '"). Please refresh.');
  }

  var v = validateInk_(payload, /*requireFamily=*/false);
  writeRow_(sheet, hm, rowNumber, v, /*isNew=*/false);

  return {
    pantone: v.pantone,
    message: 'Updated ' + v.pantone + '.',
    changes: 'desc=' + v.description + '; weight=' + v.weight + '; qty=' + v.quantity + '; loc=' + (v.location || '(blank)')
  };
}

function doStatus_(sheet, hm, payload) {
  var rowNumber = parseInt(payload.rowNumber, 10);
  if (!rowNumber || rowNumber < 2) throw new Error('Missing or invalid row reference.');
  var newStatus = (payload.status === STATUS_USED_UP) ? STATUS_USED_UP : STATUS_IN_STOCK;

  if (hm[COL.STATUS] == null) throw new Error('Status column missing.');
  sheet.getRange(rowNumber, hm[COL.STATUS] + 1).setValue(newStatus);

  var pantone = String(sheet.getRange(rowNumber, hm[COL.PANTONE] + 1).getDisplayValue()).trim();
  return {
    pantone: pantone,
    message: pantone + ' marked ' + newStatus + '.',
    changes: 'status -> ' + newStatus
  };
}

/** Small helper so doAdd_ can re-read column count without re-running ensureColumns_. */
function meta_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  return { lastCol: lastCol };
}

/**
 * writeRow_ — write validated values into a specific sheet row.
 * Pantone is written as a string into a text-formatted cell so it stays text.
 */
function writeRow_(sheet, hm, rowNumber, v, isNew) {
  // Pantone: set format to text FIRST, then the value.
  var pCell = sheet.getRange(rowNumber, hm[COL.PANTONE] + 1);
  pCell.setNumberFormat('@');
  pCell.setValue(v.pantone);

  setIfPresent_(sheet, hm, COL.DESCRIPTION, rowNumber, v.description);
  setIfPresent_(sheet, hm, COL.WEIGHT, rowNumber, v.weight == null ? '' : v.weight);
  setIfPresent_(sheet, hm, COL.LOCATION, rowNumber, v.location);
  // Only write quantity when >1 to keep the column sparse like the original data.
  setIfPresent_(sheet, hm, COL.QUANTITY, rowNumber, (v.quantity && v.quantity > 1) ? v.quantity : '');

  if (hm[COL.STATUS] != null) {
    sheet.getRange(rowNumber, hm[COL.STATUS] + 1).setValue(v.status || STATUS_IN_STOCK);
  }
  if (isNew && hm[COL.DATE_ADDED] != null) {
    // Stamp Date Added as an ISO date string (plain text, no auto-format surprises).
    var d = new Date();
    var stamp = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var dCell = sheet.getRange(rowNumber, hm[COL.DATE_ADDED] + 1);
    dCell.setNumberFormat('@');
    dCell.setValue(stamp);
  }
}

function setIfPresent_(sheet, hm, key, rowNumber, value) {
  if (hm[key] == null) return;
  sheet.getRange(rowNumber, hm[key] + 1).setValue(value);
}


/* ----------------------------------------------------------------------------
 * VALIDATION (defensive — never trust the browser)
 * -------------------------------------------------------------------------- */

function validateInk_(payload, requireFamily) {
  if (!payload || typeof payload !== 'object') throw new Error('No data received.');

  var pantone = String(payload.pantone == null ? '' : payload.pantone).trim();
  if (!pantone) throw new Error('Pantone code is required.');
  if (pantone.length > 60) throw new Error('Pantone code is too long (max 60 characters).');

  var description = String(payload.description == null ? '' : payload.description).trim();
  if (description.length > 255) throw new Error('Description is too long (max 255 characters).');

  var location = String(payload.location == null ? '' : payload.location).trim();
  if (location.length > 100) throw new Error('Location is too long (max 100 characters).');

  // Weight: optional. If given, must be a number >= 0.
  var weight = null;
  if (payload.weight !== '' && payload.weight != null) {
    weight = parseFloat(payload.weight);
    if (isNaN(weight) || weight < 0) throw new Error('Weight must be a non-negative number.');
    if (weight > 10000) throw new Error('Weight looks too large — please double check.');
  }

  // Quantity: optional. If given, must be a whole number >= 1.
  var quantity = null;
  if (payload.quantity !== '' && payload.quantity != null) {
    quantity = parseInt(payload.quantity, 10);
    if (isNaN(quantity) || quantity < 1) throw new Error('Quantity must be a whole number of 1 or more.');
    if (quantity > 100000) throw new Error('Quantity looks too large — please double check.');
  }

  var colorFamily = String(payload.colorFamily == null ? '' : payload.colorFamily).trim().toUpperCase();
  if (requireFamily) {
    if (COLOR_FAMILIES.indexOf(colorFamily) === -1) {
      throw new Error('Please choose a valid color family.');
    }
  }

  var status = (payload.status === STATUS_USED_UP) ? STATUS_USED_UP : STATUS_IN_STOCK;

  return {
    pantone: pantone,
    description: description,
    location: location,
    weight: weight,
    quantity: quantity,
    colorFamily: colorFamily,
    status: status
  };
}


/* ----------------------------------------------------------------------------
 * AUDIT LOG
 * -------------------------------------------------------------------------- */

/** Append one audit row to the Log tab (auto-created with a header the first time). */
function appendLog_(action, pantone, changes) {
  try {
    var ss = getSpreadsheet_();
    var log = ss.getSheetByName(LOG_SHEET_NAME);
    if (!log) {
      log = ss.insertSheet(LOG_SHEET_NAME);
      log.appendRow(['Timestamp', 'User', 'Action', 'Pantone', 'Changes']);
    }
    var email = '';
    try { email = Session.getActiveUser().getEmail() || ''; } catch (e) { email = '(unknown)'; }
    var ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    log.appendRow([ts, email, action, pantone, changes || '']);
  } catch (e) {
    // Logging must NEVER break a write. Swallow and move on.
  }
}


/* ----------------------------------------------------------------------------
 * MAINTENANCE / SETUP HELPERS (run manually from the Apps Script editor)
 * -------------------------------------------------------------------------- */

/** One-time: ensure managed columns exist and force the Pantone column to text. */
function setupSheet() {
  var sheet = getSheet_();
  ensureColumns_(sheet);
  CacheService.getScriptCache().remove(CACHE_KEY);
  return 'Setup complete on tab "' + SHEET_NAME + '".';
}

/** Handy sanity check you can run in the editor to verify parsing/counts. */
function debugCounts() {
  var inv = readInventoryFromSheet_();
  Logger.log('Total inks: ' + inv.inks.length);
  Logger.log(JSON.stringify(inv.families));
  return inv.families;
}
