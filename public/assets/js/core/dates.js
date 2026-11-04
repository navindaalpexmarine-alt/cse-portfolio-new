/**
 * One date parser for every CSE / news format we see:
 *   1791545429280 · "1791545429" (epoch ms / s)
 *   "20-10-2026" · "09-10-2026 05:00:29 PM"         (cashDividends: DD-MM-YYYY)
 *   "27 Oct 2026" · "04 Nov 2026 03:36:59 PM"        (announcements)
 *   "2026-11-04" · "2026-11-04 10:22:11" · ISO       (everything else)
 *   RFC 2822 news dates ("Tue, 04 Nov 2026 08:00:00 GMT")
 * Day-first formats are read as Sri Lanka local dates. Works the same in Safari.
 */
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function clock(h, m, s, ampm) {
  let hh = Number(h) || 0;
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (hh === 12) hh = pm ? 12 : 0;
    else if (pm) hh += 12;
  }
  return [hh, Number(m) || 0, Number(s) || 0];
}

/** Returns a valid Date or null. */
export function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v > 1e11 ? v : v * 1000) : null;
  const s = String(v).trim();
  if (/^\d{13}$/.test(s)) return new Date(Number(s));
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);

  // DD-MM-YYYY or DD/MM/YYYY [hh:mm[:ss] [AM|PM]]
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m) {
    const [hh, mi, ss] = clock(m[4], m[5], m[6], m[7]);
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), hh, mi, ss);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // DD Mon YYYY [hh:mm[:ss] [AM|PM]]
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m && MON[m[2].toLowerCase()] != null) {
    const [hh, mi, ss] = clock(m[4], m[5], m[6], m[7]);
    const d = new Date(Number(m[3]), MON[m[2].toLowerCase()], Number(m[1]), hh, mi, ss);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // YYYY-MM-DD hh:mm:ss → ISO (Safari needs the "T")
  const iso = s.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2');
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Epoch ms (0 if unknown) — handy for sorting. */
export const timeOf = (v) => parseDate(v)?.getTime() || 0;
