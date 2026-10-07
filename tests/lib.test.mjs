/**
 * Unit tests for the serverless proxy logic (offline – no network needed).
 * Run with:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForm, handleCse } from '../lib/cse.js';
import { decodeXml, handleNews, parseRss } from '../lib/news.js';
import { baseHeaders } from '../lib/http.js';

test('buildForm rejects endpoints outside the whitelist', () => {
  assert.match(buildForm('../admin').error, /Unknown endpoint/);
  assert.match(buildForm('deleteEverything').error, /Unknown endpoint/);
});

test('buildForm validates and normalises parameters', () => {
  assert.deepEqual(buildForm('companyInfoSummery', { symbol: 'samp.n0000' }).form, { symbol: 'SAMP.N0000' });
  assert.ok(buildForm('companyInfoSummery', { symbol: 'SAMP<script>' }).error);
  assert.ok(buildForm('companyInfoSummery', {}).error);
  assert.deepEqual(buildForm('companyChartDataByStock', { stockId: '204', period: '5' }).form, { stockId: '204', period: '5' });
  assert.ok(buildForm('companyChartDataByStock', { stockId: '1;DROP', period: '5' }).error);
  assert.ok(buildForm('companyChartDataByStock', { stockId: '204', period: '9' }).error);
  assert.deepEqual(buildForm('tradeSummary', { junk: 'ignored' }).form, {});
});

test('handleCse answers OPTIONS / wrong method / bad endpoint without network', async () => {
  assert.equal((await handleCse('OPTIONS', {})).status, 204);
  assert.equal((await handleCse('POST', { endpoint: 'tradeSummary' })).status, 405);
  assert.equal((await handleCse('GET', { endpoint: 'nope' })).status, 400);
});

test('handleNews rejects unknown kinds', async () => {
  assert.equal((await handleNews('GET', { kind: 'evil' })).status, 400);
});

test('parseRss extracts items, decodes entities and drops non-http links', () => {
  const xml = `<rss><channel>
    <item><title>CSE &amp; ASPI hit record</title><link>https://example.lk/a</link>
      <pubDate>Mon, 05 Oct 2026 08:00:00 GMT</pubDate><source url="https://ft.lk">Daily FT</source></item>
    <item><title><![CDATA[Bad link]]></title><link>javascript:alert(1)</link></item>
    <item><title>කොළඹ කොටස් &#x0DC0;</title><link>https://example.lk/b</link></item>
  </channel></rss>`;
  const items = parseRss(xml, 10);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'CSE & ASPI hit record');
  assert.equal(items[0].source, 'Daily FT');
  assert.equal(items[1].title, 'කොළඹ කොටස් ව');
});

test('decodeXml handles CDATA and numeric entities', () => {
  assert.equal(decodeXml('<![CDATA[a < b]]>'), 'a < b');
  assert.equal(decodeXml('&#65;&#x42;&quot;'), 'AB"');
});

test('cache headers: CDN caching only when ttl > 0', () => {
  assert.match(baseHeaders({ ttl: 30 })['Cache-Control'], /s-maxage=30/);
  assert.equal(baseHeaders({})['Cache-Control'], 'no-store');
  assert.equal(baseHeaders({})['Access-Control-Allow-Origin'], '*');
});
