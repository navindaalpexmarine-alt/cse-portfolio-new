/**
 * Minimal, dependency-free PDF text extraction for simple generated reports
 * (e.g. the ATrad "Daily Symbol Trading Summary" PDF made by iText).
 * Returns the text strings in drawing order. Not a general PDF reader:
 * no CID fonts, no encryption, no object streams.
 */
import { inflateSync } from 'node:zlib';

const MAX_PDF = 2 * 1024 * 1024;

function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (m, c) => {
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] ?? '';
  });
}

/** Buffer -> array of strings shown with Tj / TJ, in content-stream order. */
export function pdfStrings(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.length > MAX_PDF) throw new Error('Not a valid PDF file.');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Not a PDF file.');
  const bin = buf.toString('latin1');
  if (/\/Encrypt\b/.test(bin)) throw new Error('Encrypted PDFs are not supported.');
  const out = [];
  const re = /<<((?:(?!>>\s*stream)[\s\S]){0,2000})>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(bin))) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const end = bin.indexOf('endstream', start);
    if (end < 0) break;
    if (/\/Subtype\s*\/Image/.test(dict)) continue;
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try { data = inflateSync(data); } catch { continue; }
    } else if (/\/Filter/.test(dict)) continue;
    const text = data.toString('latin1');
    if (!/T[jJ]/.test(text)) continue;
    // (string) Tj   and   [(a) 12 (b)] TJ
    const tok = /\(((?:\\[\s\S]|[^\\)])*)\)\s*Tj|\[((?:\\[\s\S]|[^\]])*)\]\s*TJ/g;
    let t;
    while ((t = tok.exec(text))) {
      if (t[1] !== undefined) out.push(unescapePdf(t[1]));
      else {
        const parts = [...t[2].matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)/g)].map((p) => unescapePdf(p[1]));
        out.push(parts.join(''));
      }
    }
    re.lastIndex = end;
  }
  return out.map((s) => s.trim()).filter(Boolean);
}
