// Cloudflare Worker: Status, Preisumschaltung, Preise des Inhabers und Bestellanfragen (Workers KV)
// plus zeitgesteuert (alle 6 Stunden) die Eventtage der YAYLA Arena.
// Die PIN steht NICHT im Code, sondern im Cloudflare-Secret OWNER_PIN.
//   GET  /api/status        -> Status + manuell umgestellte Preisliste
//   GET  /api/prices        -> vom Inhaber geänderte Preise
//   GET  /api/events        -> Eventtage
//   POST /api/orders        -> Bestellanfrage speichern (öffentlich, begrenzt, 30 Tage aufbewahrt)
//   POST /api/login         -> { pin }
//   POST /api/status        -> { pin, state: "open"|"closed"|"auto" }  oder  { pin, kind: "pmode", mode: "d"|"e"|null, until }
//   POST /api/prices        -> { pin, prices: {...} }
//   POST /api/orders/list   -> { pin }
//   POST /api/orders/delete -> { pin, id } oder { pin, all: true }

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const GUELTIG_MS = 16 * 3600 * 1000;        // Status "geöffnet/geschlossen" gilt höchstens 16 Stunden
const ORDER_TTL_S = 30 * 24 * 3600;         // Bestellanfragen werden nach 30 Tagen automatisch gelöscht
const ORDER_LIMIT = 5;                      // höchstens 5 Anfragen pro IP in 10 Minuten
const OFFEN_VOR_BEGINN_STUNDEN = 4;         // der Laden öffnet so viele Stunden vor Veranstaltungsbeginn
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const getJSON = (kv, key) => kv.get(key, { type: "json" });
const setJSON = (kv, key, val, opts) => kv.put(key, JSON.stringify(val), opts);

function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function shortHash(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("pizzeria:" + s));
  return [...new Uint8Array(d)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function saveOrder(b, req, kv) {
  const name = str(b.name, 80);
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 40).map((l) => str(l, 400)).filter(Boolean) : [];
  if (!name || !lines.length) return json({ error: "invalid" }, 400);
  // Missbrauchsschutz: gekürzter Prüfwert der IP-Adresse, nur für das Zählen
  const ipHash = await shortHash(req.headers.get("cf-connecting-ip") || "unbekannt");
  const rlKey = `rl:${ipHash}:${Math.floor(Date.now() / 600000)}`;
  const count = Number((await kv.get(rlKey)) || 0);
  if (count >= ORDER_LIMIT) return json({ error: "limit" }, 429);
  await kv.put(rlKey, String(count + 1), { expirationTtl: 1200 });
  const t = Date.now();
  const id = `${t}:${Math.random().toString(36).slice(2, 8)}`;
  await setJSON(kv, `o:${id}`, {
    id,
    t,
    name,
    type: b.type === "Lieferung" ? "Lieferung" : "Abholung",
    addr: b.type === "Lieferung" ? str(b.addr, 200) : "",
    time: str(b.time, 100),
    note: str(b.note, 500),
    lines,
    total: Math.max(0, Math.min(5000, Number(b.total) || 0)),
  }, { expirationTtl: ORDER_TTL_S });
  return json({ ok: true });
}

async function listOrders(kv) {
  const { keys } = await kv.list({ prefix: "o:", limit: 300 });
  const all = await Promise.all(keys.map((k) => getJSON(kv, k.name)));
  return all.filter(Boolean).sort((a, b) => b.t - a.t);
}

