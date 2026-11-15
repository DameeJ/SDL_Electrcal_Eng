// netlify/functions/parse.js
//
// Turns a messy, hurried materials list into structured line items.
// Runs server-side so the NVIDIA key never reaches the browser.
//
// POST { text, knownPricing }  ->  { intent, clientName, workmanship, items[], unparsed[], meta }
//
// On failure it returns { error, code } with a non-200 status; index.html then
// falls back to its local pattern parser and shows the reason on the card.
//
// IMPORTANT — time budget: Netlify's synchronous functions are cut off after
// ~10 seconds by default. A big model writing a long answer can exceed that, so:
//   * index.html sends long lists in small chunks (a few lines at a time),
//   * the model is asked for a compact answer,
//   * we abort at 8.5s ourselves so you get a clear "timed out" instead of a
//     silent platform kill. If you see timeouts, set NVIDIA_MODEL to a smaller,
//     faster model in Netlify's environment variables.

const core = require("./lib/pricebook-core");
const { json, checkAccess, readJsonBody } = require("./lib/http");

const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = "meta/llama-3.1-70b-instruct";
const TIME_BUDGET_MS = 8500;
const MAX_TEXT_CHARS = 3000;

const SYSTEM_PROMPT = [
  "You turn messy materials lists from Nigerian electricians into strict JSON for a quotation app.",
  "The writer may be hurried, mis-spell words, use Nigerian Pidgin, shorthand, or no punctuation at all.",
  "Read between the lines the way an experienced supplier would. Never refuse: give your best reading and flag doubt instead of dropping or inventing anything.",
  "",
  "SHORTHAND: \"k\" = thousand (28k = 28000), \"m\" = million. Commas inside numbers are thousands separators. \"@\", \"each\", \"per\" before a number mark a price for ONE unit. \"pcs\"/\"pc\" = pieces, \"ctn\" = carton, \"pkt\" = packet. A bare size such as \"1.5\" or \"2.5\" beside wire/cable means 1.5mm / 2.5mm.",
  "",
  "ITEM FIELDS:",
  "- name: clean trade name, size first when there is one, typos fixed (\"cment\" -> \"Cement\", \"1.5 wire\" -> \"1.5mm wire\"). Never add a product that was not mentioned.",
  "- qty: how many of the BILLING unit.",
  "- uom: the standard packaging unit the price applies to (bundle, roll, box, bag, tin, carton, length...), plural when qty is not 1. If none is written, infer the usual trade unit (wire/cable -> roll, cement -> bag, conduit pipe -> bundle, sockets/switches/holders -> box, paint -> tin) and say so in why.",
  "- price: the number typed for that item, as a plain number (28k -> 28000). If no price was typed, use 0.",
  "- basis: \"each\" when the number is clearly the price of ONE billing unit; \"total\" when it is clearly the amount for the whole line (the word total/altogether/all, or it is obviously qty x a normal price). If you cannot tell, use \"each\", set low:true and explain in why.",
  "- Prices always belong to the packaging unit, never to sub-units mentioned beside it: \"4 pieces of 2 bundles at 3000 per bundle\" = qty 2, bundles, 3000, note \"4 pieces\".",
  "- low: set true ONLY when you genuinely had to guess (unit unknown, price missing, each-vs-total unclear, doubtful spelling). Omit it otherwise.",
  "- why: under 14 words, plain language, only when you converted/inferred/guessed something. Omit otherwise.",
  "- note: only for sub-unit detail like \"4 pieces\". Omit otherwise.",
  "",
  "TOP-LEVEL FIELDS:",
  "- intent: \"receipt\" if the text mentions a receipt or that payment was made/received, else \"quote\".",
  "- clientName: the customer, from words like client / for / to / mr / mrs / chief / engr + name; else null.",
  "- workmanship: a number for labour / workmanship / installation / service fee kept separate from materials; else null.",
  "- unparsed: text fragments that are neither an item nor any field above (never silently drop text). [] if none.",
  "",
  "Reply with ONE JSON object only, no markdown, no commentary. Omit item keys that are empty.",
  "",
  "EXAMPLE 1",
  "INPUT: client mr ade. 1.5 wire 2 roll 28k, 2.5 wire 3 roll 42k each, sockets 1 box 15000",
  "OUTPUT: {\"intent\":\"quote\",\"clientName\":\"Mr Ade\",\"workmanship\":null,\"items\":[{\"name\":\"1.5mm wire\",\"qty\":2,\"uom\":\"rolls\",\"price\":28000,\"basis\":\"each\",\"low\":true,\"why\":\"Unclear if 28k is each or total\"},{\"name\":\"2.5mm wire\",\"qty\":3,\"uom\":\"rolls\",\"price\":42000,\"basis\":\"each\"},{\"name\":\"Socket\",\"qty\":1,\"uom\":\"box\",\"price\":15000,\"basis\":\"each\"}],\"unparsed\":[]}",
  "",
  "EXAMPLE 2",
  "INPUT: cment 5 bag 27500 total, 20mm pipe 4 bundle 3500 each. labour 15000",
  "OUTPUT: {\"intent\":\"quote\",\"clientName\":null,\"workmanship\":15000,\"items\":[{\"name\":\"Cement\",\"qty\":5,\"uom\":\"bags\",\"price\":27500,\"basis\":\"total\"},{\"name\":\"20mm pipe\",\"qty\":4,\"uom\":\"bundles\",\"price\":3500,\"basis\":\"each\"}],\"unparsed\":[]}",
  "",
  "EXAMPLE 3",
  "INPUT: receipt for chief. paid. 4 pieces of 2 bundles 25mm pipe at 4200 per bundle. bring change tomorrow",
  "OUTPUT: {\"intent\":\"receipt\",\"clientName\":\"Chief\",\"workmanship\":null,\"items\":[{\"name\":\"25mm pipe\",\"qty\":2,\"uom\":\"bundles\",\"price\":4200,\"basis\":\"each\",\"note\":\"4 pieces\"}],\"unparsed\":[\"bring change tomorrow\"]}",
  "",
  "EXAMPLE 4",
  "INPUT: switch 2 box, bulb holder 1 box, 1 roll flex",
  "OUTPUT: {\"intent\":\"quote\",\"clientName\":null,\"workmanship\":null,\"items\":[{\"name\":\"Switch\",\"qty\":2,\"uom\":\"boxes\",\"price\":0,\"basis\":\"each\",\"low\":true,\"why\":\"No price typed\"},{\"name\":\"Bulb holder\",\"qty\":1,\"uom\":\"box\",\"price\":0,\"basis\":\"each\",\"low\":true,\"why\":\"No price typed\"},{\"name\":\"Flex\",\"qty\":1,\"uom\":\"roll\",\"price\":0,\"basis\":\"each\",\"low\":true,\"why\":\"No price typed\"}],\"unparsed\":[]}"
].join("\n");

