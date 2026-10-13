/* 底圖備援測試：CARTO（有金鑰）→ 國土測繪中心 → OpenStreetMap。圖磚伺服器全部以模擬回應攔截。 */
const { chromium } = require('/tmp/claude-0/node_modules/playwright');
const fs = require('fs');
const LJ = fs.readFileSync('/tmp/claude-0/vendor/dist/leaflet.js', 'utf8');
const LC = fs.readFileSync('/tmp/claude-0/vendor/dist/leaflet.css', 'utf8');
const PNG = fs.readFileSync(process.env.TILE_PNG || '/tmp/claude-0/rs/tile.png');

const fail = [];
const check = (n, c, x) => { console.log(`${c ? '  PASS' : '  FAIL'}  ${n}${x != null ? '  — ' + x : ''}`); if (!c) fail.push(n); };

async function run(browser, { key = '', nlsc = 'ok', osm = 'ok' }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const hits = { carto: [], nlsc: 0, osm: 0 };
  await ctx.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.js', r => r.fulfill({ contentType: 'application/javascript', body: LJ }));
  await ctx.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.css', r => r.fulfill({ contentType: 'text/css', body: LC }));
  await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**://maps.googleapis.com/**', r => r.abort());
  await ctx.route('**://*.supabase.co/**', r => r.abort());
  await ctx.route('**/data/basemap_config.js*', r => r.fulfill({ contentType: 'application/javascript',
    body: `window.BASEMAP_CONFIG={cartoKey:${JSON.stringify(key)}};` }));
  await ctx.route('**://*.basemaps.cartocdn.com/**', r => { hits.carto.push(r.request().url()); r.fulfill({ contentType: 'image/png', body: PNG }); });
  await ctx.route('**://wmts.nlsc.gov.tw/**', r => { hits.nlsc++; nlsc === 'ok' ? r.fulfill({ contentType: 'image/jpeg', body: PNG }) : r.abort(); });
  await ctx.route('**://tile.openstreetmap.org/**', r => { hits.osm++; osm === 'ok' ? r.fulfill({ contentType: 'image/png', body: PNG }) : r.abort(); });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => ({
    bm: window.__basemap,
    gray: document.querySelectorAll('#segmap .bm-gray').length,
    tiles: document.querySelectorAll('#segmap .leaflet-tile-loaded').length,
    attr: (document.querySelector('#segmap .leaflet-control-attribution') || {}).textContent || '',
  }));
  await ctx.close();
  return { hits, st, errs };
}

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  console.log('\n— 沒有金鑰 —');
  let r = await run(b, {});
  check('改用國土測繪中心', r.st.bm === 'nlsc', r.st.bm);
  check('完全不再請求 CARTO（避免浮水印圖磚）', r.hits.carto.length === 0, `${r.hits.carto.length} 次`);
  check('圖磚有載入', r.st.tiles > 0, `${r.st.tiles} 張`);
  check('套用灰階濾鏡', r.st.gray === 1);
  check('標示國土測繪中心來源', r.st.attr.includes('內政部國土測繪中心'), r.st.attr.trim());
  check('沒用到 OpenStreetMap', r.hits.osm === 0);
  check('無 JS 錯誤', r.errs.length === 0, r.errs.join(' | '));

  console.log('\n— 國土測繪中心連不上 —');
  r = await run(b, { nlsc: 'down' });
  check('自動改用 OpenStreetMap', r.st.bm === 'osm', r.st.bm);
  check('OpenStreetMap 圖磚有載入', r.st.tiles > 0, `${r.st.tiles} 張`);
  check('標示 OpenStreetMap 來源', r.st.attr.includes('OpenStreetMap'), r.st.attr.trim());
  check('仍套用灰階濾鏡', r.st.gray === 1);
  check('無 JS 錯誤', r.errs.length === 0, r.errs.join(' | '));

  console.log('\n— 兩個免金鑰來源都掛掉 —');
  r = await run(b, { nlsc: 'down', osm: 'down' });
  check('不會無限重試、不報錯', r.errs.length === 0 && r.hits.osm < 60, `osm 請求 ${r.hits.osm} 次`);

  console.log('\n— 有 CARTO 金鑰 —');
  r = await run(b, { key: 'test-key-123' });
  check('回到 CARTO', r.st.bm === 'carto', r.st.bm);
  check('每個 CARTO 請求都帶金鑰', r.hits.carto.length > 0 && r.hits.carto.every(u => u.includes('key=test-key-123')),
        `${r.hits.carto.length} 次`);
  check('底圖與標籤兩層都有', r.hits.carto.some(u => u.includes('light_nolabels')) && r.hits.carto.some(u => u.includes('light_only_labels')));
  check('CARTO 不套灰階', r.st.gray === 0);
  check('沒用到國土測繪中心', r.hits.nlsc === 0);
  check('無 JS 錯誤', r.errs.length === 0, r.errs.join(' | '));

  await b.close();
  console.log(`\n${fail.length ? '✗ ' + fail.length + ' 項失敗:\n   - ' + fail.join('\n   - ') : '✓ 全部通過'}`);
  process.exit(fail.length ? 1 : 0);
})();
