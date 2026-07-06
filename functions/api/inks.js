/**
 * /api/inks — the single write path.
 *
 *   POST /api/inks -> add a new ink
 *   PUT  /api/inks -> update an existing ink (any field, including Status)
 *
 * Every successful write:
 *   1) appends an audit row to the log table (timestamp, user, action, changes)
 *   2) returns a fresh inventory snapshot so the UI re-renders in one round trip
 *
 * Rows are NEVER deleted — "used up" is a status flip, and history stays.
 * (There is deliberately no DELETE endpoint.)
 */
import {
  snapshot, validateInk, appendLog, accessEmail, enforceAccess,
  requireDb, json, errorResponse, HttpError,
} from './_db.js';

/* ------------------------------------------------------------------ POST: add */

export async function onRequestPost({ request, env }) {
  try {
    enforceAccess(env, request);
    const payload = await request.json().catch(() => null);
    const v = validateInk(payload);

    const now = new Date();
    const dateAdded = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // yyyy-mm-dd

    await requireDb(env).prepare(
      'INSERT INTO inks (pantone, description, color_family, weight, quantity, location, status, date_added, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      v.pantone, v.description, v.colorFamily, v.weight, v.quantity,
      v.location, v.status, dateAdded, now.toISOString()
    ).run();

    await appendLog(env, accessEmail(request), 'add', v.pantone,
      'family=' + v.colorFamily + '; weight=' + v.weight + '; qty=' + v.quantity + '; loc=' + (v.location || '(blank)'));

    return json({ ok: true, message: 'Added ' + v.pantone + ' to ' + v.colorFamily + '.', inventory: await snapshot(env) });
  } catch (e) {
    return errorResponse(e);
  }
}

/* ------------------------------------------------------------------ PUT: update */

export async function onRequestPut({ request, env }) {
  try {
    enforceAccess(env, request);
    const payload = await request.json().catch(() => null);
    const id = parseInt(payload && payload.id, 10);
    if (!id || id < 1) throw new HttpError(400, 'Missing or invalid ink id for update.');
    const v = validateInk(payload);

    const db = requireDb(env);

    // Fetch the current row first — both to 404 cleanly and to log what changed.
    const before = await db.prepare('SELECT * FROM inks WHERE id = ?').bind(id).first();
    if (!before) throw new HttpError(404, 'That ink no longer exists. Please refresh.');

    await db.prepare(
      'UPDATE inks SET pantone = ?, description = ?, color_family = ?, weight = ?, ' +
      'quantity = ?, location = ?, status = ?, updated_at = ? WHERE id = ?'
    ).bind(
      v.pantone, v.description, v.colorFamily, v.weight, v.quantity,
      v.location, v.status, new Date().toISOString(), id
    ).run();

    // Log a human-readable diff of only the fields that actually changed.
    const diffs = [];
    const track = (label, a, b) => { if (String(a ?? '') !== String(b ?? '')) diffs.push(label + ': ' + (a ?? '') + ' -> ' + (b ?? '')); };
    track('pantone', before.pantone, v.pantone);
    track('desc', before.description, v.description);
    track('family', before.color_family, v.colorFamily);
    track('weight', before.weight, v.weight);
    track('qty', before.quantity, v.quantity);
    track('loc', before.location, v.location);
    track('status', before.status, v.status);

    await appendLog(env, accessEmail(request), 'update', v.pantone,
      diffs.length ? diffs.join('; ') : '(no field changes)');

    return json({ ok: true, message: 'Updated ' + v.pantone + '.', inventory: await snapshot(env) });
  } catch (e) {
    return errorResponse(e);
  }
}
