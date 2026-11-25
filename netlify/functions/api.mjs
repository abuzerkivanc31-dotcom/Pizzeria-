// Netlify-Funktion: speichert Status, Preisumstellung und Preise des Inhabers (Netlify Blobs).
// Die PIN steht NICHT im Code, sondern in der Netlify-Umgebungsvariable OWNER_PIN.
//   GET  /api/status   -> Status + manuell umgestellte Preisliste
//   GET  /api/prices   -> vom Inhaber geänderte Preise
//   GET  /api/events   -> Eventtage (von events-refresh.mjs aktualisiert)
//   POST /api/status   -> { pin, state: "open"|"closed"|"auto" }  oder  { pin, kind: "pmode", mode: "d"|"e"|null, until }
//   POST /api/prices   -> { pin, prices: {...} }
import { getStore } from "@netlify/blobs";

export const config = { path: "/api/*" };

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const GUELTIG_MS = 16 * 3600 * 1000; // Status "geöffnet/geschlossen" gilt höchstens 16 Stunden
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default async (req) => {
  const store = getStore("pizzeria");
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
    const pin = Netlify.env.get("OWNER_PIN");
    if (!pin || !same(String(b.pin || ""), pin)) {
      await sleep(1000); // bremst das Ausprobieren von PINs
      return json({ error: "pin" }, 403);
    }
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
  }
  return json({ error: "not found" }, 404);
};
