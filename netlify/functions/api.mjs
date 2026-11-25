// Netlify-Funktion: Status, Preisumschaltung, Preise des Inhabers und Bestellanfragen (Netlify Blobs).
// Die PIN steht NICHT im Code, sondern in der Netlify-Umgebungsvariable OWNER_PIN.
//   GET  /api/status        -> Status + manuell umgestellte Preisliste
//   GET  /api/prices        -> vom Inhaber geänderte Preise
//   GET  /api/events        -> Eventtage (von events-refresh.mjs aktualisiert)
//   POST /api/orders        -> Bestellanfrage speichern (öffentlich, begrenzt, 30 Tage aufbewahrt)
//   POST /api/login         -> { pin }  prüft die Inhaber-PIN
//   POST /api/status        -> { pin, state: "open"|"closed"|"auto" }  oder  { pin, kind: "pmode", mode: "d"|"e"|null, until }
//   POST /api/prices        -> { pin, prices: {...} }
//   POST /api/orders/list   -> { pin }  Bestellanfragen ansehen
//   POST /api/orders/delete -> { pin, id } oder { pin, all: true }
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const GUELTIG_MS = 16 * 3600 * 1000;        // Status "geöffnet/geschlossen" gilt höchstens 16 Stunden
const ORDER_TTL_MS = 30 * 24 * 3600 * 1000; // Bestellanfragen werden nach 30 Tagen gelöscht
const ORDER_LIMIT = 5;                      // höchstens 5 Anfragen pro IP in 10 Minuten
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

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

// alte Bestellanfragen und alte Zähler löschen (Zeitstempel steckt im Schlüssel)
async function cleanup(store) {
  const now = Date.now();
  const { blobs } = await store.list({ prefix: "o:" });
  await Promise.all(blobs.filter((b) => now - Number(b.key.split(":")[1]) > ORDER_TTL_MS).map((b) => store.delete(b.key)));
  const rl = await store.list({ prefix: "rl:" });
  const win = Math.floor(now / 600000);
  await Promise.all(rl.blobs.filter((b) => Number(b.key.split(":")[2]) < win - 1).map((b) => store.delete(b.key)));
}

async function saveOrder(b, context, orders) {
  const name = str(b.name, 80);
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 40).map((l) => str(l, 400)).filter(Boolean) : [];
  if (!name || !lines.length) return json({ error: "invalid" }, 400);
  // Missbrauchsschutz: gekürzter Prüfwert der IP-Adresse, nur für das Zählen
  const ipHash = await shortHash(context && context.ip ? context.ip : "unbekannt");
  const rlKey = `rl:${ipHash}:${Math.floor(Date.now() / 600000)}`;
  const count = Number((await orders.get(rlKey)) || 0);
  if (count >= ORDER_LIMIT) return json({ error: "limit" }, 429);
  await orders.set(rlKey, String(count + 1));
  const t = Date.now();
  const id = `${t}:${Math.random().toString(36).slice(2, 8)}`;
  await orders.setJSON(`o:${id}`, {
    id,
    t,
    name,
    type: b.type === "Lieferung" ? "Lieferung" : "Abholung",
    addr: b.type === "Lieferung" ? str(b.addr, 200) : "",
    time: str(b.time, 100),
    note: str(b.note, 500),
    lines,
    total: Math.max(0, Math.min(5000, Number(b.total) || 0)),
  });
  await cleanup(orders);
  return json({ ok: true });
}

async function listOrders(orders) {
  await cleanup(orders);
  const { blobs } = await orders.list({ prefix: "o:" });
  const all = await Promise.all(blobs.slice(0, 300).map((b) => orders.get(b.key, { type: "json" })));
  return all.filter(Boolean).sort((a, b) => b.t - a.t);
}

export default async (req, context) => {
  const store = getStore("pizzeria");
  const orders = getStore("pizzeria-orders");
  const path = new URL(req.url).pathname.replace(/\/+$/, "").replace(/^\/api/, "");

  if (req.method === "GET") {
    if (path === "/status") {
      const s = (await store.get("status", { type: "json" })) || {};
      const m = await store.get("pmode", { type: "json" });
      if (m && m.until > Date.now()) s.pmode = m;
      return json(s);
    }
    if (path === "/prices") return json((await store.get("prices", { type: "json" })) || {});
    if (path === "/events") return json((await store.get("events", { type: "json" })) || {});
    return json({ error: "not found" }, 404);
  }

  if (req.method === "POST") {
    let b = {};
    try { b = await req.json(); } catch (e) {}

    if (path === "/orders") return saveOrder(b, context, orders); // öffentlich

    const pin = Netlify.env.get("OWNER_PIN");
    if (!pin || !same(String(b.pin || ""), pin)) {
      await sleep(1000); // bremst das Ausprobieren von PINs
      return json({ error: "pin" }, 403);
    }
    if (path === "/login") return json({ ok: true });
    if (path === "/status") {
      if (b.kind === "pmode") {
        if ((b.mode === "d" || b.mode === "e") && Number(b.until) > Date.now()) {
          await store.setJSON("pmode", { mode: b.mode, until: Number(b.until) });
        } else await store.delete("pmode");
        return json({});
      }
      if (b.state === "open" || b.state === "closed") {
        const v = { state: b.state, set: Date.now(), expires: Date.now() + GUELTIG_MS };
        await store.setJSON("status", v);
        return json(v);
      }
      await store.delete("status"); // "auto"
      return json({});
    }
    if (path === "/prices") {
      const p = b.prices && typeof b.prices === "object" ? b.prices : {};
      if (Object.keys(p).length) await store.setJSON("prices", { prices: p });
      else await store.delete("prices");
      return json({ ok: true });
    }
    if (path === "/orders/list") return json({ orders: await listOrders(orders) });
    if (path === "/orders/delete") {
      if (b.all) {
        const { blobs } = await orders.list({ prefix: "o:" });
        await Promise.all(blobs.map((x) => orders.delete(x.key)));
      } else if (typeof b.id === "string" && /^\d+:[a-z0-9]+$/.test(b.id)) {
        await orders.delete(`o:${b.id}`);
      }
      return json({ ok: true });
    }
  }
  return json({ error: "not found" }, 404);
};
