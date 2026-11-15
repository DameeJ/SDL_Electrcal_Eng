// netlify/functions/pricebook.js
//
//   GET  /.netlify/functions/pricebook  -> { entries: [{label, uom, usual, n, last, trend, trendPct, ...}] }
//   POST /.netlify/functions/pricebook  -> body { items: [{name, uom, price}] }
//
// The app POSTs here only when someone actually exports a document (PDF/image),
// i.e. after a human has looked at the prices. That is what makes the learned
// price book trustworthy: it records what was really quoted, not raw AI guesses.

const core = require("./lib/pricebook-core");
const { json, checkAccess, readJsonBody } = require("./lib/http");

exports.handler = async (event) => {
  const denied = checkAccess(event);
  if (denied) return denied;

  const store = await core.openStore(event);
  if (!store) return json(503, { error: "Price book storage (Netlify Blobs) is not available on this site", code: "no_store" });

  try {
    if (event.httpMethod === "GET") {
      const book = await core.loadBook(store);
      return json(200, { entries: core.listEntries(book) });
    }

    if (event.httpMethod === "POST") {
      const body = readJsonBody(event);
      if (!body) return json(400, { error: "Invalid JSON body" });
      const incoming = core.cleanIncoming(body.items);
      if (!incoming.length) return json(200, { accepted: 0, rejected: [], skipped: 0 });

      const book = await core.loadBook(store);
      const result = core.applyObservations(book, incoming);
      if (result.accepted.length) await core.saveBook(store, result.book);
      return json(200, {
        accepted: result.accepted.length,
        rejected: result.rejected,   // prices >5x away from the usual — probably typos, not stored
        skipped: result.skipped.length
      });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("[pricebook] error:", err);
    return json(500, { error: err.message || "Unknown error" });
  }
};
