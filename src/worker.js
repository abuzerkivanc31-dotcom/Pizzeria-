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
  if (!j.routes || !j.routes[0]) return { error: "addr" };
  return { km: (j.routes[0].distanceMeters || 0) / 1000 };
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
    const okS = Array.isArray(o.sauces) ? o.sauces : menu.SAUCES;
    for (const n of sauces) if (!okS.includes(n)) return { error: "cart" };
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
    out.push({ name, det, note: str(l.note, 200), qty, unit, cat: c, desc: String(it[1] || "") });
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
  if (st && st.state === "closed" && st.expires > Date.now()) return json({ error: "closed" }, 409);
  const name = str(b.name, 80);
  const lief = b.fulfil === "Lieferung";
  if (!name) return json({ error: "name" }, 400);
  const phoneRaw = String(b.phone || "").replace(/[^\d+]/g, "");
  const phoneDigits = phoneRaw.replace(/\D/g, "");
  if (phoneDigits.length < 8 || phoneDigits.length > 15) return json({ error: "phone" }, 400);
  const phone = phoneRaw.slice(0, 20);
  const invRaw = String(b.invoiceEmail || "").trim().slice(0, 120);
  const invEmail = !vorOrt && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(invRaw) ? invRaw : "";
  if (invRaw && !vorOrt && !invEmail) return json({ error: "email" }, 400);
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
  if (vorOrt) {
    const rec = { id, t: t0, name, type: lief ? "Lieferung" : "Abholung", addr, time: str(b.time, 100), note: str(b.note, 500), lines, total: priced.sum, fee, km, phone, paid: false, pay: "vorort" };
    await setJSON(kv, `o:${id}`, rec, { expirationTtl: ORDER_TTL_S });
    await notifyTelegram(env, rec);
    return json({ ok: true });
  }
  await setJSON(kv, `p:${id}`, { id, t: t0, name, type: lief ? "Lieferung" : "Abholung", addr, time: str(b.time, 100), note: str(b.note, 500), lines, total: priced.sum, fee, km, phone, items: priced.lines.map((x) => ({ name: x.name, det: x.det, note: x.note, qty: x.qty, unit: x.unit, cat: x.cat, desc: x.desc })), invEmail, paid: false, pay: "stripe" }, { expirationTtl: 7200 });
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
    const total = typeof rec.amount === "number" ? rec.amount / 100 : (rec.total || 0) + (rec.fee || 0);
    const text = [
      rec.paid ? "🍕 Neue bezahlte Bestellung" : "🍕 Neue Bestellung: Zahlung vor Ort (noch NICHT bezahlt)",
      "",
      "Name: " + rec.name,
      rec.type === "Lieferung" ? "Lieferung an: " + rec.addr + (rec.km ? " (" + rec.km + " km)" : "") : "Abholung",
      rec.time ? "Wunschzeit: " + rec.time : "",
      rec.phone ? "Telefon: " + rec.phone : "",
      "",
      ...(rec.lines || []),
      rec.note ? "\nAnmerkung: " + rec.note : "",
      "",
      (rec.paid ? "Gesamt bezahlt: " : "Zu zahlen bei Abholung/Lieferung (bar oder Karte): ") + eurS(total) + (rec.fee ? " (inkl. " + eurS(rec.fee) + " Liefergebühr)" : ""),
    ].filter((x, i, a) => x !== "" || (a[i - 1] !== "" && i > 0)).join("\n").slice(0, 4000);
    // Mehrere Empfänger: TELEGRAM_CHAT_ID darf eine Liste sein (Komma getrennt)
    const ids = String(chat).split(/[\s,;]+/).filter(Boolean);
    let okN = 0, lastErr = 0;
    for (const cid of ids) {
      const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cid, text }),
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
      await setJSON(kv, `o:${id}`, rec, { expirationTtl: ORDER_TTL_S });
      if (pend) await kv.delete(`p:${id}`);
      if ((await notifyTelegram(env, rec)) === "ok") { rec.tgDone = true; await setJSON(kv, `o:${id}`, rec, { expirationTtl: ORDER_TTL_S }); }
    } else if (id && s.payment_status === "paid") {
      const ex = await getJSON(kv, `o:${id}`);
      if (ex && !ex.tgDone && (await notifyTelegram(env, ex)) === "ok") { ex.tgDone = true; await setJSON(kv, `o:${id}`, ex, { expirationTtl: ORDER_TTL_S }); }
    }
    if (id && s.payment_status === "paid") await sendInvoice(env, await getJSON(kv, "o:" + id));
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
    if (path === "/config") return json({ route: !!env.GOOGLE_MAPS_KEY, pay: PAY_ENABLED && !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET, tg: (await kv.get("tgstatus")) || "-", rt: (await kv.get("rtstatus")) || "-", inv: !!env.RESEND_API_KEY, iv: (await kv.get("invstatus")) || "-" });
    return json({ error: "not found" }, 404);
  }

  if (req.method === "POST") {
    if (path === "/stripe-webhook") return handleStripeWebhook(req, env); // braucht den Rohtext
    let b = {};
    try { b = await req.json(); } catch (e) {}

    if (path === "/orders") return saveOrder(b, req, kv); // öffentlich (WhatsApp-Anfragen)
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
async function tgPoll(env, kv, ids, pend) {
  const off = Number(await kv.get("tgoff")) || 0;
  const r = await tgApi(env, "getUpdates", off ? { offset: off } : {});
  const list = (r && r.result) || [];
  let ans = null, maxId = off - 1;
  for (const u of list) {
    maxId = Math.max(maxId, u.update_id);
    if (u.callback_query) {
      const cq = u.callback_query, from = String(cq.message && cq.message.chat && cq.message.chat.id);
      const parts = String(cq.data || "").split(":");
      await tgApi(env, "answerCallbackQuery", { callback_query_id: cq.id });
      if (ids.includes(from) && parts[1] === pend.id && (parts[0] === "ja" || parts[0] === "nein")) ans = parts[0];
    } else if (u.message && u.message.text && ids.includes(String(u.message.chat.id)) && u.message.date * 1000 >= pend.at - 5000) {
      const tx = u.message.text.trim().toLowerCase().replace(/[^a-zäöü]/g, "");
      if (tx === "ja" || tx === "nein") ans = tx;
    }
  }
  if (list.length) await kv.put("tgoff", String(maxId + 1));
  return ans;
}
async function runAsk(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const kv = env.DATA, now = Date.now();
  const ids = await tgRecipients(env);
  if (!ids.length) return;
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
    const ans = await tgPoll(env, kv, ids, st.pend);
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
      const dr = await tgApi(env, "getUpdates", { offset: -1 });
      const last = ((dr && dr.result) || [])[0];
      if (last) await kv.put("tgoff", String(last.update_id + 1));
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
function pdfBuild(pages) {
  const objs = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("<< /Type /Pages /Kids [" + pages.map((_, i) => (5 + i * 2) + " 0 R").join(" ") + "] /Count " + pages.length + " >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((c, i) => {
    objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents " + (6 + i * 2) + " 0 R >>");
    objs.push("<< /Length " + c.length + " >>\nstream\n" + c + "\nendstream");
  });
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
function buildInvoicePdf(rec) {
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
  const feeC = Math.round((rec.fee || 0) * 100);
  if (feeC > 0) {
    const g = gross[7] + gross[19] || 1;
    const f7 = Math.round((feeC * gross[7]) / g), f19 = feeC - f7;
    const label = "Liefergebühr" + (rec.km ? " (" + String(rec.km).replace(".", ",") + " km Fahrstrecke)" : "");
    if (f7 > 0) rows.push({ name: label + (f19 > 0 ? ", Anteil 7 %" : ""), det: [], qty: 1, unitC: f7, totC: f7, rate: 7 });
    if (f19 > 0) rows.push({ name: label + (f7 > 0 ? ", Anteil 19 %" : ""), det: [], qty: 1, unitC: f19, totC: f19, rate: 19 });
    gross[7] += f7; gross[19] += f19;
  }
  const totalC = gross[7] + gross[19];
  const header = (first) => {
    c = [];
    if (first) {
      T(SELLER.name, L, 790, 13, true);
      [SELLER.owner, SELLER.street + ", " + SELLER.city, SELLER.phone, "E-Mail: " + SELLER.mail].forEach((s, i) => T(s, L, 775 - i * 12.5, 9, false, true));
      T("RECHNUNG", R, 790, 22, true, false, true);
      [["Rechnungsnummer", no], ["Rechnungsdatum", dfmt(inDate)], ["Leistungsdatum", dfmt(inDate)], ["Bestellt am", tfmt(rec.t)]].forEach((p, i) => { T(p[0], 400, 764 - i * 14, 9, false, true); T(p[1], R, 764 - i * 14, 10, true, false, true); });
      T(SELLER.name + " · " + SELLER.street + " · " + SELLER.city, L, 696, 7, false, true);
      let yy = 681;
      T(rec.name || "Kunde", L, yy, 11, true);
      if (rec.type === "Lieferung" && rec.addr) wrap(rec.addr, false, 10, 250).slice(0, 3).forEach((s) => { yy -= 13; T(s, L, yy, 10); });
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
    const nameL = wrap(r.name, false, 9.5, 255), detL = [];
    r.det.forEach((d) => wrap(d, false, 8, 250).forEach((s) => detL.push(s)));
    const h = nameL.length * 12 + detL.length * 10 + 6;
    if (y - h < 100) { pages.push(c); header(false); }
    T(String(i + 1), L + 4, y, 9.5);
    nameL.forEach((s, k) => T(s, L + 34, y - k * 12, 9.5));
    detL.forEach((s, k) => T(s, L + 40, y - nameL.length * 12 - k * 10 + 2, 8, false, true));
    T(String(r.qty), 335, y, 9.5, false, false, true); T(money(r.unitC), 405, y, 9.5, false, false, true); T(r.rate + " %", 452, y, 9.5, false, false, true); T(money(r.totC), R - 4, y, 9.5, false, false, true);
    y -= h;
    Ln(L, y + 10, R, y + 10, 0.3);
  });
  if (y < 230) { pages.push(c); header(false); }
  y -= 12;
  [7, 19].forEach((rt) => {
    if (!gross[rt]) return;
    const net = Math.round(gross[rt] / (1 + rt / 100)), vat = gross[rt] - net;
    T("Nettobetrag " + rt + " %", 400, y, 9.5, false, false, true); T(money(net), R - 4, y, 9.5, false, false, true); y -= 13;
    T("Umsatzsteuer " + rt + " %", 400, y, 9.5, false, false, true); T(money(vat), R - 4, y, 9.5, false, false, true); y -= 15;
  });
  Ln(330, y + 6, R, y + 6, 0.8);
  y -= 8;
  T("Gesamtbetrag (brutto)", 400, y, 11, true, false, true); T(money(totalC), R - 4, y, 11, true, false, true); y -= 18;
  T("Bezahlt per Online-Zahlung am " + dfmt(rec.paidAt || inDate), 400, y, 9.5, false, false, true); T("-" + money(totalC), R - 4, y, 9.5, false, false, true); y -= 14;
  T("Offener Betrag", 400, y, 9.5, true, false, true); T(money(0), R - 4, y, 9.5, true, false, true); y -= 30;
  wrap("Alle Preise sind Endpreise inklusive der gesetzlichen Umsatzsteuer. Der Rechnungsbetrag wurde bereits bezahlt. Das Leistungsdatum entspricht dem Rechnungsdatum.", false, 8.5, R - L).forEach((s) => { T(s, L, y, 8.5, false, true); y -= 11; });
  pages.push(c);
  pages.forEach((arr, i) => {
    arr.push("0.8 w 0.55 G " + L + " 62 m " + R + " 62 l S");
    T(SELLER.name + " · " + SELLER.owner, L, 50, 7.5, false, true, false, arr);
    T(SELLER.street + ", " + SELLER.city + " · " + SELLER.phone + " · " + SELLER.mail + " · " + SELLER.tax, L, 40, 7.5, false, true, false, arr);
    T("Seite " + (i + 1) + " von " + pages.length, R, 50, 7.5, false, true, true, arr);
  });
  return pdfBuild(pages.map((a) => a.join("\n")));
}
function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
async function sendMail(env, to, subject, text, filename, pdf) {
  const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ from: env.INVOICE_FROM || "Pizza & Baguettehaus am Königspalast <rechnung@pizzeria-koenigspalast.de>", to: [to], reply_to: INV_COPY_TO, subject, text, attachments: [{ filename, content: b64(pdf) }] }) });
  if (!r.ok) console.log("Rechnungs-Mail fehlgeschlagen", r.status, (await r.text()).slice(0, 200));
  return r.ok;
}
// Rechnung nach jeder bezahlten Online-Bestellung: PDF an die Geschäftsmail, auf Wunsch auch an den Kunden.
async function sendInvoice(env, rec) {
  const kv = env.DATA;
  try {
    if (!env.RESEND_API_KEY || !rec || !rec.paid) return;
    if (rec.invBiz && (!rec.invEmail || rec.invCust)) return;
    if (!rec.invNo) {
      const n = (Number(await kv.get("invseq")) || INV_START) + 1;
      await kv.put("invseq", String(n));
      rec.invNo = "O-" + n;
      rec.invDate = rec.paidAt || Date.now();
      await setJSON(kv, "o:" + rec.id, rec, { expirationTtl: ORDER_TTL_S });
    }
    const pdf = buildInvoicePdf(rec), fn = "Rechnung-" + rec.invNo + ".pdf";
    const total = ((typeof rec.amount === "number" ? rec.amount : Math.round(((rec.total || 0) + (rec.fee || 0)) * 100)) / 100).toFixed(2).replace(".", ",") + " €";
    if (!rec.invBiz) {
      const body = "Neue bezahlte Online-Bestellung. Die Rechnung " + rec.invNo + " liegt als PDF an.\n\nKunde: " + rec.name + (rec.phone ? "\nTelefon: " + rec.phone : "") + "\nArt: " + rec.type + (rec.addr ? " (" + rec.addr + ")" : "") + "\nBetrag: " + total + "\nRechnung an Kunde: " + (rec.invEmail ? "ja, an " + rec.invEmail : "nein, nicht angefordert") + "\n\nBitte diese E-Mail als Buchhaltungsbeleg aufbewahren.";
      if (await sendMail(env, INV_COPY_TO, "Rechnung " + rec.invNo + ": Online-Bestellung von " + rec.name + " (" + total + ")", body, fn, pdf)) rec.invBiz = true;
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
    if (event.cron === "*/2 * * * *") ctx.waitUntil(Promise.all([runAsk(env).catch((e) => console.log("Rückfrage-Fehler", String(e))), refreshRating(env)]));
    else ctx.waitUntil(refreshEvents(env));
  },
};
