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
      "X-Goog-FieldMask": "routes.distanceMeters",
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
  const m = j.routes && j.routes[0] && j.routes[0].distanceMeters;
  if (typeof m !== "number") return { error: "addr" };
  return { km: m / 1000 };
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
    fee: Math.max(0, Math.min(20, Number(b.fee) || 0)),
    km: Math.max(0, Math.min(500, Number(b.km) || 0)),
  }, { expirationTtl: ORDER_TTL_S });
  return json({ ok: true });
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
    for (const n of tops) {
      const T = menu.TOPS.find((x) => x[0] === n);
      if (!T) return { error: "cart" };
      unit += addon(T[1]);
    }
    for (const n of sauces) if (!menu.SAUCES.includes(n)) return { error: "cart" };
    unit += Math.max(0, sauces.length - (o.sauce || 0)) * addon("sauce");
    if (sel.bake) {
      if (!o.bake) return { error: "cart" };
      unit += addon("bake");
    }
    const pick = o.pick ? (o.pick.options.includes(sel.pick) ? sel.pick : o.pick.options[0]) : "";
    unit = Math.round(unit * 100) / 100;
    const pre = C.prefix || "";
    const base = pre && !it[0].toLowerCase().includes(pre.trim().toLowerCase()) ? pre + it[0] : it[0];
    const name = base + (C.sizes ? ` (${C.sizes[Number(s)]})` : "");
    const det = [];
    if (o.pick && pick) det.push(`${o.pick.label}: ${pick}`);
    if (o.fixed) det.push("Inklusive: " + o.fixed.join(", "));
    if (sauces.length) det.push("Soßen: " + sauces.join(", "));
    if (tops.length) det.push("Extra: " + tops.join(", "));
    if (sel.bake) det.push("Überbacken");
    out.push({ name, det, note: str(l.note, 200), qty, unit });
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
async function handleCheckout(b, req, env) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return json({ error: "nopay" }, 503);
  const kv = env.DATA;
  // Missbrauchsschutz: höchstens 8 Zahlungsversuche pro IP in 10 Minuten
  const ipHash = await shortHash(req.headers.get("cf-connecting-ip") || "unbekannt");
  const rlKey = `ck:${ipHash}:${Math.floor(Date.now() / 600000)}`;
  const cnt = Number((await kv.get(rlKey)) || 0);
  if (cnt >= 8) return json({ error: "limit" }, 429);
  await kv.put(rlKey, String(cnt + 1), { expirationTtl: 1200 });
  // Hat der Inhaber auf "geschlossen" gestellt?
  const st = await getJSON(kv, "status");
  if (st && st.state === "closed" && st.expires > Date.now()) return json({ error: "closed" }, 409);
  const name = str(b.name, 80);
  const lief = b.fulfil === "Lieferung";
  if (!name) return json({ error: "name" }, 400);
  const addr = lief ? str(b.addr, 200) : "";
  if (lief && addr.length < 6) return json({ error: "addr" }, 400);
  // Preise serverseitig nachrechnen
  const menu = await (await env.ASSETS.fetch(new URL("/menu.json", req.url))).json();
  const PRd = await getJSON(kv, "prices");
  const PR = (PRd && PRd.prices) || {};
  const pm = await getJSON(kv, "pmode");
  const mode = lief ? "e" : pm && pm.until > Date.now() && (pm.mode === "d" || pm.mode === "e") ? pm.mode : autoMode();
  const priced = priceCart(menu, PR, mode, b.cart);
  if (priced.error) return json({ error: "cart" }, 400);
  let fee = 0, km = 0;
  if (lief) {
    if (!env.GOOGLE_MAPS_KEY) return json({ error: "route" }, 503);
    let a = addr;
    if (!/\d{5}/.test(a) && !a.includes(",")) a += ", Krefeld";
    const r = await routeKm(env, a);
    if (r.error) return json({ error: r.error === "addr" ? "addr" : "route" }, r.error === "addr" ? 422 : 502);
    const t = tierFor(r.km);
    if (priced.sum < t.min) return json({ error: "min", min: t.min }, 400);
    fee = t.fee;
    km = Math.round(r.km * 10) / 10;
  }
  const total = Math.round((priced.sum + fee) * 100) / 100;
  if (total > 500) return json({ error: "cart" }, 400);
  if (Math.round(Number(b.clientTotal) * 100) !== Math.round(total * 100)) return json({ error: "mismatch", total }, 409);
  // Bestellung bis zur Zahlung zwischenspeichern (2 Stunden)
  const t0 = Date.now();
  const id = `${t0}:${Math.random().toString(36).slice(2, 8)}`;
  const lines = priced.lines.map((x) => `${x.qty}x ${x.name} – ${eurS(x.unit * x.qty)}` + x.det.map((d) => `\n   ${d}`).join("") + (x.note ? `\n   Anmerkung: ${x.note}` : ""));
  await setJSON(kv, `p:${id}`, { id, t: t0, name, type: lief ? "Lieferung" : "Abholung", addr, time: str(b.time, 100), note: str(b.note, 500), lines, total: priced.sum, fee, km, paid: false, pay: "stripe" }, { expirationTtl: 7200 });
  // Stripe-Checkout-Sitzung anlegen
  const origin = new URL(req.url).origin;
  const p = new URLSearchParams();
  p.set("mode", "payment");
  p.set("locale", "de");
  p.set("success_url", origin + "/?bezahlt=1");
  p.set("cancel_url", origin + "/?bezahlt=0");
  p.set("client_reference_id", id.replace(":", "-"));
  p.set("metadata[order_id]", id);
  p.set("payment_intent_data[metadata][order_id]", id);
  p.set("payment_intent_data[description]", `Bestellung ${name} (${lief ? "Lieferung" : "Abholung"})`);
  p.set("phone_number_collection[enabled]", "true");
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
  const r = await stripePost(env, "checkout/sessions", p);
  if (!r.ok || !r.j.url) {
    await kv.delete(`p:${id}`);
    return json({ error: "stripe" }, 502);
  }
  return json({ url: r.j.url });
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
    if (path === "/config") return json({ route: !!env.GOOGLE_MAPS_KEY, pay: false });
    return json({ error: "not found" }, 404);
  }

  if (req.method === "POST") {
    let b = {};
    try { b = await req.json(); } catch (e) {}

    if (path === "/orders") return saveOrder(b, req, kv); // öffentlich
    if (path === "/route") return handleRoute(b, req, env); // öffentlich, begrenzt

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
    const url = new URL(req.url);
    if (url.hostname.startsWith("www.")) { url.hostname = url.hostname.slice(4); return Response.redirect(url.toString(), 301); }
    const { pathname } = url;
    if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(req, env);
    return env.ASSETS.fetch(req); // normale Seiten aus dem Ordner "public"
  },
  // Cron: "0 */6 * * *" = 00:00, 06:00, 12:00, 18:00 UTC
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshEvents(env));
  },
};
