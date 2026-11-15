// netlify/functions/lib/http.js — tiny shared helpers for the functions.
const crypto = require("crypto");

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function json(statusCode, obj) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}

/* Optional shared "team key". If SDL_ACCESS_KEY is NOT set in Netlify, the
   functions stay open (so first-time setup just works). Once you set it, every
   call must send the same value in an x-sdl-key header — which protects both
   your NVIDIA credits and the learned price book from strangers who find the URL. */
function checkAccess(event) {
  const required = process.env.SDL_ACCESS_KEY;
  if (!required) return null;
  const headers = (event && event.headers) || {};
  const given = String(headers["x-sdl-key"] || headers["X-Sdl-Key"] || "");
  const a = Buffer.from(given);
  const b = Buffer.from(String(required));
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return null;
  return json(401, { error: "Access key required", code: "locked" });
}

function readJsonBody(event) {
  try { return JSON.parse((event && event.body) || "{}"); } catch { return null; }
}

module.exports = { json, checkAccess, readJsonBody };
