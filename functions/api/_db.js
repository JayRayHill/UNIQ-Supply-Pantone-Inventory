/**
 * _db.js — shared helpers for the API endpoints.
 * (The leading underscore means Cloudflare does NOT expose this file as a route.)
 *
 * The database is Cloudflare D1 (SQLite), bound to the Pages project as `DB`.
 * The Google Sheet was a ONE-TIME import (db/seed.sql) — the app is now the
 * single source of truth and nothing here talks to Google.
 */

// Display order (chips render in this order): rainbow first, then neutrals, brown last.
export const COLOR_FAMILIES = ['RED', 'ORANGE', 'YELLOW', 'GREEN', 'BLUE', 'PURPLE', 'PINK', 'WHITE', 'BLACK', 'GREY', 'BROWN'];
export const STATUS_IN_STOCK = 'In Stock';
export const STATUS_USED_UP = 'Used Up';

/** An Error that carries an HTTP status so endpoints can respond precisely. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Throw early with a clear message if the D1 binding is missing. */
export function requireDb(env) {
  if (!env.DB) {
    throw new HttpError(500,
      'Database binding "DB" is missing. In Cloudflare: Workers & Pages → your project → Settings → Bindings → add D1 database binding named DB. See README.');
  }
  return env.DB;
}

/* ----------------------------------------------------------------------------
 * SNAPSHOT — the payload the frontend renders from.
 * -------------------------------------------------------------------------- */

/** Read everything and shape it for the UI:
 *  { inks:[...], families:{ BLUE: 70, ... in-stock counts }, generatedAt } */
export async function snapshot(env) {
  const db = requireDb(env);
  const { results } = await db.prepare(
    'SELECT id, pantone, description, color_family, weight, quantity, location, status, date_added ' +
    'FROM inks ORDER BY id'
  ).all();

  const families = {};
  COLOR_FAMILIES.forEach(f => { families[f] = 0; });

  const inks = results.map(r => {
    // Chip counts reflect what's on the shelf (in-stock only).
    if (r.status !== STATUS_USED_UP && r.color_family in families) families[r.color_family]++;
    return {
      id: r.id,
      pantone: r.pantone,
      description: r.description || '',
      colorFamily: r.color_family,
      weight: r.weight,                 // may be null
      quantity: r.quantity || 1,
      location: r.location || '',
      status: r.status,
      dateAdded: r.date_added || '',
    };
  });

  return { inks, families, generatedAt: new Date().toISOString() };
}

/* ----------------------------------------------------------------------------
 * VALIDATION (defensive — never trust the browser)
 * -------------------------------------------------------------------------- */

export function validateInk(payload) {
  if (!payload || typeof payload !== 'object') throw new HttpError(400, 'No data received.');

  const pantone = String(payload.pantone == null ? '' : payload.pantone).trim();
  if (!pantone) throw new HttpError(400, 'Pantone code is required.');
  if (pantone.length > 60) throw new HttpError(400, 'Pantone code is too long (max 60 characters).');

  const description = String(payload.description == null ? '' : payload.description).trim();
  if (description.length > 255) throw new HttpError(400, 'Description is too long (max 255 characters).');

  const location = String(payload.location == null ? '' : payload.location).trim();
  if (location.length > 100) throw new HttpError(400, 'Location is too long (max 100 characters).');

  let weight = null;
  if (payload.weight !== '' && payload.weight != null) {
    weight = parseFloat(payload.weight);
    if (isNaN(weight) || weight < 0) throw new HttpError(400, 'Weight must be a non-negative number.');
    if (weight > 10000) throw new HttpError(400, 'Weight looks too large — please double check.');
  }

  let quantity = 1;
  if (payload.quantity !== '' && payload.quantity != null) {
    quantity = parseInt(payload.quantity, 10);
    if (isNaN(quantity) || quantity < 1) throw new HttpError(400, 'Quantity must be a whole number of 1 or more.');
    if (quantity > 100000) throw new HttpError(400, 'Quantity looks too large — please double check.');
  }

  const colorFamily = String(payload.colorFamily == null ? '' : payload.colorFamily).trim().toUpperCase();
  if (COLOR_FAMILIES.indexOf(colorFamily) === -1) {
    throw new HttpError(400, 'Please choose a valid color family.');
  }

  const status = (payload.status === STATUS_USED_UP) ? STATUS_USED_UP : STATUS_IN_STOCK;

  return { pantone, description, location, weight, quantity, colorFamily, status };
}

/* ----------------------------------------------------------------------------
 * AUDIT LOG
 * -------------------------------------------------------------------------- */

export async function appendLog(env, email, action, pantone, changes) {
  try {
    await requireDb(env).prepare(
      'INSERT INTO log (ts, user_email, action, pantone, changes) VALUES (?, ?, ?, ?, ?)'
    ).bind(new Date().toISOString(), email || '(unknown)', action, pantone, changes || '').run();
  } catch (e) {
    // Logging must never break a write — swallow.
  }
}

/* ----------------------------------------------------------------------------
 * REQUEST HELPERS
 * -------------------------------------------------------------------------- */

/** The email Cloudflare Access verified for this visitor (null if Access is off). */
export function accessEmail(request) {
  return request.headers.get('cf-access-authenticated-user-email');
}

/** Optional hard gate: set env REQUIRE_ACCESS=true once Cloudflare Access is
 *  enabled, and the API refuses requests that didn't come through Access. */
export function enforceAccess(env, request) {
  if (String(env.REQUIRE_ACCESS).toLowerCase() === 'true' && !accessEmail(request)) {
    throw new HttpError(403, 'This app requires Cloudflare Access login.');
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function errorResponse(e) {
  const status = e instanceof HttpError ? e.status : 500;
  return json({ error: e.message || 'Unexpected server error.' }, status);
}
