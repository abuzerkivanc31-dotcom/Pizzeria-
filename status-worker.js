// Cloudflare Worker: speichert den vom Inhaber gesetzten Status ("geöffnet" / "geschlossen")
// und die vom Inhaber geänderten Preise.
// Einrichtung: Cloudflare -> Workers & Pages -> Worker anlegen, diesen Code einfügen,
// KV-Namespace mit dem Binding-Namen STATUS verbinden und ein Secret PIN setzen (Inhaber-PIN).
// Die Adresse des Workers trägt man oben in index.html bei STATUS_API ein (ohne Schrägstrich am Ende).

const H = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "content-type": "application/json",
  "cache-control": "no-store",
};
const GUELTIG_STUNDEN = 16; // danach wird wieder automatisch angezeigt

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: H });
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    const isPrices = path.endsWith("/prices");

    if (req.method === "POST") {
      let b = {};
      try { b = await req.json(); } catch (e) {}
      if (!env.PIN || b.pin !== env.PIN) return new Response('{"error":"pin"}', { status: 403, headers: H });

      if (isPrices) {
        const p = b.prices && typeof b.prices === "object" ? b.prices : {};
        if (Object.keys(p).length) await env.STATUS.put("p", JSON.stringify({ prices: p }));
        else await env.STATUS.delete("p");
        return new Response('{"ok":true}', { headers: H });
      }
      if (b.kind === "pmode") { // Preisliste manuell umgeschaltet (mode "d" oder "e"), oder wieder automatisch
        if ((b.mode === "d" || b.mode === "e") && Number(b.until) > Date.now()) await env.STATUS.put("m", JSON.stringify({ mode: b.mode, until: Number(b.until) }));
        else await env.STATUS.delete("m");
        return new Response("{}", { headers: H });
      }
      if (b.state === "open" || b.state === "closed") {
        const v = { state: b.state, set: Date.now(), expires: Date.now() + GUELTIG_STUNDEN * 3600 * 1000 };
        await env.STATUS.put("s", JSON.stringify(v));
        return new Response(JSON.stringify(v), { headers: H });
      }
      await env.STATUS.delete("s"); // "auto"
      return new Response("{}", { headers: H });
    }
    if (isPrices) return new Response((await env.STATUS.get("p")) || "{}", { headers: H });
    const s = JSON.parse((await env.STATUS.get("s")) || "{}");
    const m = JSON.parse((await env.STATUS.get("m")) || "null");
    if (m && m.until > Date.now()) s.pmode = m;
    return new Response(JSON.stringify(s), { headers: H });
  },
};
