/**
 * POST /api/bulk — apply one action to many inks at once.
 *
 * Body: { action: 'family' | 'delete', ids: [1,2,3], colorFamily?: 'PINK' }
 *   - action 'family': moves every selected ink to colorFamily
 *   - action 'delete': permanently removes every selected ink
 *
 * Same rules as single writes: validated server-side, one audit-log entry
 * (listing every affected code), and the response carries a fresh inventory
 * snapshot so the UI re-renders in one round trip.
 */
import {
  snapshot, appendLog, accessEmail, enforceAccess,
  requireDb, json, errorResponse, HttpError, COLOR_FAMILIES,
} from './_db.js';

const MAX_IDS = 500; // sanity cap; the whole inventory is ~320

export async function onRequestPost({ request, env }) {
  try {
    enforceAccess(env, request);
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== 'object') throw new HttpError(400, 'No data received.');

    const action = payload.action;
    if (action !== 'family' && action !== 'delete') {
      throw new HttpError(400, 'Unknown bulk action.');
    }

    // Sanitize the id list: integers only, deduped, capped.
    const ids = Array.from(new Set((Array.isArray(payload.ids) ? payload.ids : [])
      .map(x => parseInt(x, 10))
      .filter(n => Number.isInteger(n) && n > 0)));
    if (!ids.length) throw new HttpError(400, 'No inks selected.');
    if (ids.length > MAX_IDS) throw new HttpError(400, 'Too many inks selected at once.');

    let colorFamily = null;
    if (action === 'family') {
      colorFamily = String(payload.colorFamily || '').trim().toUpperCase();
      if (COLOR_FAMILIES.indexOf(colorFamily) === -1) {
        throw new HttpError(400, 'Please choose a valid color family.');
      }
    }

    const db = requireDb(env);
    const marks = ids.map(() => '?').join(',');

    // Fetch the affected rows first — to 404 sensibly and to write a useful log.
    const { results: rows } = await db.prepare(
      'SELECT id, pantone, color_family FROM inks WHERE id IN (' + marks + ')'
    ).bind(...ids).all();
    if (!rows.length) throw new HttpError(404, 'None of the selected inks exist anymore. Please refresh.');

    const codes = rows.map(r => r.pantone).join(', ');
    let message;

    if (action === 'family') {
      await db.prepare(
        'UPDATE inks SET color_family = ?, updated_at = ? WHERE id IN (' + marks + ')'
      ).bind(colorFamily, new Date().toISOString(), ...ids).run();
      message = 'Moved ' + rows.length + ' ink' + (rows.length === 1 ? '' : 's') + ' to ' + colorFamily + '.';
      await appendLog(env, accessEmail(request), 'bulk-family', rows.length + ' inks',
        '-> ' + colorFamily + ': ' + codes);
    } else {
      await db.prepare(
        'DELETE FROM inks WHERE id IN (' + marks + ')'
      ).bind(...ids).run();
      message = 'Deleted ' + rows.length + ' ink' + (rows.length === 1 ? '' : 's') + '.';
      await appendLog(env, accessEmail(request), 'bulk-delete', rows.length + ' inks',
        'DELETED: ' + codes);
    }

    return json({ ok: true, message, inventory: await snapshot(env) });
  } catch (e) {
    return errorResponse(e);
  }
}
