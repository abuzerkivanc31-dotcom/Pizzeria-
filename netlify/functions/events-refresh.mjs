// Netlify-Funktion (zeitgesteuert): liest alle 6 Stunden den Veranstaltungskalender der YAYLA Arena
// und speichert die Eventtage. Die Seite lädt sie über /api/events.
// Cron läuft in UTC: "0 */6 * * *" = 00:00, 06:00, 12:00, 18:00 UTC.
import { getStore } from "@netlify/blobs";

export const config = { schedule: "0 */6 * * *" };

const OFFEN_VOR_BEGINN_STUNDEN = 4; // der Laden öffnet so viele Stunden vor Veranstaltungsbeginn

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

export default async () => {
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
  await getStore("pizzeria").setJSON("events", { updated: new Date().toISOString(), events });
  console.log(`${events.length} Termine gespeichert.`);
};
