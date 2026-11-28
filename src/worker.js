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
// Lieferkosten nach Fahrstrecke (Google Routes API): bis 1 km / 3 km / 5 km / darüber
const SHOP_ADDR = "Westparkstraße 102, 47803 Krefeld, Germany";
function tierFor(km) {
  if (km <= 1) return { min: 20, fee: 0 };
  if (km <= 3) return { min: 25, fee: 1 };
  if (km <= 5) return { min: 30, fee: 2 };
  return { min: 35, fee: 3 };
}
async function routeKm(env, addr) {
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
    },
    body: JSON.stringify({
      origin: { address: SHOP_ADDR },
      destination: { address: addr },
      travelMode: "DRIVE",
      regionCode: "DE",
      languageCode: "de",
      units: "METRIC",
    }),
  });
  if (!r.ok) return { error: r.status === 400 || r.status === 404 ? "addr" : "upstream" };
  const j = await r.json();
  if (!j.routes || !j.routes[0]) return { error: "addr" };
  return { km: (j.routes[0].distanceMeters || 0) / 1000, sec: parseInt(String(j.routes[0].duration || "0"), 10) || 0 };
}
// Prüft, ob eine Adresse wirklich existiert (Google Places): Straße mit Hausnummer und PLZ müssen gefunden werden.
async function checkAddr(env, addr) {
  const a = String(addr || "").trim();
  const plz = (a.match(/\b(\d{5})\b/) || [])[1] || "";
  const num = (a.match(/(\d+\s*[a-zA-Z]?)\s*,/) || [])[1] || "";
  if (!plz || !num || !env.GOOGLE_MAPS_KEY) return { error: "addr" };
  // Straßenname muss zum gefundenen Treffer passen (sonst nimmt Google eine ähnliche Straße)
  const sn = (s) => String(s || "").toLowerCase().replace(/ß/g, "ss").replace(/strasse|str\./g, "str").replace(/[^a-z0-9äöü]/g, "");
  const sIn = sn((a.match(/^(.*?)\s*\d/) || [])[1]);
  if (sIn.length < 3) return { error: "addr" };
  const key = "av2:" + (await shortHash(a.toLowerCase()));
  if ((await env.DATA.get(key)) === "ok") return { ok: true };
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", { method: "POST", headers: { "content-type": "application/json", "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY, "X-Goog-FieldMask": "places.addressComponents,places.formattedAddress" }, body: JSON.stringify({ textQuery: a, languageCode: "de", regionCode: "DE" }) });
  if (!r.ok) return { error: "upstream" };
  const j = await r.json().catch(() => ({}));
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
  const p = (j.places || []).find((x) => {
    const c = x.addressComponents || [];
    const get = (t) => (c.find((k) => (k.types || []).includes(t)) || {}).longText || "";
    const rt = sn(get("route"));
    return get("postal_code") === plz && norm(get("street_number")) === norm(num) && !!rt && (rt === sIn || rt.startsWith(sIn) || sIn.startsWith(rt));
  });
  if (!p) return { error: "addr" };
  await env.DATA.put(key, "ok", { expirationTtl: 30 * 86400 });
  return { ok: true, formatted: p.formattedAddress || a };
}
async function handleRoute(b, req, env) {
  if (!env.GOOGLE_MAPS_KEY) return json({ error: "nokey" }, 503);
  let addr = str(b.addr, 200);
  if (addr.length < 6) return json({ error: "addr" }, 400);
  if (!/\d{5}/.test(addr) && !addr.includes(",")) addr += ", Krefeld"; // ohne Ort: Krefeld annehmen
  // Missbrauchsschutz: höchstens 15 Berechnungen pro IP in 10 Minuten
  const ipHash = await shortHash(req.headers.get("cf-connecting-ip") || "unbekannt");
  const rlKey = `rr:${ipHash}:${Math.floor(Date.now() / 600000)}`;
  const count = Number((await env.DATA.get(rlKey)) || 0);
  if (count >= 15) return json({ error: "limit" }, 429);
  await env.DATA.put(rlKey, String(count + 1), { expirationTtl: 1200 });
  const v = await checkAddr(env, addr);
  if (v.error) return json({ error: v.error }, v.error === "addr" ? 422 : 502);
  const r = await routeKm(env, addr);
  if (r.error) return json({ error: r.error }, r.error === "addr" ? 422 : 502);
  return json({ km: Math.round(r.km * 10) / 10, ...tierFor(r.km) });
}

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

const okMail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || ""));
// Fortlaufende Bestellnummern: online bezahlt O1, O2 ...; Zahlung vor Ort und WhatsApp-Anfragen 1, 2 ...
async function setOrderNo(kv, rec, online) {
  if (rec.no) return rec.no;
  const key = online ? "ordseq_o" : "ordseq";
  const n = (Number(await kv.get(key)) || 0) + 1;
  await kv.put(key, String(n));
  rec.no = (online ? "O" : "") + n;
  await kv.put("on:" + rec.no, rec.id, { expirationTtl: ORDER_TTL_S });
  return rec.no;
}
// Wunschzeit: leer (= so schnell wie möglich, nur heute) oder "HH:MM" an einem Tag bis 7 Tage im Voraus (Vorbestellung),
// jeweils innerhalb der Öffnungszeiten (regulär Mo–Fr 07:30–15:30, an Eventtagen ab Öffnung). Gleiche Regeln wie die Seite.
async function checkWish(env, t, date) {
  t = String(t || "").trim();
  date = String(date || "").trim();
  const now = Date.now(), bn = berlinNow(), today = berlinDate(now);
  if (!date) date = today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "time" };
  const days = Math.round((Date.parse(date + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 86400000);
  if (!(days >= 0 && days <= 7)) return { error: "time" };
  if (!t) return days === 0 ? { ok: true, time: "", date: "" } : { error: "time" };
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[2]) > 59) return { error: "time" };
  const tm = Number(m[1]) * 60 + Number(m[2]);
  if (tm >= 1440) return { error: "time" };
  const win = [];
  if (days === 0) {
    if (tm < bn.m - 5) return { error: "time" };
    const st = await getJSON(env.DATA, "status");
    if (st && st.state && st.expires > now) { if (st.state === "closed") return { error: "time" }; win.push([0, 1440]); }
  }
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  if (dow >= 1 && dow <= 5) win.push([450, 930]);
  let evs = ((await getJSON(env.DATA, "events")) || {}).events || [];
  if (!evs.length) { try { evs = (await (await env.ASSETS.fetch(new URL("/events.json", "https://pizzeria-koenigspalast.de"))).json()).events || []; } catch (e) { evs = []; } }
  for (const e of evs) if (e.date === date && /^\d{1,2}:\d{2}$/.test(e.open || "")) { const [h, mi] = e.open.split(":").map(Number); win.push([h * 60 + mi, 1440]); }
  if (!win.some((x) => tm >= x[0] && tm < x[1])) return { error: "time" };
  return { ok: true, time: m[1].padStart(2, "0") + ":" + m[2], date: days === 0 ? "" : date };
}
// "Sa., 29.11., 18:30 Uhr" bzw. "18:30 Uhr"
const wishStr = (r) => (r && r.time ? (r.date ? new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(r.date + "T12:00:00Z")) + ", " : "") + String(r.time).replace(/\s*uhr$/i, "") + " Uhr" : "");
// ---------- Steuerung im Laden per Telegram: Wartezeit, Lieferung pausieren, Ausverkauft ----------
async function getOps(env) { return (await getJSON(env.DATA, "ops")) || {}; }
function soldOutHit(menu, cart, out) {
  if (!out || !out.length || !Array.isArray(cart)) return "";
  const hit = (s) => out.some((t) => String(s || "").toLowerCase().includes(t));
  for (const l of cart) {
    const [c, i] = String((l && l.key) || "").split("|");
    const it = menu.MENU[c] && menu.MENU[c].items[Number(i)];
    if (it && hit(it[0])) return it[0];
    const tops = l && l.sel && Array.isArray(l.sel.tops) ? l.sel.tops : [];
    for (const tp of tops) if (hit(tp)) return tp;
  }
  return "";
}
async function opsCommand(env, raw) {
  const kv = env.DATA;
  const ops = await getOps(env);
  const save = () => setJSON(kv, "ops", ops);
  const t = raw.replace(/\s+/g, " ").trim();
  const status = () => "Aktueller Stand:\n⏱ Wartezeit: " + (ops.wait ? ops.wait + " Minuten" : "normal") + "\n🛵 Lieferung: " + (ops.delOff ? "PAUSIERT" : "an") + "\n⛔ Ausverkauft: " + ((ops.out || []).join(", ") || "nichts");
  if (/^(hilfe|befehle|\/start|\/help)$/.test(t)) return "So steuerst du die Website per Nachricht:\n• „wartezeit 45“ – Zubereitungszeit auf 45 Minuten setzen (gilt für Lieferzeit-Mails)\n• „wartezeit normal“ – zurück auf normal\n• „lieferung aus“ / „lieferung an“ – Lieferung pausieren oder wieder an\n• „sucuk aus“ – alles mit Sucuk ausverkauft\n• „sucuk an“ – wieder verfügbar\n• „alles an“ – nichts mehr ausverkauft\n• „12 bezahlt“ – Vor-Ort-Bestellung 12 als bezahlt markieren\n• „status“ – aktueller Stand\n• „check“ – alle Funktionen der Website jetzt prüfen";
  if (t === "status") return status();
  let m = t.match(/^warte?zeit:? (\d{1,3})(?: ?min(?:uten)?)?$/);
  if (m) { const n = Number(m[1]); if (n < 10 || n > 180) return "Bitte eine Wartezeit zwischen 10 und 180 Minuten angeben."; ops.wait = n; await save(); return "⏱ Wartezeit ist jetzt " + n + " Minuten. Kunden sehen das auf der Website und in der Lieferzeit-Mail."; }
  if (/^warte?zeit:? (normal|aus|0|zurück|standard)$/.test(t)) { delete ops.wait; await save(); return "⏱ Wartezeit ist wieder normal."; }
  if (/^lieferung (aus|stopp|stop|pause|pausieren)$/.test(t)) { ops.delOff = true; await save(); return "🛵 Lieferung ist pausiert. Kunden können nur noch abholen (oder für einen anderen Tag vorbestellen). Mit „lieferung an“ wieder einschalten."; }
  if (/^lieferung (an|ein|wieder an)$/.test(t)) { ops.delOff = false; await save(); return "🛵 Lieferung ist wieder an."; }
  if (/^alles (an|wieder da|da|verfügbar)$/.test(t)) { ops.out = []; await save(); return "✅ Nichts mehr ausverkauft."; }
  m = t.match(/^(.{3,30}?) (aus|ausverkauft|alle|leer)$/);
  if (m) {
    const term = m[1].replace(/^(die|der|das) /, "");
    let menu = null;
    try { menu = await (await env.ASSETS.fetch(new URL("/menu.json", "https://pizzeria-koenigspalast.de"))).json(); } catch (e) {}
    const names = [];
    if (menu) { for (const c of Object.values(menu.MENU)) for (const it of c.items) if (it[0].toLowerCase().includes(term)) names.push(it[0]); for (const tp of menu.TOPS) if (tp[0].toLowerCase().includes(term)) names.push(tp[0] + " (Zutat)"); }
    if (menu && !names.length) return "❓ Nichts auf der Karte passt zu „" + term + "“. Bitte so schreiben, wie es auf der Karte steht, z. B. „sucuk aus“.";
    ops.out = [...new Set([...(ops.out || []), term])].slice(0, 30);
    await save();
    return "⛔ Ausverkauft: " + term + "\nBetrifft: " + names.slice(0, 12).join(", ") + (names.length > 12 ? " …" : "") + "\nMit „" + term + " an“ wieder verfügbar.";
  }
  m = t.match(/^(.{3,30}?) (an|wieder da|da|verfügbar)$/);
  if (m) { const term = m[1].replace(/^(die|der|das) /, ""); const before = (ops.out || []).length; ops.out = (ops.out || []).filter((x) => x !== term); await save(); return ops.out.length < before ? "✅ " + term + " ist wieder verfügbar." : "ℹ️ „" + term + "“ war nicht als ausverkauft markiert.\n" + status(); }
  return null;
}
// ---------- Bestellstatus (Knöpfe unter der Telegram-Nachricht) ----------
const ST_NAME = { a: "Angenommen", f: "Fertig", u: "Unterwegs" };
async function setOrderStatus(env, no, st, chat) {
  const kv = env.DATA;
  const reply = (t) => tgApi(env, "sendMessage", { chat_id: chat, text: t });
  const id = await kv.get("on:" + no);
  const rec = id && (await getJSON(kv, "o:" + id));
  if (!rec || !ST_NAME[st]) return reply("❓ Bestellung Nr. " + no + " wurde nicht gefunden.");
  if (rec.status === st) return reply("ℹ️ Nr. " + no + " steht schon auf „" + ST_NAME[st] + "“.");
  rec.status = st;
  rec.statusAt = Date.now();
  await setJSON(kv, "o:" + rec.id, rec, { expirationTtl: ORDER_TTL_S });
  let mailed = false;
  const lief = rec.type === "Lieferung";
  if (env.RESEND_API_KEY && rec.email && ((st === "f" && !lief) || (st === "u" && lief))) {
    const subj = st === "f" ? "Deine Bestellung Nr. " + rec.no + " ist fertig zur Abholung 🍕" : "Deine Bestellung Nr. " + rec.no + " ist unterwegs 🛵";
    const txt = "Hallo " + rec.name + ",\n\n" + (st === "f" ? "deine Bestellung Nr. " + rec.no + " ist fertig. Du kannst sie jetzt bei uns abholen: Westparkstraße 102, 47803 Krefeld." : "deine Bestellung Nr. " + rec.no + " ist jetzt unterwegs zu dir (" + rec.addr + "). Bis gleich!") + (rec.paid || rec.cashPaid ? "" : "\nBitte halte den Betrag bereit (bar oder Karte).") + "\n\nPizza & Baguettehaus am Königspalast · 02151 4546528";
    mailed = await sendMail(env, rec.email, subj, txt);
  }
  return reply((st === "a" ? "✅" : st === "f" ? "🍕" : "🛵") + " Nr. " + no + " (" + rec.name + "): " + ST_NAME[st] + "." + (mailed ? " Kunde per E-Mail informiert." : " Kunde sieht den Stand auf der Website."));
}
// ---------- Beliebte Gerichte (aus dem Umsatzbuch der letzten 60 Tage) ----------
async function computePopular(env) {
  try {
    const kv = env.DATA, now = Date.now(), cnt = {};
    for (const ym of [ymOf(now), ymOf(now - 32 * 86400000), ymOf(now - 62 * 86400000)]) {
      let cursor;
      do {
        const r = await kv.list({ prefix: "led:" + ym + ":", cursor, limit: 1000 });
        for (const k of r.keys) { const e = await getJSON(kv, k.name); if (!e || now - e.t > 60 * 86400000) continue; for (const x of e.items || []) if (x.key && x.cat !== "getraenke") cnt[x.key] = (cnt[x.key] || 0) + x.qty; }
        cursor = r.list_complete ? null : r.cursor;
      } while (cursor);
    }
    const keys = Object.entries(cnt).filter((x) => x[1] >= 3).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]);
    await setJSON(kv, "popular", { keys, updated: now });
  } catch (e) { console.log("Beliebt-Fehler", String(e)); }
}
// ---------- Tagesbericht per Telegram (jeden Abend um 23:30 Uhr) ----------
async function dailyReport(env) {
  try {
    const kv = env.DATA, now = Date.now(), bn = berlinNow(), today = berlinDate(now);
    if (!env.TELEGRAM_BOT_TOKEN || bn.m < 23 * 60 + 30 || (await kv.get("dayrep:" + today))) return;
    await kv.put("dayrep:" + today, "1", { expirationTtl: 3 * 86400 });
    const from = Number(await kv.get("dayrep_last")) || berlinEpoch(today, "00:00");
    const S = { n: 0, sum: 0, on: 0, vo: 0, lief: 0 };
    for (const ym of [...new Set([ymOf(from), ymOf(now)])]) {
      let cursor;
      do {
        const r = await kv.list({ prefix: "led:" + ym + ":", cursor, limit: 1000 });
        for (const k of r.keys) { const e = await getJSON(kv, k.name); if (!e || e.t <= from || e.t > now) continue; const v = vatSplit(e); S.n++; S.sum += v.total; if (e.pay === "online") S.on += v.total; else S.vo += v.total; if (e.type === "Lieferung") S.lief++; }
        cursor = r.list_complete ? null : r.cursor;
      } while (cursor);
    }
    let open = 0, wa = 0;
    for (const o of await listOrders(kv)) { if (o.t <= from || o.t > now) continue; if (o.pay === "wa") wa++; else if (o.pay === "vorort" && o.invEmail && !o.cashPaid) open++; }
    const eu = (c) => (c / 100).toFixed(2).replace(".", ",") + " €";
    const text = "📊 Tagesbericht " + new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit" }).format(new Date(now)) + "\n\n" + S.n + " Bestellungen über die Website: " + eu(S.sum) + "\n• online bezahlt: " + eu(S.on) + "\n• Zahlung vor Ort: " + eu(S.vo) + "\n• davon Lieferungen: " + S.lief + (wa ? "\n• WhatsApp-Anfragen: " + wa : "") + (open ? "\n\n🧾 " + open + " Vor-Ort-Bestellung(en) mit Rechnungswunsch noch nicht als bezahlt markiert." : "");
    for (const cid of await tgRecipients(env)) await tgApi(env, "sendMessage", { chat_id: cid, text });
    await kv.put("dayrep_last", String(now));
  } catch (e) { console.log("Tagesbericht-Fehler", String(e)); }
}
// ---------- Bewertungs-Erinnerung (nur mit Häkchen beim Bestellen), am Folgetag um 11 Uhr ----------
async function reviewMails(env) {
  try {
    const kv = env.DATA, now = Date.now(), bn = berlinNow(), today = berlinDate(now);
    if (!env.RESEND_API_KEY || bn.m < 11 * 60 || bn.m > 12 * 60 || (await kv.get("rvday:" + today))) return;
    await kv.put("rvday:" + today, "1", { expirationTtl: 3 * 86400 });
    const yest = berlinDate(now - 86400000);
    const pid = await kv.get("gplace");
    const link = pid ? "https://search.google.com/local/writereview?placeid=" + encodeURIComponent(pid) : "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("Pizza & Baguettehaus am Königspalast Krefeld");
    for (const o of await listOrders(kv)) {
      if (!o.review || o.reviewSent || !o.email || o.pay === "wa" || berlinDate(o.t) !== yest) continue;
      const mk = "rvm:" + (await shortHash(o.email.toLowerCase()));
      if (await kv.get(mk)) continue;
      const ok = await sendMail(env, o.email, "Hat's geschmeckt? ⭐", "Hallo " + o.name + ",\n\nvielen Dank für deine Bestellung gestern. Wir hoffen, es hat dir geschmeckt!\n\nWenn du magst, bewerte uns kurz bei Google. Das dauert eine Minute und hilft uns sehr:\n" + link + "\n\nDiese E-Mail bekommst du nur einmal, weil du es bei der Bestellung angekreuzt hast.\n\nPizza & Baguettehaus am Königspalast");
      if (ok) { o.reviewSent = true; await setJSON(kv, "o:" + o.id, o, { expirationTtl: ORDER_TTL_S }); await kv.put(mk, "1", { expirationTtl: 60 * 86400 }); }
    }
  } catch (e) { console.log("Bewertungs-Mail-Fehler", String(e)); }
}
const addrPartsOf = (b) => { const a = b && b.addrParts && typeof b.addrParts === "object" ? b.addrParts : {}; return { street: str(a.street, 100), hnr: str(a.hnr, 12), plz: str(a.plz, 5), city: str(a.city, 60) }; };
const cartOf = (c) => {
  if (!Array.isArray(c) || !c.length) return null;
  const o = c.slice(0, 40).map((l) => ({ key: String((l && l.key) || "").slice(0, 30), sel: l && l.sel && typeof l.sel === "object" ? l.sel : {}, note: str(l && l.note, 200), qty: Math.max(1, Math.min(30, Math.floor(Number(l && l.qty)) || 1)) }));
  return JSON.stringify(o).length < 20000 ? o : null;
};