async function handleApi(req, env) {
  const kv = env.DATA;
  const path = new URL(req.url).pathname.replace(/\/+$/, "").replace(/^\/api/, "");

  if (req.method === "GET") {
    if (path === "/status") {
      const s = (await getJSON(kv, "status")) || {};
      const m = await getJSON(kv, "pmode");
      if (m && m.until > Date.now()) s.pmode = m;
      return json(s);
    }
    if (path === "/prices") return json((await getJSON(kv, "prices")) || {});
    if (path === "/events") return json((await getJSON(kv, "events")) || {});
    if (path === "/diag") return json({ set: !!env.OWNER_PIN, len: String(env.OWNER_PIN || "").length, digits: /^\d+$/.test(String(env.OWNER_PIN || "")) });
    return json({ error: "not found" }, 404);
  }

  if (req.method === "POST") {
    let b = {};
    try { b = await req.json(); } catch (e) {}

    if (path === "/orders") return saveOrder(b, req, kv); // öffentlich

    const pin = env.OWNER_PIN;
    if (!pin || !same(String(b.pin || "").trim(), String(pin).trim())) {
      await sleep(1000); // bremst das Ausprobieren von PINs
      return json({ error: "pin" }, 403);
    }
    if (path === "/login") return json({ ok: true });
    if (path === "/status") {
      if (b.kind === "pmode") {
        if ((b.mode === "d" || b.mode === "e") && Number(b.until) > Date.now()) {
          await setJSON(kv, "pmode", { mode: b.mode, until: Number(b.until) });
        } else await kv.delete("pmode");
        return json({});
      }
      if (b.state === "open" || b.state === "closed") {
        const v = { state: b.state, set: Date.now(), expires: Date.now() + GUELTIG_MS };
        await setJSON(kv, "status", v);
        return json(v);
      }
      await kv.delete("status"); // "auto"
      return json({});
    }
    if (path === "/prices") {
      const p = b.prices && typeof b.prices === "object" ? b.prices : {};
      if (Object.keys(p).length) await setJSON(kv, "prices", { prices: p });
      else await kv.delete("prices");
      return json({ ok: true });
    }
    if (path === "/orders/list") return json({ orders: await listOrders(kv) });
    if (path === "/orders/delete") {
      if (b.all) {
        const { keys } = await kv.list({ prefix: "o:" });
        await Promise.all(keys.map((x) => kv.delete(x.name)));
      } else if (typeof b.id === "string" && /^\d+:[a-z0-9]+$/.test(b.id)) {
        await kv.delete(`o:${b.id}`);
      }
      return json({ ok: true });
    }
  }
  return json({ error: "not found" }, 404);
}

// ---------- Eventtage der YAYLA Arena ----------
const dec = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const pad = (n) => String(n).padStart(2, "0");

export function parseEvents(html) {
  const out = [];
  const items = html.split('class="archive-list__item"').slice(1);
  for (const it of items) {
    const dm = it.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    const sm = it.match(/yayla-arena\.de\/event\/([^/"]+)\//);
    const bm = it.match(/Beginn:\s*(\d{1,2}:\d{2})/) || it.match(/(\d{1,2}:\d{2}) Uhr/);
    if (!dm || !sm || !bm) continue;
    const tm = it.match(/class="title">\s*([^<]+?)\s*</);
    const sub = it.match(/class="short-description">\s*([^<]*?)\s*</);
    const [h, m] = bm[1].split(":").map(Number);
    const open = Math.max(0, h * 60 + m - OFFEN_VOR_BEGINN_STUNDEN * 60);
    out.push({
      date: `${dm[3]}-${dm[2]}-${dm[1]}`,
      title: tm ? dec(tm[1]) : sm[1],
      subtitle: sub ? dec(sub[1]) : "",
      start: `${pad(h)}:${pad(m)}`,
      open: `${pad(Math.floor(open / 60))}:${pad(open % 60)}`,
      url: `https://yayla-arena.de/event/${sm[1]}/`,
      _k: `${dm[3]}-${dm[2]}-${dm[1]}|${sm[1]}`,
    });
  }
  return out;
}

async function refreshEvents(env) {
  const all = new Map();
  const now = new Date();
  for (let k = 0; k < 7; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    const url = `https://yayla-arena.de/veranstaltungskalender/?_m=${d.getUTCMonth() + 1}&_y=${d.getUTCFullYear()}`;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      for (const e of parseEvents(await r.text())) all.set(e._k, e);
    } catch (e) {
      console.log("Fehler bei", url, String(e));
    }
  }
  const events = [...all.values()]
    .map(({ _k, ...e }) => e)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  if (!events.length) {
    console.log("Keine Termine gefunden, alte Daten bleiben erhalten.");
    return;
  }
  await setJSON(env.DATA, "events", { updated: new Date().toISOString(), events });
  console.log(`${events.length} Termine gespeichert.`);
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(req, env);
    return env.ASSETS.fetch(req); // normale Seiten aus dem Ordner "public"
  },
  // Cron: "0 */6 * * *" = 00:00, 06:00, 12:00, 18:00 UTC
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshEvents(env));
  },
};
