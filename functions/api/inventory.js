/**
 * GET /api/inventory — the read endpoint the browser calls on load.
 * Returns { inks: [...], families: { in-stock counts }, generatedAt }.
 * D1 reads are fast enough that no extra cache layer is needed.
 */
import { snapshot, enforceAccess, json, errorResponse } from './_db.js';

export async function onRequestGet({ request, env }) {
  try {
    enforceAccess(env, request);
    return json(await snapshot(env));
  } catch (e) {
    return errorResponse(e);
  }
}