async function saveOrder(b, req, env) {
  const kv = env.DATA;
  const name = str(b.name, 80);
  const lines = Array.isArray(b.lines) ? b.lines.slice(0, 40).map((l) => str(l, 400)).filter(Boolean) : [];
  if (!name || !lines.length) return json({ error: "invalid" }, 400);
  const email = str(b.email, 120);
  if (!okMail(email)) return json({ error: "email" }, 400);
  const wt = await checkWish(env, b.time, b.date);
  if (wt.error) return json({ error: "time" }, 400);
  // Missbrauchsschutz: gekürzter Prüfwert der IP-Adresse, nur für das Zählen
  const ipHash = await shortHash(req.headers.get("cf-connecting-ip") || "unbekannt");
  const rlKey = `rl:${ipHash}:${Math.floor(Date.now() / 600000)}`;
  const count = Number((await kv.get(rlKey)) || 0);
  if (count >= ORDER_LIMIT) return json({ error: "limit" }, 429);
  await kv.put(rlKey, String(count + 1), { expirationTtl: 1200 });
  const t = Date.now();
  const id = t + ":" + Math.random().toString(36).slice(2, 8);
  const lief = b.type === "Lieferung";
  const rec = {
    id,
    t,
    name,
    type: lief ? "Lieferung" : "Abholung",
    addr: lief ? str(b.addr, 200) : "",
    time: wt.time,
    date: wt.date,
    note: str(b.note, 500),
    lines,
    total: Math.max(0, Math.min(5000, Number(b.total) || 0)),
    fee: Math.max(0, Math.min(20, Number(b.fee) || 0)),
    km: Math.max(0, Math.min(500, Number(b.km) || 0)),
    email,
    phone: str(String(b.phone || "").replace(/[^\d+ ]/g, ""), 20),
    pay: "wa",
  };
  await setOrderNo(kv, rec, false);
  await setJSON(kv, "o:" + id, rec, { expirationTtl: ORDER_TTL_S });
  await sendConfirm(env, rec);
  await saveAcctFromOrder(env, b.token, { name, phone: rec.phone, ...(lief ? addrPartsOf(b) : {}), fulfil: rec.type, cart: cartOf(b.cart) }, rec);
  return json({ ok: true, no: rec.no });
}

