// netlify/functions/parse.js
//
// Serverless function — runs on Netlify's servers, never in the browser.
// This is the ONLY safe place to hold the NVIDIA API key: anything shipped
// to the browser (including index.html) is visible to anyone who opens
// dev tools, so the key must live here as an environment variable instead.
//
// The frontend calls this at /.netlify/functions/parse with a POST body
// of { text, knownPricing }. It replies with JSON matching the shape
// index.html expects: { clientName, workmanship, items: [{name, qty, uom, price, note}] }.
// On any failure, index.html quietly falls back to its own regex parser —
// this function is an upgrade, not a hard dependency.

const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

// Pick any NVIDIA NIM chat model you have access to. This one is a solid,
// inexpensive default for structured extraction tasks.
const MODEL = "meta/llama-3.1-70b-instruct";

const SYSTEM_PROMPT = `You are a parser for an electrical engineering supplier in Nigeria.
You convert a freeform, possibly voice-transcribed description of a materials order into strict JSON.

Rules:
- Prices in the input always apply to the STANDARD PACKAGING UNIT stated (e.g. price per bundle, per roll, per box) — never to individual sub-units mentioned alongside it (e.g. "4 pieces of 2 bundles at 3000 per bundle" means qty=2, uom="bundles", price=3000, and "4 pieces" becomes a short note, not part of the math).
- If the text contains a client's name (often introduced with "client" or "to" or "for"), extract it as clientName. Otherwise clientName is null.
- If the text mentions "workmanship" or a labour/service fee separate from materials, extract that number as workmanship. Otherwise workmanship is null.
- Everything else becomes one entry in "items": {name, qty, uom, price, note}. note is a short optional string for sub-unit context (or null). uom is a short unit word like "bundle", "roll", "box", "unit" — plural when qty is not 1.
- If a price is not stated for an item and a matching name appears in knownPricing, use that price.
- Output ONLY valid JSON, no markdown fences, no commentary. Shape exactly:
{"clientName": string|null, "workmanship": number|null, "items": [{"name": string, "qty": number, "uom": string, "price": number, "note": string|null}]}`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    // Not configured yet — fail cleanly so the frontend falls back locally.
    return { statusCode: 500, body: JSON.stringify({ error: "NVIDIA_API_KEY is not set" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { text, knownPricing } = payload;
  if (!text || typeof text !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing 'text'" }) };
  }

  const userPrompt = `knownPricing (name/uom/price, may be empty): ${JSON.stringify(knownPricing || [])}

Text to parse:
"""${text}"""`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(NVIDIA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: 502, body: JSON.stringify({ error: "NVIDIA API error", detail: errText }) };
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "";

    // Strip accidental markdown fences before parsing, just in case.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return { statusCode: 502, body: JSON.stringify({ error: "Model did not return valid JSON", raw }) };
    }

    if (!Array.isArray(parsed.items)) {
      return { statusCode: 502, body: JSON.stringify({ error: "Missing items array", raw }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Unknown error" }) };
  }
};