function buildMessages(text, hintEntries) {
  const hints = hintEntries.length
    ? "USUAL PRICES (only for sanity-checking what was typed; do NOT copy them in):\n" +
      hintEntries.map(e => `- ${e.label} per ${e.uom}: about ${Math.round(e.usual)}`).join("\n") + "\n\n"
    : "";
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${hints}INPUT: ${text}\nOUTPUT:` }
  ];
}

/* Models sometimes wrap JSON in fences or add a sentence — take the outermost {...}. */
function extractJson(raw) {
  const s = String(raw || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

/* Accept both the compact keys the prompt asks for and the long names, so a model
   that drifts slightly from the format still produces usable rows. */
function normaliseRawItem(r) {
  const basis = r.basis || r.priceBasis;
  return {
    name: r.name,
    qty: r.qty,
    uom: r.uom,
    price: r.price,
    note: r.note || null,
    priceBasis: basis === "total" || basis === "line_total" ? "line_total" : "per_unit",
    confidence: r.low === true || r.confidence === "low" ? "low" : "high",
    assumption: r.why || r.assumption || null
  };
}

/* Resolves with null if it takes too long, so a slow storage call never eats the AI's time. */
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);
}

exports.handler = async (event) => {
  const startedAt = Date.now();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const denied = checkAccess(event);
  if (denied) return denied;

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return json(500, { error: "NVIDIA_API_KEY is not set in Netlify environment variables", code: "not_configured" });

  const body = readJsonBody(event);
  if (!body) return json(400, { error: "Invalid JSON body" });
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT_CHARS) : "";
  if (!text) return json(400, { error: "Missing 'text'" });

  const manual = (Array.isArray(body.knownPricing) ? body.knownPricing : [])
    .slice(0, 200)
    .filter(p => p && p.name && Number(p.price) > 0)
    .map(p => ({ name: String(p.name).slice(0, 80), uom: String(p.uom || "").slice(0, 20), price: Number(p.price) }));

  // Learned prices are a bonus: if storage is missing or slow, parsing carries on without them.
  let learned = [];
  try {
    const store = await withTimeout(core.openStore(event), 1500);
    const book = store ? await withTimeout(core.loadBook(store), 1500) : null;
    if (book) learned = core.relevantEntries(book, text);
  } catch (err) {
    console.warn("[parse] price book unavailable:", err && err.message);
  }

  const hintEntries = [
    ...manual.slice(0, 6).map(p => ({ label: p.name, uom: p.uom || "unit", usual: p.price })),
    ...learned.slice(0, 8)
  ].slice(0, 12);

  const remaining = TIME_BUDGET_MS - (Date.now() - startedAt);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1500, remaining));

  try {
    const response = await fetch(NVIDIA_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.NVIDIA_MODEL || DEFAULT_MODEL,
        messages: buildMessages(text, hintEntries),
        temperature: 0.1,
        max_tokens: 700
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return json(502, { error: "NVIDIA API error", code: "upstream", status: response.status, detail });
    }

    const data = await response.json();
    const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed.items)) {
      return json(502, { error: "Model did not return usable JSON", code: "bad_json", raw: String(raw || "").slice(0, 300) });
    }

    const items = core.reconcileItems(parsed.items.map(normaliseRawItem), learned, manual);

    return json(200, {
      intent: parsed.intent === "receipt" ? "receipt" : "quote",
      clientName: parsed.clientName ? String(parsed.clientName).slice(0, 80) : null,
      workmanship: Number(parsed.workmanship) > 0 ? Number(parsed.workmanship) : null,
      items,
      unparsed: (Array.isArray(parsed.unparsed) ? parsed.unparsed : []).map(x => String(x).slice(0, 120)).slice(0, 10),
      meta: { ms: Date.now() - startedAt, model: process.env.NVIDIA_MODEL || DEFAULT_MODEL, usedLearnedPrices: learned.length }
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      return json(504, { error: "The AI took too long to answer", code: "timeout", ms: Date.now() - startedAt });
    }
    console.error("[parse] error:", err);
    return json(500, { error: (err && err.message) || "Unknown error", code: "error" });
  }
};

exports._internals = { buildMessages, extractJson, normaliseRawItem, SYSTEM_PROMPT };