// ---------- Kundenkonten: Datenbank Cloudflare D1 ("pizzeria-kunden", Speicherort EU), Anmeldung mit E-Mail und Passwort ----------
// Tabellen: customers (Konten), sessions (Anmeldungen), cust_orders (Bestellverlauf je Konto).
// Konten, die 2 Jahre nicht genutzt werden, löscht die Zeitsteuerung automatisch.
const ACC_INACTIVE_MS = 730 * 86400000, SESS_MS = 180 * 86400000;
const rndHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, "0")).join("");
let dbInit = false;
async function db(env) {
  if (!env.DB) throw new Error("nodb");
  if (!dbInit) {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE, pw TEXT NOT NULL, salt TEXT NOT NULL, name TEXT DEFAULT '', phone TEXT DEFAULT '', street TEXT DEFAULT '', hnr TEXT DEFAULT '', plz TEXT DEFAULT '', city TEXT DEFAULT '', fulfil TEXT DEFAULT '', created INTEGER NOT NULL, last_seen INTEGER NOT NULL)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, cid INTEGER NOT NULL, expires INTEGER NOT NULL)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS cust_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, cid INTEGER NOT NULL, order_id TEXT NOT NULL UNIQUE, no TEXT, t INTEGER NOT NULL, type TEXT, pay TEXT, total REAL, lines TEXT, cart TEXT)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sess_cid ON sessions(cid)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_co_cid ON cust_orders(cid, t)"),
    ]);
    dbInit = true;
  }
  return env.DB;
}
// Passwort nur als PBKDF2-Prüfwert (SHA-256, 100.000 Runden, eigenes Salz) speichern
async function pwHash(pw, saltHex) {
  const salt = saltHex ? new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(pw)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  const hex = (u) => [...u].map((x) => x.toString(16).padStart(2, "0")).join("");
  return { hash: hex(new Uint8Array(bits)), salt: hex(salt) };
}
const okPw = (p) => typeof p === "string" && p.length >= 8 && p.length <= 200;
async function newSession(D, cid) {
  const token = rndHex(24);
  await D.prepare("INSERT INTO sessions (token, cid, expires) VALUES (?, ?, ?)").bind(token, cid, Date.now() + SESS_MS).run();
  return token;
}
async function acctFromToken(env, token) {
  try {
    if (!env.DB || typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token)) return null;
    const D = await db(env);
    return (await D.prepare("SELECT c.* FROM sessions s JOIN customers c ON c.id = s.cid WHERE s.token = ? AND s.expires > ?").bind(token, Date.now()).first()) || null;
  } catch (e) { return null; }
}
const pubProfile = (c) => ({ email: c.email, name: c.name || "", phone: c.phone || "", street: c.street || "", hnr: c.hnr || "", plz: c.plz || "", city: c.city || "", fulfil: c.fulfil || "" });
// Treue-Aktion: jede 10. Bestellung mit Kundenkonto ist 10 % günstiger (WhatsApp-Anfragen zählen nicht)
async function loyalCount(D, cid) { const r = await D.prepare("SELECT COUNT(*) AS n FROM cust_orders WHERE cid = ? AND pay != 'wa'").bind(cid).first(); return (r && r.n) || 0; }
async function custOrders(D, cid, n) {
  const r = await D.prepare("SELECT no, t, type, pay, total, lines, cart FROM cust_orders WHERE cid = ? ORDER BY t DESC LIMIT ?").bind(cid, n).all();
  const pj = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };
  return (r.results || []).map((o) => ({ no: o.no, t: o.t, type: o.type, pay: o.pay, total: o.total, lines: pj(o.lines, []), cart: pj(o.cart, null) }));
}
async function addCustOrder(env, cid, rec, cart) {
  try {
    const D = await db(env);
    const total = typeof rec.amount === "number" ? rec.amount / 100 : (rec.total || 0) + (rec.fee || 0) + (rec.tip || 0);
    await D.prepare("INSERT OR IGNORE INTO cust_orders (cid, order_id, no, t, type, pay, total, lines, cart) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(cid, rec.id, String(rec.no || ""), rec.t, rec.type || "", rec.pay === "wa" ? "wa" : rec.paid ? "online" : "vorort", Math.round(total * 100) / 100, JSON.stringify(rec.lines || []), JSON.stringify(cart || null)).run();
  } catch (e) { console.log("Kundenbestellung", String(e)); }
}
// Bei einer Bestellung mit Anmeldung: Angaben im Konto aktualisieren und die Bestellung in den Verlauf schreiben
async function saveAcctFromOrder(env, token, d, rec) {
  try {
    const c = await acctFromToken(env, token);
    if (!c) return null;
    const D = await db(env);
    const v = (f) => (d[f] ? String(d[f]) : c[f] || "");
    await D.prepare("UPDATE customers SET name = ?, phone = ?, street = ?, hnr = ?, plz = ?, city = ?, fulfil = ?, last_seen = ? WHERE id = ?").bind(v("name"), v("phone"), v("street"), v("hnr"), v("plz"), v("city"), d.fulfil || c.fulfil || "", Date.now(), c.id).run();
    if (rec) await addCustOrder(env, c.id, rec, d.cart);
    return c.id;
  } catch (e) { return null; }
}
async function deleteCustomer(D, id) {
  await D.batch([D.prepare("DELETE FROM cust_orders WHERE cid = ?").bind(id), D.prepare("DELETE FROM sessions WHERE cid = ?").bind(id), D.prepare("DELETE FROM customers WHERE id = ?").bind(id)]);
}
async function cleanupAccounts(env) {
  try {
    if (!env.DB) return;
    const D = await db(env);
    const r = await D.prepare("SELECT id FROM customers WHERE last_seen < ?").bind(Date.now() - ACC_INACTIVE_MS).all();
    for (const x of r.results || []) await deleteCustomer(D, x.id);
    await D.prepare("DELETE FROM sessions WHERE expires < ?").bind(Date.now()).run();
  } catch (e) { console.log("Konten-Aufräumen", String(e)); }
}
// Roboter-Prüfung (Cloudflare Turnstile) für Anmelden, Registrieren und "Passwort vergessen".
// Aktiv, sobald das Secret TURNSTILE_SECRET gesetzt ist; vorher wird nicht geprüft.
const TS_SITEKEY = "0x4AAAAAAGWW3n4r2lnV1yYk";
async function humanOk(env, token) {
  if (!env.TURNSTILE_SECRET) return true;
  const note = (s) => env.DATA.put("tsstatus", s + " " + new Date().toISOString(), { expirationTtl: 30 * 86400 }).catch(() => {});
  if (typeof token !== "string" || !token || token.length > 2048) { await note("kein-token"); return false; }
  try {
    const f = new FormData();
    f.append("secret", String(env.TURNSTILE_SECRET).trim());
    f.append("response", token);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: f });
    const j = await r.json().catch(() => ({}));
    // Ergebnis für die Fehlersuche merken (ohne personenbezogene Daten)
    await note(j.success === true ? "ok" : "fehler " + ((j["error-codes"] || []).join(",") || "http-" + r.status));
    return j.success === true;
  } catch (e) { await note("ausnahme"); return false; }
}
async function handleAcct(path, b, req, env) {
  if (!env.DB) return json({ error: "nodb" }, 503);
  const D = await db(env);
  const kv = env.DATA, now = Date.now();
  const email = str(b.email, 120).toLowerCase();
  const ipHash = await shortHash(req.headers.get("cf-connecting-ip") || "unbekannt");
  const limited = async (k, n) => {
    const key = "acl:" + k + ":" + ipHash + ":" + Math.floor(now / 600000);
    const c = Number((await kv.get(key)) || 0);
    if (c >= n) return true;
    await kv.put(key, String(c + 1), { expirationTtl: 1200 });
    return false;
  };
  const byMail = () => (okMail(email) ? D.prepare("SELECT * FROM customers WHERE email = ?").bind(email).first() : null);
  if (path === "/acct/register") {
    if (await limited("reg", 5)) return json({ error: "limit" }, 429);
    if (!(await humanOk(env, b.cf))) return json({ error: "bot" }, 403);
    const name = str(b.name, 80);
    if (!okMail(email)) return json({ error: "email" }, 400);
    if (!name) return json({ error: "name" }, 400);
    if (!okPw(b.password)) return json({ error: "pw" }, 400);
    if (await byMail()) return json({ error: "exists" }, 409);
    const h = await pwHash(b.password);
    const r = await D.prepare("INSERT INTO customers (email, pw, salt, name, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)").bind(email, h.hash, h.salt, name, now, now).run();
    const cid = r.meta.last_row_id;
    const token = await newSession(D, cid);
    if (env.RESEND_API_KEY) await sendMail(env, email, "Willkommen: Dein Kundenkonto ist eingerichtet", "Hallo " + name + ",\n\ndein Kundenkonto bei pizzeria-koenigspalast.de ist eingerichtet. Ab jetzt sind deine Angaben beim Bestellen schon ausgefüllt, und unter „Mein Konto“ findest du alle deine Bestellungen.\n\nWenn du dieses Konto nicht angelegt hast, antworte bitte auf diese E-Mail. Wir löschen es dann.\n\nPizza & Baguettehaus am Königspalast");
    return json({ token, profile: pubProfile({ email, name }), orders: [], loyal: 0 });
  }
  if (path === "/acct/login") {
    if (await limited("login", 10)) return json({ error: "limit" }, 429);
    if (!(await humanOk(env, b.cf))) return json({ error: "bot" }, 403);
    const c = await byMail();
    const ok = c && same((await pwHash(String(b.password || ""), c.salt)).hash, c.pw);
    if (!ok) { await sleep(600); return json({ error: "login" }, 401); }
    await D.prepare("UPDATE customers SET last_seen = ? WHERE id = ?").bind(now, c.id).run();
    const token = await newSession(D, c.id);
    return json({ token, profile: pubProfile(c), orders: await custOrders(D, c.id, 30), loyal: await loyalCount(D, c.id) });
  }
  if (path === "/acct/reset-code") {
    if (!env.RESEND_API_KEY) return json({ error: "nomail" }, 503);
    if (await limited("rc", 5)) return json({ error: "limit" }, 429);
    if (!(await humanOk(env, b.cf))) return json({ error: "bot" }, 403);
    if (!okMail(email)) return json({ error: "email" }, 400);
    const c = await byMail();
    if (c) {
      const ck = "pwr:" + c.id;
      const old = await getJSON(kv, ck);
      if (old && now - old.at < 60000) return json({ error: "wait" }, 429);
      const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
      await setJSON(kv, ck, { code, at: now, tries: 0 }, { expirationTtl: 900 });
      await sendMail(env, c.email, "Dein Code für ein neues Passwort: " + code, "Hallo " + (c.name || "") + ",\n\nmit diesem Code kannst du auf pizzeria-koenigspalast.de ein neues Passwort festlegen:\n\n" + code + "\n\nDer Code gilt 15 Minuten. Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren.\n\nPizza & Baguettehaus am Königspalast");
    }
    return json({ ok: true });
  }
  if (path === "/acct/reset") {
    if (await limited("rs", 10)) return json({ error: "limit" }, 429);
    if (!okPw(b.password)) return json({ error: "pw" }, 400);
    const c = await byMail();
    const ck = c ? "pwr:" + c.id : "";
    const k = c ? await getJSON(kv, ck) : null;
    if (!k || k.tries >= 5) return json({ error: "expired" }, 400);
    if (!same(String(b.code || "").replace(/\D/g, ""), k.code)) { k.tries++; await setJSON(kv, ck, k, { expirationTtl: 900 }); await sleep(500); return json({ error: "code" }, 400); }
    await kv.delete(ck);
    const h = await pwHash(b.password);
    await D.batch([D.prepare("UPDATE customers SET pw = ?, salt = ?, last_seen = ? WHERE id = ?").bind(h.hash, h.salt, now, c.id), D.prepare("DELETE FROM sessions WHERE cid = ?").bind(c.id)]);
    const token = await newSession(D, c.id);
    return json({ token, profile: pubProfile(c), orders: await custOrders(D, c.id, 30), loyal: await loyalCount(D, c.id) });
  }
  const c = await acctFromToken(env, b.token);
  if (!c) return json({ error: "auth" }, 401);
  if (path === "/acct/me") {
    await D.prepare("UPDATE customers SET last_seen = ? WHERE id = ?").bind(now, c.id).run();
    return json({ profile: pubProfile(c), orders: await custOrders(D, c.id, 30), loyal: await loyalCount(D, c.id) });
  }
  if (path === "/acct/update") {
    const p = { name: str(b.name, 80), phone: str(String(b.phone || "").replace(/[^\d+ ]/g, ""), 20), ...addrPartsOf(b) };
    if (!p.name) return json({ error: "name" }, 400);
    await D.prepare("UPDATE customers SET name = ?, phone = ?, street = ?, hnr = ?, plz = ?, city = ?, last_seen = ? WHERE id = ?").bind(p.name, p.phone, p.street, p.hnr, p.plz, p.city, now, c.id).run();
    return json({ profile: pubProfile({ ...c, ...p }) });
  }
  if (path === "/acct/password") {
    if (!same((await pwHash(String(b.old || ""), c.salt)).hash, c.pw)) { await sleep(600); return json({ error: "oldpw" }, 403); }
    if (!okPw(b.password)) return json({ error: "pw" }, 400);
    const h = await pwHash(b.password);
    await D.batch([D.prepare("UPDATE customers SET pw = ?, salt = ?, last_seen = ? WHERE id = ?").bind(h.hash, h.salt, now, c.id), D.prepare("DELETE FROM sessions WHERE cid = ? AND token != ?").bind(c.id, b.token)]);
    return json({ ok: true });
  }
  if (path === "/acct/logout") { await D.prepare("DELETE FROM sessions WHERE token = ?").bind(b.token).run(); return json({ ok: true }); }
  if (path === "/acct/delete") {
    if (!same((await pwHash(String(b.password || ""), c.salt)).hash, c.pw)) { await sleep(600); return json({ error: "oldpw" }, 403); }
    await deleteCustomer(D, c.id);
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

async function listOrders(kv) {
  const { keys } = await kv.list({ prefix: "o:", limit: 300 });
  const all = await Promise.all(keys.map((k) => getJSON(kv, k.name)));
  return all.filter(Boolean).sort((a, b) => b.t - a.t);
}

// ---------- Online-Zahlung (Stripe Checkout: Apple Pay, Karte u. a.) ----------
const eurS = (n) => n.toFixed(2).replace(".", ",") + " €";
function berlinNow() {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const get = (t) => p.find((x) => x.type === t).value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")];
  return { dow, m: Number(get("hour")) * 60 + Number(get("minute")) };
}
// d = Schulzeit-Preise (Mo–Fr 07:00–14:30), e = Eventzeit-Preise (sonst)
function autoMode() {
  const { dow, m } = berlinNow();
  return dow >= 1 && dow <= 5 && m >= 7 * 60 && m < 14 * 60 + 30 ? "d" : "e";
}
// Rechnet den Warenkorb serverseitig nach (gleiche Regeln wie die Seite), damit Preise nicht verändert werden können.
function priceCart(menu, PR, mode, cart) {
  const addon = (a) => {
    const o = PR["addon|" + a + "|0"];
    return o && typeof o.d === "number" ? o.d : menu.ADDON[a].p;
  };
  if (!Array.isArray(cart) || !cart.length || cart.length > 40) return { error: "cart" };
  const out = [];
  for (const l of cart) {
    const key = String((l && l.key) || "");
    if (!/^[a-z]+\|\d+\|\d+$/.test(key)) return { error: "cart" };
    const [c, i, s] = key.split("|");
    const C = menu.MENU[c];
    const it = C && C.items[Number(i)];
    const list = it && it[mode === "d" ? 2 : 3];
    if (!list || typeof list[Number(s)] !== "number") return { error: "cart" };
    const qty = Math.floor(Number(l.qty));
    if (!(qty >= 1 && qty <= 30)) return { error: "cart" };
    const sel = l.sel && typeof l.sel === "object" ? l.sel : {};
    const o = (it[4] !== undefined ? it[4] : C.opt) || {};
    const ov = PR[key] && PR[key][mode];
    let unit = typeof ov === "number" ? ov : list[Number(s)];
    const tops = Array.isArray(sel.tops) ? sel.tops : [];
    const sauces = Array.isArray(sel.sauces) ? sel.sauces : [];
    if (tops.length > 14 || sauces.length > 12) return { error: "cart" };
    if (tops.length && !o.tops) return { error: "cart" };
    if (sauces.length && o.sauce === undefined) return { error: "cart" };
    const ing = [];
    for (const n of tops) {
      const T = menu.TOPS.find((x) => x[0] === n);
      if (!T) return { error: "cart" };
      ing.push(addon(T[1]));
    }
    const okS = Array.isArray(o.sauces) ? o.sauces : menu.SAUCES;
    for (const n of sauces) if (!okS.includes(n)) return { error: "cart" };
    unit += Math.max(0, sauces.length - (o.sauce || 0)) * addon("sauce");
    if (sel.bake) {
      if (!o.bake) return { error: "cart" };
      ing.push(addon("bake"));
    }
    // z. B. König-Baguette: "incl" Zutaten inklusive (Überbacken zählt mit), ab der nächsten wird jeweils die teuerste berechnet
    if (o.incl) {
      if (ing.length < o.incl) return { error: "cart" };
      ing.sort((a, b) => b - a);
      unit += ing.slice(0, Math.max(0, ing.length - o.incl)).reduce((a, b) => a + b, 0);
    } else unit += ing.reduce((a, b) => a + b, 0);
    if (sel.noSauce === true && (sauces.length || o.sauce === undefined)) return { error: "cart" };
    const pick = o.pick ? (o.pick.options.includes(sel.pick) ? sel.pick : o.pick.options[0]) : "";
    unit = Math.round(unit * 100) / 100;
    const pre = C.prefix || "";
    const base = pre && !it[0].toLowerCase().includes(pre.trim().toLowerCase()) ? pre + it[0] : it[0];
    const name = base + (C.sizes ? ` (${C.sizes[Number(s)]})` : "");
    const det = [];
    if (o.pick && pick) det.push(`${o.pick.label}: ${pick}`);
    if (o.fixed) det.push("Inklusive: " + o.fixed.join(", "));
    if (sauces.length) det.push("Soßen: " + sauces.join(", "));
    if (sel.noSauce === true) det.push("Keine Soße");
    if (tops.length) det.push((o.incl ? "Zutaten: " : "Extra: ") + tops.join(", "));
    if (sel.bake) det.push("Überbacken");
    out.push({ key, name, det, note: str(l.note, 200), qty, unit, cat: c, desc: String(it[1] || "") });
  }
  return { lines: out, sum: Math.round(out.reduce((a, x) => a + x.unit * x.qty, 0) * 100) / 100 };
}
async function stripePost(env, path, params) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
}
// Schalter für die Online-Zahlung: auf true setzen, um sie wieder einzuschalten (zusammen mit der Seite, siehe Git-Verlauf)
const PAY_ENABLED = true;
async function handleCheckout(b, req, env) {
  const vorOrt = b.payMode === "vorort"; // Bestellung mit Bezahlung bei Abholung/Lieferung (bar oder Karte)
  if (!PAY_ENABLED || (!vorOrt && (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET))) return json({ error: "nopay" }, 503);
  const kv = env.DATA;
  // Missbrauchsschutz: höchstens 8 Zahlungsversuche pro IP in 10 Minuten
  const ipHash = await shortHash(req.headers.get("cf-connecting-ip") || "unbekannt");
  const rlKey = `ck:${ipHash}:${Math.floor(Date.now() / 600000)}`;
  const cnt = Number((await kv.get(rlKey)) || 0);
  if (cnt >= 8) return json({ error: "limit" }, 429);
  await kv.put(rlKey, String(cnt + 1), { expirationTtl: 1200 });
  // Hat der Inhaber auf "geschlossen" gestellt?
  const st = await getJSON(kv, "status");
  if (st && st.state === "closed" && st.expires > Date.now() && !String(b.date || "").trim()) return json({ error: "closed" }, 409);
  const name = str(b.name, 80);
  const lief = b.fulfil === "Lieferung";
  if (!name) return json({ error: "name" }, 400);
  const phoneRaw = String(b.phone || "").replace(/[^\d+]/g, "");
  const phoneDigits = phoneRaw.replace(/\D/g, "");
  if (phoneDigits.length < 8 || phoneDigits.length > 15) return json({ error: "phone" }, 400);
  const phone = phoneRaw.slice(0, 20);
  const mailRaw = str(b.email, 120);
  const mail = okMail(mailRaw) ? mailRaw : "";
  if (!mail) return json({ error: "email" }, 400);
  const invEmail = b.invoice || b.invoiceEmail ? mail : ""; // Rechnung geht an die Bestell-E-Mail (auch bei Zahlung vor Ort, dann nach Bezahlung)
  const addr = lief ? str(b.addr, 200) : "";
  if (lief && addr.length < 6) return json({ error: "addr" }, 400);
  const billAddr = !lief && invEmail ? str(b.billAddr, 200) : "";
  if (!lief && invEmail) { const v0 = await checkAddr(env, billAddr); if (v0.error) return json({ error: "billaddr" }, 422); }
  const wt = await checkWish(env, b.time, b.date);
  if (wt.error) return json({ error: "time" }, 400);
  // Preise serverseitig nachrechnen
  const menu = await (await env.ASSETS.fetch(new URL("/menu.json", req.url))).json();
  const PRd = await getJSON(kv, "prices");
  const PR = (PRd && PRd.prices) || {};
  const pm = await getJSON(kv, "pmode");
  const mode = lief ? "e" : pm && pm.until > Date.now() && (pm.mode === "d" || pm.mode === "e") ? pm.mode : autoMode();
  const priced = priceCart(menu, PR, mode, b.cart);
  if (priced.error) return json({ error: "cart" }, 400);
  const ops = await getOps(env);
  if (lief && ops.delOff && !wt.date) return json({ error: "nodelivery" }, 409);
  const so = soldOutHit(menu, b.cart, ops.out);
  if (so) return json({ error: "soldout", item: so }, 409);
  // Treue-Rabatt: 10 % auf Speisen und Getränke bei jeder 10. Bestellung mit Kundenkonto (nicht auf Liefergebühr und Trinkgeld)
  const origSum = priced.sum;
  let loyal = 0;
  try {
    const lc = b.token && env.DB ? await acctFromToken(env, b.token) : null;
    if (lc && (await loyalCount(await db(env), lc.id)) % 10 === 9) {
      for (const x of priced.lines) { const u = Math.round(x.unit * 100), d = Math.round(u * 0.9); if (d < u) { x.det.push("10 % Treue-Rabatt (statt " + eurS(x.unit) + ")"); x.unit = d / 100; } }
      priced.sum = Math.round(priced.lines.reduce((a, x) => a + Math.round(x.unit * 100) * x.qty, 0)) / 100;
      loyal = Math.round((origSum - priced.sum) * 100) / 100;
    }
  } catch (e) {}
  const acctData = { name, phone, ...(lief || invEmail ? addrPartsOf(b) : {}), fulfil: lief ? "Lieferung" : "Abholung", cart: cartOf(b.cart) };
  let fee = 0, km = 0, tip = 0, driveMin = 0;
  if (lief) {
    if (!env.GOOGLE_MAPS_KEY) return json({ error: "route" }, 503);
    let a = addr;
    if (!/\d{5}/.test(a) && !a.includes(",")) a += ", Krefeld";
    const v = await checkAddr(env, a);
    if (v.error) return json({ error: v.error === "addr" ? "addr" : "route" }, v.error === "addr" ? 422 : 502);
    const r = await routeKm(env, a);
    if (r.error) return json({ error: r.error === "addr" ? "addr" : "route" }, r.error === "addr" ? 422 : 502);
    const t = tierFor(r.km);
    if (origSum < t.min) {
      if (!b.tipFill) return json({ error: "min", min: t.min }, 400);
      tip = Math.round((t.min - origSum) * 100) / 100; // Fehlbetrag wird als Trinkgeld aufgefüllt
    }
    fee = t.fee;
    km = Math.round(r.km * 10) / 10;
    driveMin = Math.ceil((r.sec || 0) / 60);
  }
  const total = Math.round((priced.sum + fee + tip) * 100) / 100;
  if (total > 500) return json({ error: "cart" }, 400);
  if (Math.round(Number(b.clientTotal) * 100) !== Math.round(total * 100)) return json({ error: "mismatch", total }, 409);
  // Bestellung bis zur Zahlung zwischenspeichern (2 Stunden)
  const t0 = Date.now();
  const id = `${t0}:${Math.random().toString(36).slice(2, 8)}`;
  const lines = priced.lines.map((x) => `${x.qty}x ${x.name} – ${eurS(x.unit * x.qty)}` + x.det.map((d) => `\n   ${d}`).join("") + (x.note ? `\n   Anmerkung: ${x.note}` : ""));
  if (vorOrt) {
    const rec = { id, t: t0, name, type: lief ? "Lieferung" : "Abholung", addr, time: wt.time, date: wt.date, review: !!b.review, loyal, note: str(b.note, 500), lines, total: priced.sum, fee, km, tip, driveMin, email: mail, invEmail, billAddr, phone, items: priced.lines.map((x) => ({ key: x.key, name: x.name, det: x.det, note: x.note, qty: x.qty, unit: x.unit, cat: x.cat, desc: x.desc })), paid: false, pay: "vorort" };
    await setOrderNo(kv, rec, false);
    await setJSON(kv, `o:${id}`, rec, { expirationTtl: ORDER_TTL_S });
    await addLedger(env, rec);
    await notifyTelegram(env, rec);
    await sendConfirm(env, rec);
    await saveAcctFromOrder(env, b.token, acctData, rec);
    return json({ ok: true, no: rec.no, id });
  }
  await setJSON(kv, `p:${id}`, { id, t: t0, name, type: lief ? "Lieferung" : "Abholung", addr, time: wt.time, date: wt.date, review: !!b.review, loyal, note: str(b.note, 500), lines, total: priced.sum, fee, km, tip, driveMin, email: mail, billAddr, phone, items: priced.lines.map((x) => ({ key: x.key, name: x.name, det: x.det, note: x.note, qty: x.qty, unit: x.unit, cat: x.cat, desc: x.desc })), invEmail, cid: ((await acctFromToken(env, b.token)) || {}).id || null, cart: acctData.cart, paid: false, pay: "stripe" }, { expirationTtl: 7200 });
  // Stripe-Checkout-Sitzung anlegen
  const origin = new URL(req.url).origin;
  const p = new URLSearchParams();
  p.set("mode", "payment");
  p.set("locale", "de");
  p.set("success_url", origin + "/?bezahlt=1&o=" + encodeURIComponent(id));
  p.set("cancel_url", origin + "/?bezahlt=0");
  p.set("client_reference_id", id.replace(":", "-"));
  p.set("metadata[order_id]", id);
  p.set("payment_intent_data[metadata][order_id]", id);
  p.set("payment_intent_data[description]", `Bestellung ${name} (${lief ? "Lieferung" : "Abholung"})`);
  p.set("custom_text[submit][message]", "Mit Klick auf „Bezahlen“ bestellst du verbindlich und zahlungspflichtig. Bei frisch zubereiteten, schnell verderblichen Speisen besteht kein Widerrufsrecht.");
  p.set("expires_at", String(Math.floor(Date.now() / 1000) + 1860));
  let n = 0;
  const item = (nm, desc, cents, q) => {
    p.set(`line_items[${n}][price_data][currency]`, "eur");
    p.set(`line_items[${n}][price_data][product_data][name]`, nm);
    if (desc) p.set(`line_items[${n}][price_data][product_data][description]`, desc.slice(0, 480));
    p.set(`line_items[${n}][price_data][unit_amount]`, String(cents));
    p.set(`line_items[${n}][quantity]`, String(q));
    n++;
  };
  for (const x of priced.lines) item(x.name, [...x.det, x.note ? "Anmerkung: " + x.note : ""].filter(Boolean).join(" · "), Math.round(x.unit * 100), x.qty);
  if (fee > 0) item("Liefergebühr", `${String(km).replace(".", ",")} km Fahrstrecke`, Math.round(fee * 100), 1);
  if (tip > 0) item("Trinkgeld (Aufrundung auf den Mindestbestellwert)", "", Math.round(tip * 100), 1);
  const r = await stripePost(env, "checkout/sessions", p);
  if (!r.ok || !r.j.url) {
    await kv.delete(`p:${id}`);
    return json({ error: "stripe" }, 502);
  }
  await saveAcctFromOrder(env, b.token, acctData);
  return json({ url: r.j.url });
}
async function verifyStripe(raw, header, secret) {
  const h = String(header || "");
  const t = Number((h.split(",").find((x) => x.startsWith("t=")) || "").slice(2));
  const sigs = h.split(",").filter((x) => x.startsWith("v1=")).map((x) => x.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`));
  const hex = [...new Uint8Array(mac)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => same(s, hex));
}
// Telegram-Nachricht an den Laden bei jeder bezahlten Bestellung.
// Aktiv nur, wenn TELEGRAM_BOT_TOKEN und TELEGRAM_CHAT_ID gesetzt sind. Fehler dürfen die Bestellung nie stören.
async function notifyTelegram(env, rec) {
  try {
    if (!env.TELEGRAM_BOT_TOKEN) { await env.DATA.put("tgstatus", "kein-token"); return "kein-token"; }
    // Chat-ID: fest per Secret gesetzt oder automatisch aus der ersten Nachricht an den Bot ermittelt (und gemerkt)
    let chat = env.TELEGRAM_CHAT_ID || (await env.DATA.get("tgchat"));
    if (!chat) {
      const u = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/getUpdates");
      if (!u.ok) { await env.DATA.put("tgstatus", "getupdates-" + u.status); return "fehler"; }
      const uj = await u.json().catch(() => ({}));
      const first = ((uj && uj.result) || []).find((x) => x.message && x.message.chat && x.message.chat.type === "private");
      if (!first) { await env.DATA.put("tgstatus", "keine-nachricht-am-bot"); return "keine-nachricht"; }
      chat = String(first.message.chat.id);
      await env.DATA.put("tgchat", chat);
    }
    const eurS = (n) => (Number(n) || 0).toFixed(2).replace(".", ",") + " €";
    const total = typeof rec.amount === "number" ? rec.amount / 100 : (rec.total || 0) + (rec.fee || 0) + (rec.tip || 0);
    const text = [
      (rec.paid ? "🍕 Neue bezahlte Bestellung" : "🍕 Neue Bestellung: Zahlung vor Ort (noch NICHT bezahlt)") + (rec.no ? " · Nr. " + rec.no : ""),
      "",
      "Name: " + rec.name,
      rec.type === "Lieferung" ? "Lieferung an: " + rec.addr + (rec.km ? " (" + rec.km + " km)" : "") : "Abholung",
      rec.time ? (rec.date ? "📅 VORBESTELLUNG für " : "⏰ Wunschzeit: ") + wishStr(rec) : "",
      rec.phone ? "Telefon: " + rec.phone : "",
      rec.email ? "E-Mail: " + rec.email : "",
      "",
      ...(rec.lines || []),
      rec.tip ? "Trinkgeld (Aufrundung auf Mindestbestellwert): " + eurS(rec.tip) : "",
      rec.loyal ? "🎁 Treue-Rabatt (10. Bestellung): −" + eurS(rec.loyal) + " (schon abgezogen)" : "",
      rec.note ? "\nAnmerkung: " + rec.note : "",
      "",
      (rec.paid ? "Gesamt bezahlt: " : "Zu zahlen bei Abholung/Lieferung (bar oder Karte): ") + eurS(total) + (rec.fee ? " (inkl. " + eurS(rec.fee) + " Liefergebühr)" : ""),
      !rec.paid && rec.invEmail && rec.no ? "\n🧾 Rechnung angefordert. Sobald bezahlt ist, hier „" + rec.no + " bezahlt“ schreiben, dann geht die Rechnung an den Kunden." : "",
    ].filter((x, i, a) => x !== "" || (a[i - 1] !== "" && i > 0)).join("\n").slice(0, 4000);
    // Mehrere Empfänger: TELEGRAM_CHAT_ID darf eine Liste sein (Komma getrennt)
    const ids = String(chat).split(/[\s,;]+/).filter(Boolean);
    let okN = 0, lastErr = 0;
    for (const cid of ids) {
      const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cid, text, reply_markup: rec.no ? { inline_keyboard: [[{ text: "✅ Angenommen", callback_data: "st:" + rec.no + ":a" }, { text: "🍕 Fertig", callback_data: "st:" + rec.no + ":f" }].concat(rec.type === "Lieferung" ? [{ text: "🛵 Unterwegs", callback_data: "st:" + rec.no + ":u" }] : [])] } : undefined }),
      });
      if (r.ok) okN++; else lastErr = r.status;
    }
    await env.DATA.put("tgstatus", okN ? "ok" + (ids.length > 1 ? " (" + okN + "/" + ids.length + ")" : "") : "fehler-" + lastErr);
    return okN ? "ok" : "fehler";
  } catch (e) {
    try { await env.DATA.put("tgstatus", "ausnahme"); } catch (e2) {}
    return "fehler";
  }
}
// Stripe meldet bezahlte Sitzungen: dann wird die Bestellung für den Inhaber sichtbar ("bezahlt")
async function handleStripeWebhook(req, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "nokey" }, 503);
  const raw = await req.text();
  if (!(await verifyStripe(raw, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET))) return json({ error: "sig" }, 400);
  let ev;
  try { ev = JSON.parse(raw); } catch (e) { return json({ error: "json" }, 400); }
  const kv = env.DATA;
  if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") {
    const s = (ev.data && ev.data.object) || {};
    const id = s.metadata && s.metadata.order_id;
    const phone = str((s.customer_details && s.customer_details.phone) || "", 40);
    if (id && s.payment_status === "paid" && !(await kv.get(`o:${id}`))) {
      const pend = await getJSON(kv, `p:${id}`);
      const rec = pend
        ? { ...pend, paid: true, paidAt: Date.now(), amount: s.amount_total, phone: pend.phone || phone }
        : { id, t: Date.now(), name: str((s.customer_details && s.customer_details.name) || "Unbekannt", 80), type: "Abholung", addr: "", time: "", note: "Bestelldetails fehlen, bitte in Stripe prüfen", lines: ["(Bezahlte Bestellung, Details siehe Stripe)"], total: (s.amount_total || 0) / 100, fee: 0, km: 0, paid: true, paidAt: Date.now(), phone };
      await setOrderNo(kv, rec, true);
      await setJSON(kv, `o:${id}`, rec, { expirationTtl: ORDER_TTL_S });
      if (pend) await kv.delete(`p:${id}`);
      if ((await notifyTelegram(env, rec)) === "ok") { rec.tgDone = true; await setJSON(kv, `o:${id}`, rec, { expirationTtl: ORDER_TTL_S }); }
    } else if (id && s.payment_status === "paid") {
      const ex = await getJSON(kv, `o:${id}`);
      if (ex && !ex.tgDone && (await notifyTelegram(env, ex)) === "ok") { ex.tgDone = true; await setJSON(kv, `o:${id}`, ex, { expirationTtl: ORDER_TTL_S }); }
    }
    if (id && s.payment_status === "paid") {
      await sendInvoice(env, await getJSON(kv, "o:" + id));
      await addLedger(env, await getJSON(kv, "o:" + id));
      await sendConfirm(env, await getJSON(kv, "o:" + id));
      { const fin = await getJSON(kv, "o:" + id); if (fin && fin.cid) await addCustOrder(env, fin.cid, fin, fin.cart); }
    }
  }
  return json({ received: true });
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
    if (path === "/rating") return json((await getJSON(kv, "rating")) || {});
    if (path === "/ops") { const o = await getOps(env); return json({ wait: o.wait || null, delOff: !!o.delOff, out: o.out || [] }); }
    if (path === "/popular") return json((await getJSON(kv, "popular")) || { keys: [] });
    if (path === "/ordno") {
      const oid = new URL(req.url).searchParams.get("id") || "";
      if (!/^\d+:[a-z0-9]+$/.test(oid)) return json({}, 400);
      const o = await getJSON(kv, "o:" + oid);
      return json(o ? { no: o.no || null, paid: !!o.paid, st: o.status || "", type: o.type || "" } : {});
    }
    if (path === "/config") return json({ route: !!env.GOOGLE_MAPS_KEY, pay: PAY_ENABLED && !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET, tg: (await kv.get("tgstatus")) || "-", rt: (await kv.get("rtstatus")) || "-", inv: !!env.RESEND_API_KEY, acct: !!env.DB, ts: env.TURNSTILE_SECRET ? TS_SITEKEY : "", tsv: (await kv.get("tsstatus")) || "-", iv: (await kv.get("invstatus")) || "-" });
    return json({ error: "not found" }, 404);
  }

  if (req.method === "POST") {
    if (path === "/stripe-webhook") return handleStripeWebhook(req, env); // braucht den Rohtext
    let b = {};
    try { b = await req.json(); } catch (e) {}

    if (path === "/orders") return saveOrder(b, req, env); // öffentlich (WhatsApp-Anfragen)
    if (path.startsWith("/acct/")) return handleAcct(path, b, req, env); // Kundenkonto
    if (path === "/route") return handleRoute(b, req, env); // öffentlich, begrenzt
    if (path === "/checkout") return handleCheckout(b, req, env); // öffentlich, begrenzt

    // Zwei PINs: OWNER_PIN sieht alles, STAFF_PIN sieht alles außer der Bestellhistorie
    const given = String(b.pin || "").trim();
    const isOwner = !!env.OWNER_PIN && same(given, String(env.OWNER_PIN).trim());
    const isStaff = !isOwner && !!env.STAFF_PIN && same(given, String(env.STAFF_PIN).trim());
    if (!isOwner && !isStaff) {
      await sleep(1000); // bremst das Ausprobieren von PINs
      return json({ error: "pin" }, 403);
    }
    if (path === "/login") return json({ ok: true, role: isOwner ? "owner" : "staff" });
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
    if (path === "/rating") {
      if (b.clear) { await kv.delete("rating"); return json({ ok: true }); }
      const score = Number(String(b.score).replace(",", "."));
      const count = Math.floor(Number(b.count));
      if (!(score >= 0 && score <= 10) || !(count >= 1 && count <= 1000000)) return json({ error: "invalid" }, 400);
      await setJSON(kv, "rating", { score: score.toFixed(1).replace(".", ","), count, updated: Date.now() });
      return json({ ok: true });
    }
    if (path === "/customers/list") {
      if (!isOwner) return json({ error: "forbidden" }, 403);
      if (!env.DB) return json({ customers: [] });
      const D = await db(env);
      const r = await D.prepare("SELECT c.id, c.email, c.name, c.phone, c.street, c.hnr, c.plz, c.city, c.created, c.last_seen, COUNT(o.id) AS n, MAX(o.t) AS last_order, COALESCE(SUM(CASE WHEN o.pay != 'wa' THEN o.total ELSE 0 END), 0) AS sum FROM customers c LEFT JOIN cust_orders o ON o.cid = c.id GROUP BY c.id ORDER BY c.created DESC LIMIT 2000").all();
      return json({ customers: r.results || [] });
    }
    if (path === "/customers/delete") {
      if (!isOwner) return json({ error: "forbidden" }, 403);
      const id = Math.floor(Number(b.id));
      if (!env.DB || !(id > 0)) return json({ error: "invalid" }, 400);
      await deleteCustomer(await db(env), id);
      return json({ ok: true });
    }
    if (path === "/orders/list") {
      if (!isOwner) return json({ error: "forbidden" }, 403);
      return json({ orders: await listOrders(kv) });
    }
    if (path === "/orders/delete") {
      if (!isOwner) return json({ error: "forbidden" }, 403);
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

// ---------- Rückfrage "noch geöffnet?" bei Veranstaltungen (per Telegram) ----------
// Eishockey (Krefeld Pinguine): erste Frage 4 Stunden nach Beginn, danach stündlich.
// Alle anderen Veranstaltungen: erste Frage 1 Stunde nach Beginn, danach stündlich.
// Antwort "Ja": nach einer Stunde wieder fragen. "Nein" oder keine Antwort in 20 Minuten: Laden auf der Website schließen.
const ASK_TIMEOUT_MS = 20 * 60000;
const ASK_STEP_MS = 3600000;
const ASK_MAX_AFTER_START_MS = 13 * 3600000;
const isHockey = (e) => /pinguine/i.test((e && e.title) || "");
function tzOffsetMs(ts) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ts));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - ts;
}
function berlinEpoch(date, hm) {
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = hm.split(":").map(Number);
  const base = Date.UTC(y, mo - 1, d, h, mi);
  let ts = base - tzOffsetMs(base);
  ts = base - tzOffsetMs(ts);
  return ts;
}
const berlinDate = (ts) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(ts));
function nextMorning(now) {
  let t = berlinEpoch(berlinDate(now), "06:00");
  if (t <= now) t = berlinEpoch(berlinDate(now + 86400000), "06:00");
  return t;
}
async function tgApi(env, method, body) {
  try {
    const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    return await r.json().catch(() => ({ ok: false }));
  } catch (e) { return { ok: false }; }
}
async function tgRecipients(env) {
  const raw = env.TELEGRAM_CHAT_ID || (await env.DATA.get("tgchat")) || "";
  return String(raw).split(/[\s,;]+/).filter(Boolean);
}
// Holt neue Telegram-Nachrichten: "12 bezahlt" markiert Bestellung 12 als bezahlt (Rechnung geht raus), Ja/Nein für die Rückfrage
async function tgUpdates(env, kv, ids) {
  const off = Number(await kv.get("tgoff")) || 0;
  const r = await tgApi(env, "getUpdates", off ? { offset: off } : {});
  const list = (r && r.result) || [];
  const out = [];
  let maxId = off - 1;
  for (const u of list) {
    maxId = Math.max(maxId, u.update_id);
    try {
      if (u.callback_query) {
        const cq = u.callback_query, from = String(cq.message && cq.message.chat && cq.message.chat.id);
        const parts = String(cq.data || "").split(":");
        await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id });
        if (ids.includes(from) && (parts[0] === "ja" || parts[0] === "nein")) out.push({ ans: parts[0], id: parts[1] });
        if (ids.includes(from) && parts[0] === "st") await setOrderStatus(env, parts[1], parts[2], from);
      } else if (u.message && u.message.text && ids.includes(String(u.message.chat.id))) {
        const raw = u.message.text.trim().toLowerCase();
        const pm = raw.match(/^(?:nr\.?\s*|#)?(o?\d{1,6})\s*(?:ist\s+)?bezahlt[.!]?$/) || raw.match(/^bezahlt:?\s*(?:nr\.?\s*|#)?(o?\d{1,6})[.!]?$/);
        if (pm) { await markPaid(env, pm[1].toUpperCase(), String(u.message.chat.id)); continue; }
        if (/^(check|prüfen|pruefen|test|selbsttest)$/.test(raw)) { await tgApi(env, "sendMessage", { chat_id: String(u.message.chat.id), text: (await selfCheck(env, true)).slice(0, 4000) }); continue; }
        const oc = await opsCommand(env, raw);
        if (oc) { await tgApi(env, "sendMessage", { chat_id: String(u.message.chat.id), text: oc }); continue; }
        const tx = raw.replace(/[^a-zäöü]/g, "");
        if (tx === "ja" || tx === "nein") out.push({ ans: tx, at: u.message.date * 1000 });
      }
    } catch (e) {}
  }
  if (list.length) await kv.put("tgoff", String(maxId + 1));
  return out;
}
// Vor-Ort-Bestellung als bezahlt markieren und Rechnung verschicken (an die Geschäftsmail, bei Anforderung auch an den Kunden)
async function markPaid(env, no, chat) {
  const kv = env.DATA;
  const reply = (t) => tgApi(env, "sendMessage", { chat_id: chat, text: t });
  try {
    const id = await kv.get("on:" + no);
    const rec = id && (await getJSON(kv, "o:" + id));
    if (!rec) return reply("❓ Bestellung Nr. " + no + " wurde nicht gefunden (Bestellungen werden nach 30 Tagen gelöscht).");
    if (rec.paid) return reply("ℹ️ Bestellung Nr. " + no + " (" + rec.name + ") wurde schon online bezahlt. Die Rechnung ist bereits verschickt.");
    if (rec.pay !== "vorort") return reply("ℹ️ Nr. " + no + " ist eine WhatsApp-Anfrage. Dafür kann keine Rechnung erstellt werden.");
    if (rec.cashPaid) return reply("ℹ️ Bestellung Nr. " + no + " ist schon als bezahlt markiert" + (rec.invNo ? " (Rechnung " + rec.invNo + ")." : "."));
    rec.cashPaid = true;
    rec.paidAt = Date.now();
    await setJSON(kv, "o:" + rec.id, rec, { expirationTtl: ORDER_TTL_S });
    await sendInvoice(env, rec);
    await addLedger(env, rec);
    return reply("✅ Bestellung Nr. " + no + " (" + rec.name + ") ist als bezahlt markiert." + (rec.invNo ? "\n🧾 Rechnung " + rec.invNo + (rec.invEmail ? (rec.invCust ? " wurde an " + rec.invEmail + " geschickt." : " konnte NICHT an " + rec.invEmail + " geschickt werden.") : " ging an die Geschäftsmail (der Kunde hat keine Rechnung angefordert).") : "\n⚠️ Die Rechnung konnte nicht erstellt werden."));
  } catch (e) {
    return reply("⚠️ Fehler beim Markieren von Nr. " + no + ".");
  }
}
async function runAsk(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const kv = env.DATA, now = Date.now();
  const ids = await tgRecipients(env);
  if (!ids.length) return;
  const ups = await tgUpdates(env, kv, ids);
  let evs = ((await getJSON(kv, "events")) || {}).events || [];
  if (!evs.length) {
    try { evs = (await (await env.ASSETS.fetch(new URL("/events.json", "https://pizzeria-koenigspalast.de"))).json()).events || []; } catch (e) { evs = []; }
  }
  let active = null;
  for (const e of evs) {
    if (!e.date || !e.start) continue;
    const start = berlinEpoch(e.date, e.start);
    const first = start + (isHockey(e) ? 4 : 1) * 3600000;
    if (now >= first && now <= start + ASK_MAX_AFTER_START_MS && (!active || start > active.start)) active = { e, start, first, key: e.date + "|" + e.start + "|" + e.title };
  }
  const old = await getJSON(kv, "ask");
  const before = JSON.stringify(old);
  let st = old;
  if (active && (!st || st.ev !== active.key)) st = { ev: active.key, next: active.first, pend: null, done: false };
  if (!st) return;
  const owner = ids[0];
  if (st.pend) {
    const hit = ups.filter((u) => (u.id && u.id === st.pend.id) || (u.at && u.at >= st.pend.at - 5000)).pop();
    const ans = hit ? hit.ans : null;
    if (ans === "ja") {
      await setJSON(kv, "status", { state: "open", set: now, expires: st.next + ASK_TIMEOUT_MS + 300000 });
      st.pend = null;
      await tgApi(env, "sendMessage", { chat_id: owner, text: "✅ Alles klar, ich frage in einer Stunde wieder." });
    } else if (ans === "nein" || now >= st.pend.at + ASK_TIMEOUT_MS) {
      await setJSON(kv, "status", { state: "closed", set: now, expires: nextMorning(now) });
      st.pend = null; st.done = true;
      await tgApi(env, "sendMessage", { chat_id: owner, text: (ans === "nein" ? "⛔ Verstanden. " : "⛔ Keine Antwort innerhalb von 20 Minuten. ") + "Der Laden ist auf der Website bis morgen 06:00 Uhr geschlossen. Mit der Inhaber-PIN auf der Website kannst du ihn jederzeit wieder öffnen." });
    }
  } else if (!st.done && active && st.ev === active.key && now >= st.next) {
    const cur = await getJSON(kv, "status");
    if (cur && cur.state === "closed" && cur.expires > now) st.done = true;
    else {
      const id = String(now), e = active.e;
      const r = await tgApi(env, "sendMessage", { chat_id: owner, text: "🕐 Habt ihr noch geöffnet?\n" + e.title + (e.subtitle ? " – " + e.subtitle : "") + "\nBeginn: " + e.start + " Uhr\n\nAntworte mit Ja oder Nein. Ohne Antwort in 20 Minuten wird der Laden auf der Website geschlossen.", reply_markup: { inline_keyboard: [[{ text: "✅ Ja, noch offen", callback_data: "ja:" + id }, { text: "⛔ Nein, schließen", callback_data: "nein:" + id }]] } });
      if (r && r.ok) { st.pend = { at: now, id }; st.next = now + ASK_STEP_MS; }
    }
  }
  if (JSON.stringify(st) !== before) await setJSON(kv, "ask", st);
}

// ---------- Google-Bewertung (Places API, New) ----------
// Holt Bewertung und Anzahl für den Laden und speichert sie unter "rating". Höchstens einmal in 20 Stunden; bei Fehlern frühestens nach 30 Minuten erneut.
async function refreshRating(env) {
  const kv = env.DATA;
  const fail = async (s) => { await kv.put("rtstatus", s); await kv.put("rtwait", String(Date.now() + 1800000)); };
  try {
    if (!env.GOOGLE_MAPS_KEY) return;
    const cur = await getJSON(kv, "rating");
    if (cur && cur.source === "google" && Date.now() - cur.updated < 20 * 3600000) return;
    if (Date.now() < (Number(await kv.get("rtwait")) || 0)) return;
    const H = { "content-type": "application/json", "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY };
    let pid = await kv.get("gplace");
    if (!pid) {
      const r = await fetch("https://places.googleapis.com/v1/places:searchText", { method: "POST", headers: { ...H, "X-Goog-FieldMask": "places.id,places.formattedAddress" }, body: JSON.stringify({ textQuery: "Pizza & Baguettehaus am Königspalast, Westparkstraße 102, 47803 Krefeld", languageCode: "de", regionCode: "DE" }) });
      if (!r.ok) return fail("suche-" + r.status);
      const j = await r.json().catch(() => ({}));
      const hit = (j.places || []).find((p) => /Westparkstra/i.test(p.formattedAddress || ""));
      if (!hit) return fail("nicht-gefunden");
      pid = hit.id;
      await kv.put("gplace", pid);
    }
    const r2 = await fetch("https://places.googleapis.com/v1/places/" + encodeURIComponent(pid), { headers: { ...H, "X-Goog-FieldMask": "rating,userRatingCount,googleMapsUri" } });
    if (!r2.ok) return fail("details-" + r2.status);
    const d = await r2.json().catch(() => ({}));
    if (typeof d.rating !== "number" || !d.userRatingCount) return fail("keine-bewertung");
    await setJSON(kv, "rating", { score: String(d.rating), count: d.userRatingCount, source: "google", url: d.googleMapsUri || "", updated: Date.now() });
    await kv.put("rtstatus", "ok");
  } catch (e) {
    await fail("ausnahme");
  }
}

// ---------- Rechnung (PDF, DIN A4) und Versand per E-Mail (Resend) ----------
const SELLER = { name: "Pizza & Baguettehaus am Königspalast", owner: "Inhaberin: Züleyha Kivanc (Einzelunternehmen)", street: "Westparkstraße 102", city: "47803 Krefeld", phone: "Telefon: 02151 4546528", mail: "pizzaundbaguettehausamkonigpal@gmail.com", tax: "Steuernummer: 117/5187/2618" };
const INV_COPY_TO = "pizzaundbaguettehausamkonigpal@gmail.com";
const INV_START = 1000; // erste Rechnungsnummer = O-1001
const HW = { r: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584], b: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584] };
const UMLAUT = { "ä": "a", "ö": "o", "ü": "u", "Ä": "A", "Ö": "O", "Ü": "U", "ß": "b", "é": "e", "è": "e", "á": "a", "à": "a", "ç": "c", "ñ": "n", "ş": "s", "ı": "i", "ğ": "g" };
function cwid(ch, bold) {
  const t = bold ? HW.b : HW.r;
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return t[code - 32];
  if (ch === "€") return 556;
  const m = UMLAUT[ch];
  if (m) return t[m.charCodeAt(0) - 32];
  return 556;
}
function cp1252(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128 || (c >= 160 && c <= 255)) return c;
  const M = { "€": 128, "„": 132, "“": 147, "”": 148, "’": 146, "‘": 145, "–": 150, "—": 151, "•": 149 };
  return M[ch] || 63;
}
function pdfEsc(s) {
  let o = "";
  for (const ch of String(s)) {
    const b = cp1252(ch);
    o += b === 92 || b === 40 || b === 41 ? "\\" + String.fromCharCode(b) : b < 32 || b > 126 ? "\\" + b.toString(8).padStart(3, "0") : String.fromCharCode(b);
  }
  return o;
}
function pdfBuild(pages, logo) {
  const objs = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("<< /Type /Pages /Kids [" + pages.map((_, i) => (5 + i * 2) + " 0 R").join(" ") + "] /Count " + pages.length + " >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((c, i) => {
    objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>" + (logo ? " /XObject << /Im1 " + (5 + pages.length * 2) + " 0 R >>" : "") + " >> /Contents " + (6 + i * 2) + " 0 R >>");
    objs.push("<< /Length " + c.length + " >>\nstream\n" + c + "\nendstream");
  });
  if (logo) objs.push("<< /Type /XObject /Subtype /Image /Width " + logo.w + " /Height " + logo.h + " /ColorSpace /" + logo.cs + " /BitsPerComponent 8 /Filter /DCTDecode /Length " + logo.bin.length + " >>\nstream\n" + logo.bin + "\nendstream");
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + " 0 obj\n" + o + "\nendobj\n"; });
  const xr = out.length;
  out += "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n" + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xr + "\n%%EOF\n";
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
  return bytes;
}
const invRate = (x) => (x.cat === "getraenke" && !/milch/i.test(x.name || "") ? 19 : 7);
function buildInvoicePdf(rec, logo) {
  const money = (cents) => (cents / 100).toFixed(2).replace(".", ",") + " €";
  const dfmt = (ts) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(ts));
  const tfmt = (ts) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
  const pages = [];
  let c = [];
  let y = 0;
  const W = (s, bold, size) => { let w = 0; for (const ch of String(s)) w += cwid(ch, bold); return (w * size) / 1000; };
  const T = (s, x, yy, size, bold, grey, right, arr) => { (arr || c).push((grey ? "0.4 g" : "0 g") + " BT /" + (bold ? "F2" : "F1") + " " + size + " Tf " + (right ? x - W(s, bold, size) : x).toFixed(2) + " " + yy.toFixed(2) + " Td (" + pdfEsc(s) + ") Tj ET"); };
  const Ln = (x1, y1, x2, y2, w) => c.push((w || 0.5) + " w 0.55 G " + x1 + " " + y1 + " m " + x2 + " " + y2 + " l S");
  const Rect = (x, yy, w, h, g) => c.push(g + " g " + x + " " + yy + " " + w + " " + h + " re f");
  const wrap = (s, bold, size, maxW) => {
    const words = String(s).split(/\s+/).filter(Boolean), lines = [];
    let cur = "";
    for (const w of words) { const t = cur ? cur + " " + w : w; if (!cur || W(t, bold, size) <= maxW) cur = t; else { lines.push(cur); cur = w; } }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  };
  const L = 56, R = 539;
  const no = rec.invNo || "O-0000", inDate = rec.invDate || rec.paidAt || rec.t;
  const rows = (rec.items && rec.items.length ? rec.items : [{ name: "Online-Bestellung (Details siehe Zahlungsbeleg)", det: [], qty: 1, unit: (rec.amount || 0) / 100 - (rec.fee || 0), cat: "" }]).map((x) => ({ name: x.name, det: (x.desc && /pfand/i.test(x.desc) ? [x.desc.charAt(0).toUpperCase() + x.desc.slice(1)] : []).concat(x.det || []).concat(x.note ? ["Anmerkung: " + x.note] : []), qty: x.qty, unitC: Math.round(x.unit * 100), rate: invRate(x) }));
  const gross = { 7: 0, 19: 0 };
  rows.forEach((r) => { r.totC = r.unitC * r.qty; gross[r.rate] += r.totC; });
  const base7 = gross[7], base19 = gross[19];
  const addExtra = (label, cents) => {
    if (cents <= 0) return;
    const g = base7 + base19 || 1;
    const a7 = Math.round((cents * base7) / g), a19 = cents - a7;
    if (a7 > 0) rows.push({ name: label + (a19 > 0 ? ", Anteil 7 %" : ""), det: [], qty: 1, unitC: a7, totC: a7, rate: 7 });
    if (a19 > 0) rows.push({ name: label + (a7 > 0 ? ", Anteil 19 %" : ""), det: [], qty: 1, unitC: a19, totC: a19, rate: 19 });
    gross[7] += a7; gross[19] += a19;
  };
  addExtra("Liefergebühr" + (rec.km ? " (" + String(rec.km).replace(".", ",") + " km)" : ""), Math.round((rec.fee || 0) * 100));
  const tipC = Math.round((rec.tip || 0) * 100);
  if (tipC > 0) { if (TIP_TAXFREE) rows.push({ name: "Trinkgeld (Aufrundung)", det: [], qty: 1, unitC: tipC, totC: tipC, rate: 0 }); else addExtra("Trinkgeld (Aufrundung)", tipC); }
  const totalC = gross[7] + gross[19] + (TIP_TAXFREE ? tipC : 0);
  const header = (first) => {
    c = [];
    if (first) {
      const sl = [SELLER.owner, SELLER.street + ", " + SELLER.city, SELLER.phone, "E-Mail: " + SELLER.mail];
      if (logo) { const lh = 44, lw = (logo.w / logo.h) * lh; c.push("q " + lw.toFixed(2) + " 0 0 " + lh + " " + L + " 768 cm /Im1 Do Q"); sl.forEach((s, i) => T(s, L, 755 - i * 11.5, 8.5, false, true)); }
      else { T(SELLER.name, L, 790, 13, true); sl.forEach((s, i) => T(s, L, 775 - i * 12.5, 9, false, true)); }
      T("RECHNUNG", R, 790, 22, true, false, true);
      [["Rechnungsnummer", no], ["Rechnungsdatum", dfmt(inDate)], ["Leistungsdatum", dfmt(inDate)], ["Bestellt am", tfmt(rec.t)]].forEach((p, i) => { T(p[0], 400, 764 - i * 14, 9, false, true); T(p[1], R, 764 - i * 14, 10, true, false, true); });
      T(SELLER.name + " · " + SELLER.street + " · " + SELLER.city, L, 696, 7, false, true);
      let yy = 681;
      T(rec.name || "Kunde", L, yy, 11, true);
      const cAddr = rec.type === "Lieferung" ? rec.addr : rec.billAddr || "";
      if (cAddr) cAddr.split(/\s*,\s*/).filter(Boolean).slice(0, 3).forEach((s) => { yy -= 13; T(s, L, yy, 10); });
      if (rec.invEmail) { yy -= 13; T(rec.invEmail, L, yy, 10); }
      T("Rechnung " + no, L, 610, 13, true);
      T("Vielen Dank für deine Bestellung. Wir berechnen dir folgende Leistungen:", L, 593, 10);
      y = 575;
    } else {
      T(SELLER.name, L, 800, 10, true);
      T("Rechnung " + no + " (Fortsetzung)", R, 800, 10, false, true, true);
      y = 770;
    }
    Rect(L, y - 5, R - L, 18, 0.9);
    T("Pos.", L + 4, y, 9, true); T("Bezeichnung", L + 34, y, 9, true); T("Menge", 335, y, 9, true, false, true); T("Einzelpreis", 405, y, 9, true, false, true); T("MwSt.", 452, y, 9, true, false, true); T("Gesamt", R - 4, y, 9, true, false, true);
    y -= 20;
  };
  header(true);
  rows.forEach((r, i) => {
    const nameL = wrap(r.name, false, 9.5, 225), detL = [];
    r.det.forEach((d) => wrap(d, false, 8, 250).forEach((s) => detL.push(s)));
    const h = nameL.length * 12 + detL.length * 10 + 6;
    if (y - h < 100) { pages.push(c); header(false); }
    T(String(i + 1), L + 4, y, 9.5);
    nameL.forEach((s, k) => T(s, L + 34, y - k * 12, 9.5));
    detL.forEach((s, k) => T(s, L + 40, y - nameL.length * 12 - k * 10 + 2, 8, false, true));
    T(String(r.qty), 335, y, 9.5, false, false, true); if (r.rate) { T(money(r.unitC), 405, y, 9.5, false, false, true); T(r.rate + " %", 452, y, 9.5, false, false, true); } else T("nicht umsatzsteuerbar", 452, y, 8, false, true, true); T(money(r.totC), R - 4, y, 9.5, false, false, true);
    y -= h;
    Ln(L, y + 10, R, y + 10, 0.3);
  });
  if (y < 230) { pages.push(c); header(false); }
  y -= 12;
  [7, 19].forEach((rt) => {
    if (!gross[rt]) return;
    const net = Math.round(gross[rt] / (1 + rt / 100)), vat = gross[rt] - net;
    T("Nettobetrag " + rt + " %", 400, y, 9.5, false, false, true); T(money(net), R - 4, y, 9.5, false, false, true); y -= 13;
    T("enthaltene MwSt. " + rt + " %", 400, y, 9.5, false, false, true); T(money(vat), R - 4, y, 9.5, false, false, true); y -= 15;
  });
  if (TIP_TAXFREE && tipC > 0) { T("Trinkgeld (nicht umsatzsteuerbar)", 400, y, 9.5, false, false, true); T(money(tipC), R - 4, y, 9.5, false, false, true); y -= 15; }
  Ln(330, y + 6, R, y + 6, 0.8);
  y -= 8;
  T("Gesamtbetrag (brutto)", 400, y, 11, true, false, true); T(money(totalC), R - 4, y, 11, true, false, true); y -= 18;
  T((rec.paid ? "Bezahlt per Online-Zahlung am " : "Bezahlt vor Ort am ") + dfmt(rec.paidAt || inDate), 400, y, 9.5, false, false, true); T("-" + money(totalC), R - 4, y, 9.5, false, false, true); y -= 14;
  T("Offener Betrag", 400, y, 9.5, true, false, true); T(money(0), R - 4, y, 9.5, true, false, true); y -= 30;
  wrap("Alle Preise sind Endpreise inklusive der gesetzlichen Mehrwertsteuer (MwSt.). Der Rechnungsbetrag wurde bereits bezahlt. Das Leistungsdatum entspricht dem Rechnungsdatum.", false, 8.5, R - L).forEach((s) => { T(s, L, y, 8.5, false, true); y -= 11; });
  pages.push(c);
  pages.forEach((arr, i) => {
    arr.push("0.8 w 0.55 G " + L + " 62 m " + R + " 62 l S");
    T(SELLER.name + " · " + SELLER.owner, L, 50, 7.5, false, true, false, arr);
    T(SELLER.street + ", " + SELLER.city + " · " + SELLER.phone + " · " + SELLER.mail + " · " + SELLER.tax, L, 40, 7.5, false, true, false, arr);
    T("Seite " + (i + 1) + " von " + pages.length, R, 50, 7.5, false, true, true, arr);
  });
  return pdfBuild(pages.map((a) => a.join("\n")), logo);
}
function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
// ---------- Selbsttest: prüft täglich um 07:00 Uhr (06:00 UTC) alle Funktionen, bei Problemen Mail an die Geschäftsmail + Telegram ----------
async function selfCheck(env, manual) {
  const kv = env.DATA, res = [], now = Date.now(), H = "https://pizzeria-koenigspalast.de";
  const step = async (n, fix, fn) => { try { const d = await fn(); res.push({ n, ok: true, d: d || "" }); } catch (e) { res.push({ n, ok: false, d: String((e && e.message) || e).slice(0, 200), fix }); } };
  const age = (s) => { const m = String(s || "").match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/); return m ? now - Date.parse(m[1]) : Infinity; };
  await step("Speicher (Cloudflare KV)", "Cloudflare-Status prüfen, KV-Bindung DATA in wrangler.toml prüfen.", async () => { const v = String(now); await kv.put("selftest", v, { expirationTtl: 3600 }); if ((await kv.get("selftest")) !== v) throw new Error("Lesen/Schreiben stimmt nicht überein"); return "ok"; });
  await step("Website-Dateien", "Letzten GitHub-Commit und Cloudflare-Deployment prüfen.", async () => { const r = await env.ASSETS.fetch(new URL("/", H)); const t = await r.text(); if (!r.ok || !t.includes('id="ck-next"') || !t.includes('id="acct"')) throw new Error("Startseite fehlt oder ist unvollständig (HTTP " + r.status + ")"); return "ok"; });
  await step("Speisekarte und Preisberechnung", "menu.json auf Tippfehler prüfen (muss gültiges JSON sein).", async () => { const menu = await (await env.ASSETS.fetch(new URL("/menu.json", H))).json(); const PR = ((await getJSON(kv, "prices")) || {}).prices || {}; const p = priceCart(menu, PR, "e", [{ key: "getraenke|0|0", qty: 2, sel: {} }]); if (p.error || !(p.sum > 0)) throw new Error("Preis konnte nicht berechnet werden"); return Object.keys(menu.MENU).length + " Kategorien"; });
  await step("Kundenkonten (Datenbank D1)", "Cloudflare D1 „pizzeria-kunden“ und die Bindung DB in wrangler.toml prüfen.", async () => { if (!env.DB) throw new Error("Datenbank nicht verbunden"); const r = await (await db(env)).prepare("SELECT COUNT(*) AS n FROM customers").first(); return ((r && r.n) || 0) + " Konten"; });
  await step("Google Fahrstrecke (Lieferkosten)", "Google Cloud: Abrechnung aktiv? Routes API aktiviert? Schlüssel GOOGLE_MAPS_KEY gültig?", async () => { if (!env.GOOGLE_MAPS_KEY) throw new Error("GOOGLE_MAPS_KEY fehlt"); const r = await routeKm(env, "Westparkstraße 1, 47803 Krefeld"); if (r.error) throw new Error("Routes API antwortet nicht richtig (" + r.error + ")"); return r.km.toFixed(1).replace(".", ",") + " km Testroute"; });
  await step("Google Adressprüfung (Places)", "Google Cloud: Places API (New) aktiviert und für den Schlüssel erlaubt?", async () => { const r = await fetch("https://places.googleapis.com/v1/places:searchText", { method: "POST", headers: { "content-type": "application/json", "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY || "", "X-Goog-FieldMask": "places.id" }, body: JSON.stringify({ textQuery: "Westparkstraße 102, 47803 Krefeld", languageCode: "de", regionCode: "DE" }) }); if (!r.ok) throw new Error("Places API: HTTP " + r.status); const j = await r.json().catch(() => ({})); if (!(j.places || []).length) throw new Error("Places API findet die Testadresse nicht"); return "ok"; });
  await step("Google-Bewertung", "Places API prüfen; die Bewertung wird alle 20 Stunden aktualisiert.", async () => { const st = (await kv.get("rtstatus")) || "-"; const rt = await getJSON(kv, "rating"); if (st !== "ok" && st !== "-") throw new Error("Letzte Aktualisierung fehlgeschlagen: " + st); if (rt && rt.updated && now - rt.updated > 3 * 86400000) throw new Error("Bewertung seit über 3 Tagen nicht aktualisiert"); return rt && rt.score ? rt.score + " Sterne" : "ok"; });
  await step("Online-Zahlung (Stripe)", "Stripe: geheimer Schlüssel STRIPE_SECRET_KEY gültig und mit Berechtigung „Checkout Sessions“?", async () => { if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) throw new Error("Stripe-Schlüssel fehlen"); const r = await fetch("https://api.stripe.com/v1/checkout/sessions?limit=1", { headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY } }); if (!r.ok) throw new Error("Stripe antwortet mit HTTP " + r.status + (r.status === 401 ? " (Schlüssel ungültig)" : r.status === 403 ? " (fehlende Berechtigung)" : "")); return "ok"; });
  await step("Telegram-Bot", "Telegram: TELEGRAM_BOT_TOKEN gültig? Haben alle Empfänger den Bot gestartet?", async () => { if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN fehlt"); const j = await tgApi(env, "getMe", {}); if (!j || !j.ok) throw new Error("Bot-Token wird nicht akzeptiert"); const st = (await kv.get("tgstatus")) || "-"; if (/fehler|ausnahme|kein/.test(st)) throw new Error("Letzte Bestell-Nachricht: " + st); return "@" + ((j.result && j.result.username) || "bot") + (st !== "-" ? ", zuletzt " + st : ""); });
  await step("E-Mail-Versand (Resend)", "Resend: RESEND_API_KEY gültig? Domain pizzeria-koenigspalast.de noch verifiziert (DNS-Einträge)?", async () => { if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY fehlt"); const st = (await kv.get("mailstatus")) || ""; if (/^fehler/.test(st)) throw new Error("Letzter Mailversand fehlgeschlagen: " + st); return st ? "zuletzt " + st.split(" ")[0] : "noch kein Versand"; });
  await step("Rechnungen", "Resend und Rechnungs-PDF prüfen.", async () => { const st = (await kv.get("invstatus")) || "-"; if (/fehler|ausnahme/.test(st)) throw new Error("Letzte Rechnung: " + st); return st; });
  await step("Roboter-Prüfung (Turnstile)", "Cloudflare Turnstile: Secret TURNSTILE_SECRET richtig eingetragen (der lange Secret Key)?", async () => { if (!env.TURNSTILE_SECRET) return "ausgeschaltet"; const st = (await kv.get("tsstatus")) || "-"; if (/^(fehler|ausnahme)/.test(st) && age(st) < 2 * 86400000) throw new Error("Letzte Prüfung: " + st); return st === "-" ? "noch nicht benutzt" : st.split(" ")[0]; });
  await step("Veranstaltungen (YAYLA Arena)", "Veranstaltungskalender der Arena erreichbar? Hat sich die Seite der Arena geändert?", async () => { let e = await getJSON(kv, "events"); if (!e || !e.updated || now - Date.parse(e.updated) > 2 * 86400000) { await refreshEvents(env); e = await getJSON(kv, "events"); } if (!e || !e.updated) throw new Error("Keine Termine gespeichert"); if (now - Date.parse(e.updated) > 2 * 86400000) throw new Error("Termine seit über 2 Tagen nicht aktualisiert"); return (e.events || []).length + " Termine"; });
  await step("Monatsabrechnung", "Resend prüfen; die Abrechnung kommt am 1. des Monats.", async () => { const st = (await kv.get("repstatus")) || "-"; if (/fehler|ausnahme/.test(st)) throw new Error("Letzte Abrechnung: " + st); return st; });
  const badList = res.filter((x) => !x.ok);
  await setJSON(kv, "selfcheck", { t: now, res }, { expirationTtl: 30 * 86400 });
  const when = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(now));
  const text = (badList.length ? "⚠️ Website-Prüfung " + when + ": " + badList.length + " Problem" + (badList.length === 1 ? "" : "e") + " gefunden\n\n" + badList.map((x) => "❌ " + x.n + "\n   " + x.d + "\n   Was tun: " + x.fix).join("\n\n") + "\n\nIn Ordnung:\n" : "✅ Website-Prüfung " + when + ": alle " + res.length + " Funktionen in Ordnung\n\n") + res.filter((x) => x.ok).map((x) => "✅ " + x.n + (x.d ? " (" + x.d + ")" : "")).join("\n");
  if (!manual && badList.length) {
    let mailed = false;
    if (env.RESEND_API_KEY) mailed = await sendMail(env, INV_COPY_TO, "⚠️ Website pizzeria-koenigspalast.de: " + badList.length + " Problem" + (badList.length === 1 ? "" : "e") + " (" + badList.map((x) => x.n).join(", ").slice(0, 120) + ")", text + "\n\nDiese Prüfung läuft jeden Morgen um 7 Uhr automatisch. In Telegram kannst du jederzeit „check“ schreiben, um sofort zu prüfen.");
    for (const cid of await tgRecipients(env)) await tgApi(env, "sendMessage", { chat_id: cid, text: (text + (mailed ? "" : "\n\n(Die Warn-Mail konnte nicht verschickt werden.)")).slice(0, 4000) });
  }
  return text;
}
async function sendMail(env, to, subject, text, filename, pdf) {
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ from: env.INVOICE_FROM || "Pizza & Baguettehaus am Königspalast <rechnung@pizzeria-koenigspalast.de>", to: [to], reply_to: INV_COPY_TO, subject, text, attachments: pdf ? [{ filename, content: b64(pdf) }] : undefined }) });
  if (!r.ok) console.log("Rechnungs-Mail fehlgeschlagen", r.status, (await r.text()).slice(0, 200));
  try { await env.DATA.put("mailstatus", (r.ok ? "ok " : "fehler-" + r.status + " ") + new Date().toISOString()); } catch (e) {}
  return r.ok;
}
// Bestellbestätigung per E-Mail an den Kunden (jede Bestellung): Bestellnummer, Artikel, Betrag, bei Lieferung voraussichtliche Ankunft.
// Bei einer Wunschzeit wird keine andere Uhrzeit genannt.
async function sendConfirm(env, rec) {
  const kv = env.DATA;
  try {
    if (!env.RESEND_API_KEY || !rec || !rec.email || rec.confMail) return;
    const ops = await getOps(env), prep = ops.wait || 35;
    const eu = (n) => (Number(n) || 0).toFixed(2).replace(".", ",") + " €";
    const lief = rec.type === "Lieferung", wa = rec.pay === "wa";
    const totalN = typeof rec.amount === "number" ? rec.amount / 100 : (rec.total || 0) + (rec.fee || 0) + (rec.tip || 0);
    const wish = String(rec.time || "").trim();
    const hasWish = /\d/.test(wish);
    const wishT = hasWish ? wishStr(rec) : "";
    let when, subj = "";
    if (wa) when = "Das ist eine unverbindliche Anfrage über WhatsApp. Sie gilt erst, wenn wir sie dir in WhatsApp bestätigt haben. Bitte schick dafür die vorbereitete WhatsApp-Nachricht ab.";
    else if (lief && hasWish) { when = "Lieferung zu deiner Wunschzeit: " + wishT + ". Falls das nicht klappt, melden wir uns telefonisch bei dir."; subj = " · Lieferung um " + wishT; }
    else if (lief) {
      const base = rec.paid ? rec.paidAt || Date.now() : rec.t;
      const drive = Math.max(0, Math.ceil(Number(rec.driveMin) || 0));
      const arr = Math.ceil((base + (prep + drive) * 60000) / 300000) * 300000;
      const hm = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(new Date(arr));
      when = "Voraussichtliche Ankunft: ca. " + hm + " Uhr (ca. " + prep + " Minuten Zubereitung plus ca. " + drive + " Minuten Fahrzeit).";
      subj = " · Lieferung gegen " + hm + " Uhr";
    } else when = hasWish ? "Abholung zu deiner Wunschzeit: " + wishT + "." : (ops.wait ? "Abholung: Deine Bestellung ist in ca. " + ops.wait + " Minuten fertig. Wir schicken dir eine E-Mail, sobald sie bereitliegt." : "Abholung: Wir bereiten deine Bestellung sofort zu. Wir schicken dir eine E-Mail, sobald sie bereitliegt.");
    const pay = wa ? null : rec.paid ? "Bezahlt: online (" + eu(totalN) + ")." : "Bitte bezahle " + eu(totalN) + " bei " + (lief ? "der Lieferung" : "der Abholung") + " bar oder mit Karte.";
    const inv = wa || !rec.invEmail ? null : rec.paid ? "Deine Rechnung bekommst du in einer eigenen E-Mail." : "Deine Rechnung schicken wir dir per E-Mail, sobald du bezahlt hast.";
    const body = [
      "Hallo " + rec.name + ",", "",
      (wa ? "vielen Dank für deine Anfrage." : "vielen Dank für deine Bestellung!") + " Deine Bestellnummer: " + rec.no, "",
      ...(rec.lines || []),
      rec.fee ? "Liefergebühr – " + eu(rec.fee) : null,
      rec.tip ? "Trinkgeld (Aufrundung auf den Mindestbestellwert) – " + eu(rec.tip) : null,
      "Gesamt: " + eu(totalN), "",
      lief ? "Lieferadresse: " + rec.addr : "Abholung bei uns: Westparkstraße 102, 47803 Krefeld",
      when, pay, inv,
      rec.note ? "Deine Anmerkung: " + rec.note : null,
      "", "Bei Fragen erreichst du uns unter 02151 4546528. Bitte nenne dabei deine Bestellnummer " + rec.no + ".", "", "Pizza & Baguettehaus am Königspalast",
    ].filter((x) => x !== null).join("\n");
    const subject = (wa ? "Deine Anfrage Nr. " : "Bestellbestätigung Nr. ") + rec.no + subj + " – Pizza & Baguettehaus am Königspalast";
    if (await sendMail(env, rec.email, subject, body)) {
      rec.confMail = true;
      await setJSON(kv, "o:" + rec.id, rec, { expirationTtl: ORDER_TTL_S });
    }
  } catch (e) {
    console.log("Bestätigungs-Mail Fehler", String(e));
  }
}
// Rechnung nach jeder bezahlten Online-Bestellung: PDF an die Geschäftsmail, auf Wunsch auch an den Kunden.
async function sendInvoice(env, rec) {
  const kv = env.DATA;
  try {
    if (!env.RESEND_API_KEY || !rec || !(rec.paid || rec.cashPaid)) return;
    if (rec.invBiz && (!rec.invEmail || rec.invCust)) return;
    if (!rec.invNo) {
      const n = (Number(await kv.get("invseq")) || INV_START) + 1;
      await kv.put("invseq", String(n));
      rec.invNo = "O-" + n;
      rec.invDate = rec.paidAt || Date.now();
      await setJSON(kv, "o:" + rec.id, rec, { expirationTtl: ORDER_TTL_S });
    }
    const pdf = buildInvoicePdf(rec, await loadLogo(env)), fn = "Rechnung-" + rec.invNo + ".pdf";
    const total = ((typeof rec.amount === "number" ? rec.amount : Math.round(((rec.total || 0) + (rec.fee || 0) + (rec.tip || 0)) * 100)) / 100).toFixed(2).replace(".", ",") + " €";
    if (!rec.invBiz) {
      const body = (rec.paid ? "Neue bezahlte Online-Bestellung" : "Bestellung mit Zahlung vor Ort, als bezahlt markiert") + (rec.no ? " (Bestellnummer " + rec.no + ")" : "") + ". Die Rechnung " + rec.invNo + " liegt als PDF an.\n\nKunde: " + rec.name + (rec.phone ? "\nTelefon: " + rec.phone : "") + "\nArt: " + rec.type + (rec.addr ? " (" + rec.addr + ")" : "") + "\nBetrag: " + total + "\nRechnung an Kunde: " + (rec.invEmail ? "ja, an " + rec.invEmail : "nein, nicht angefordert") + "\n\nBitte diese E-Mail als Buchhaltungsbeleg aufbewahren.";
      if (await sendMail(env, INV_COPY_TO, "Rechnung " + rec.invNo + ": " + (rec.paid ? "Online-Bestellung" : "Zahlung vor Ort") + (rec.no ? " Nr. " + rec.no : "") + " von " + rec.name + " (" + total + ")", body, fn, pdf)) rec.invBiz = true;
    }
    if (rec.invEmail && !rec.invCust) {
      const body = "Hallo " + rec.name + ",\n\nvielen Dank für deine Bestellung beim Pizza & Baguettehaus am Königspalast. Im Anhang findest du deine Rechnung " + rec.invNo + " über " + total + ".\n\nBei Fragen erreichst du uns telefonisch unter 02151 4546528 oder per Antwort auf diese E-Mail.\n\nGuten Appetit!\nPizza & Baguettehaus am Königspalast";
      if (await sendMail(env, rec.invEmail, "Deine Rechnung " + rec.invNo + " – Pizza & Baguettehaus am Königspalast", body, fn, pdf)) rec.invCust = true;
    }
    await setJSON(kv, "o:" + rec.id, rec, { expirationTtl: ORDER_TTL_S });
    await kv.put("invstatus", rec.invBiz && (!rec.invEmail || rec.invCust) ? "ok" : "fehler");
  } catch (e) {
    try { await kv.put("invstatus", "ausnahme"); } catch (e2) {}
  }
}

// ---------- Logo für die Rechnung (public/logo-rechnung.jpg) ----------
async function loadLogo(env) {
  try {
    const r = await env.ASSETS.fetch(new URL("/logo-rechnung.jpg", "https://pizzeria-koenigspalast.de"));
    if (!r.ok) return null;
    const u = new Uint8Array(await r.arrayBuffer());
    let i = 2;
    while (i + 9 < u.length) {
      if (u[i] !== 0xff) return null;
      const m = u[i + 1], len = (u[i + 2] << 8) | u[i + 3];
      if (m >= 0xc0 && m <= 0xc2) {
        const h = (u[i + 5] << 8) | u[i + 6], w = (u[i + 7] << 8) | u[i + 8], comps = u[i + 9];
        let bin = "";
        for (let k = 0; k < u.length; k += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(k, k + 0x8000));
        return { w, h, cs: comps === 1 ? "DeviceGray" : comps === 4 ? "DeviceCMYK" : "DeviceRGB", bin };
      }
      i += 2 + len;
    }
  } catch (e) {}
  return null;
}
// ---------- Umsatz-Buch (pro Bestellung) und Monatsabrechnung per E-Mail ----------
const TIP_TAXFREE = true; // Trinkgeld aus der Aufrundung ohne MwSt. (Vorgabe Inhaber, vom Steuerberater prüfen lassen)
const ymOf = (ts) => berlinDate(ts).slice(0, 7);
function vatSplit(e) {
  const g = { 7: 0, 19: 0 };
  for (const x of e.items || []) g[invRate(x)] += Math.round(x.unit * 100) * x.qty;
  const b7 = g[7], b19 = g[19], all = b7 + b19 || 1;
  const feeC = Math.round((e.fee || 0) * 100), tipC = Math.round((e.tip || 0) * 100);
  const f7 = Math.round((feeC * b7) / all);
  g[7] += f7; g[19] += feeC - f7;
  let tip = 0;
  if (TIP_TAXFREE) tip = tipC;
  else { const t7 = Math.round((tipC * b7) / all); g[7] += t7; g[19] += tipC - t7; }
  const n7 = Math.round(g[7] / 1.07), n19 = Math.round(g[19] / 1.19);
  return { g7: g[7], n7, v7: g[7] - n7, g19: g[19], n19, v19: g[19] - n19, tip, fee: feeC, total: g[7] + g[19] + tip };
}
async function addLedger(env, rec) {
  try {
    if (!rec || !rec.id || (!rec.paid && rec.pay !== "vorort")) return;
    const ts = rec.paid ? rec.paidAt || rec.t : rec.t;
    const e = { id: rec.id, no: rec.no || "", t: ts, pay: rec.paid ? "online" : "vorort", type: rec.type, invNo: rec.invNo || "", items: (rec.items || []).map((x) => ({ key: x.key || "", name: x.name, qty: x.qty, unit: x.unit, cat: x.cat })), fee: rec.fee || 0, tip: rec.tip || 0 };
    await setJSON(env.DATA, "led:" + ymOf(ts) + ":" + rec.id, e, { expirationTtl: 400 * 86400 });
  } catch (e) {
    console.log("Ledger-Fehler", String(e));
  }
}
// Am 1. jedes Monats: Aufstellung des Vormonats an die Geschäftsmail (Zusammenfassung + 2 CSV-Dateien für Excel)
async function monthlyReport(env, forceMonth) {
  const kv = env.DATA;
  try {
    if (!env.RESEND_API_KEY) return;
    const now = Date.now(), today = berlinDate(now);
    let ym = forceMonth;
    if (!ym) {
      if (today.slice(8, 10) !== "01") return;
      ym = berlinDate(berlinEpoch(today.slice(0, 8) + "01", "00:00") - 3600000).slice(0, 7);
      if (await kv.get("rep:" + ym)) return;
    }
    const list = [];
    let cursor;
    do {
      const r = await kv.list({ prefix: "led:" + ym + ":", cursor, limit: 1000 });
      for (const k of r.keys) { const e = await getJSON(kv, k.name); if (e) list.push(e); }
      cursor = r.list_complete ? null : r.cursor;
    } while (cursor);
    list.sort((a, b) => a.t - b.t);
    const eu = (c) => (c / 100).toFixed(2).replace(".", ",");
    const dt = (ts) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(ts));
    const tm = (ts) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
    const Z = () => ({ n: 0, g7: 0, n7: 0, v7: 0, g19: 0, n19: 0, v19: 0, tip: 0, fee: 0, total: 0 });
    const S = { online: Z(), vorort: Z() }, T = Z(), art = {};
    const rows = ["Datum;Uhrzeit;Bestellnr.;Rechnungsnr.;Zahlart;Art;Brutto gesamt;darin Liefergebühr;Trinkgeld (nicht umsatzsteuerbar);Brutto 7 %;Netto 7 %;MwSt. 7 %;Brutto 19 %;Netto 19 %;MwSt. 19 %"];
    for (const e of list) {
      const v = vatSplit(e), s = S[e.pay] || S.online;
      for (const o of [s, T]) { o.n++; for (const f of ["g7", "n7", "v7", "g19", "n19", "v19", "tip", "fee", "total"]) o[f] += v[f]; }
      rows.push([dt(e.t), tm(e.t), e.no || e.id.split(":")[1] || e.id, e.invNo || "", e.pay === "online" ? "Online (Stripe)" : "Vor Ort (bar/Karte)", e.type, eu(v.total), eu(v.fee), eu(v.tip), eu(v.g7), eu(v.n7), eu(v.v7), eu(v.g19), eu(v.n19), eu(v.v19)].join(";"));
      for (const x of e.items || []) {
        const rt = invRate(x), k = x.name + "|" + rt;
        const a = art[k] || (art[k] = { name: x.name, rate: rt, qty: 0, g: 0 });
        a.qty += x.qty;
        a.g += Math.round(x.unit * 100) * x.qty;
      }
    }
    const arts = ["Artikel;MwSt.-Satz;Menge;Umsatz brutto;Netto;MwSt."].concat(Object.values(art).sort((a, b) => b.g - a.g).map((a) => { const n = Math.round(a.g / (1 + a.rate / 100)); return [a.name, a.rate + " %", a.qty, eu(a.g), eu(n), eu(a.g - n)].join(";"); }));
    const block = (title, s) => title + ": " + s.n + " Bestellungen, Umsatz brutto " + eu(s.total) + " €\n  Speisen und anteilige Liefergebühr 7 %: brutto " + eu(s.g7) + " €, netto " + eu(s.n7) + " €, MwSt. " + eu(s.v7) + " €\n  Getränke und anteilige Liefergebühr 19 %: brutto " + eu(s.g19) + " €, netto " + eu(s.n19) + " €, MwSt. " + eu(s.v19) + " €\n  Liefergebühren gesamt " + eu(s.fee) + " € (in den Steuersätzen enthalten), Trinkgeld (nicht umsatzsteuerbar) " + eu(s.tip) + " €\n  MwSt. gesamt: " + eu(s.v7 + s.v19) + " €";
    const [yy, mm] = ym.split("-");
    const text = "Umsatzaufstellung " + mm + "/" + yy + " (Bestellungen über die Website)\n\n" + block("GESAMT", T) + "\n\n" + block("Online bezahlt (Stripe)", S.online) + "\n\n" + block("Zahlung vor Ort (bar oder Karte, bitte mit der Kasse abgleichen)", S.vorort) + "\n\nIm Anhang: alle Bestellungen einzeln und alle Artikel mit Steuersatz (CSV-Dateien, mit Excel zu öffnen).\n\nHinweise: Rückerstattungen in Stripe sind nicht abgezogen. Bestellungen per WhatsApp oder Telefon sind nicht enthalten. Vor-Ort-Bestellungen sind enthalten, auch wenn sie nicht abgeholt wurden. Steuersätze: Speisen 7 %, Getränke 19 %, Liefergebühr anteilig; Trinkgeld als nicht umsatzsteuerbar behandelt (bitte vom Steuerberater prüfen lassen).";
    const csv = (s) => b64(new TextEncoder().encode(String.fromCharCode(65279) + s));
    let custCsv = "";
    try { if (env.DB) { const D = await db(env); const cr = await D.prepare("SELECT id, email, name, phone, street, hnr, plz, city, created, last_seen FROM customers ORDER BY id").all(); const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; custCsv = ["Nr.;E-Mail;Name;Telefon;Straße;Nr.;PLZ;Ort;Konto seit;Zuletzt aktiv"].concat((cr.results || []).map((c) => [c.id, c.email, c.name, c.phone, c.street, c.hnr, c.plz, c.city, dt(c.created), dt(c.last_seen)].map(q).join(";"))).join("\r\n"); } } catch (e) {}
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ from: env.INVOICE_FROM || "Pizza & Baguettehaus am Königspalast <rechnung@pizzeria-koenigspalast.de>", to: [INV_COPY_TO], subject: "Umsatzaufstellung " + mm + "/" + yy + ": " + eu(T.total) + " € (" + T.n + " Bestellungen)", text, attachments: [{ filename: "Umsatz-" + ym + "-Bestellungen.csv", content: csv(rows.join("\r\n")) }, { filename: "Umsatz-" + ym + "-Artikel.csv", content: csv(arts.join("\r\n")) }].concat(custCsv ? [{ filename: "Sicherung-Kundenkonten-" + ym + ".csv", content: csv(custCsv) }] : []) }) });
    if (r.ok && !forceMonth) await kv.put("rep:" + ym, String(now), { expirationTtl: 60 * 86400 });
    await kv.put("repstatus", (r.ok ? "ok " : "fehler-" + r.status + " ") + ym);
    return r.ok;
  } catch (e) {
    try { await kv.put("repstatus", "ausnahme"); } catch (e2) {}
  }
}

async function refreshEvents(env) {
  const all = new Map();
  const now = new Date();
  for (let k = 0; k < 7; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    const url = `https://yayla-arena.de/veranstaltungskalender/?_m=${d.getUTCMonth() + 1}&_y=${d.getUTCFullYear()}`;
    try {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; pizzeria-koenigspalast.de Veranstaltungskalender)", "accept-language": "de-DE,de;q=0.9" } });
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
    await env.DATA.put("evstatus", "keine-termine " + new Date().toISOString());
    return;
  }
  await setJSON(env.DATA, "events", { updated: new Date().toISOString(), events });
  console.log(`${events.length} Termine gespeichert.`);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.hostname.startsWith("www.")) { url.hostname = url.hostname.slice(4); return Response.redirect(url.toString(), 301); }
    const { pathname } = url;
    if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(req, env);
    return env.ASSETS.fetch(req); // normale Seiten aus dem Ordner "public"
  },
  // Cron: "0 */6 * * *" = 00:00, 06:00, 12:00, 18:00 UTC
  async scheduled(event, env, ctx) {
    if (event.cron === "*/2 * * * *") ctx.waitUntil(Promise.all([runAsk(env).catch((e) => console.log("Rückfrage-Fehler", String(e))), refreshRating(env), dailyReport(env), reviewMails(env)]));
    else ctx.waitUntil(Promise.all([refreshEvents(env), monthlyReport(env), cleanupAccounts(env), computePopular(env), new Date().getUTCHours() === 6 ? selfCheck(env, false).catch((e) => console.log("Selbsttest-Fehler", String(e))) : null]));
  },
};
