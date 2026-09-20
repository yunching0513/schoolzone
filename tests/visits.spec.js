/* 造訪人次計數的端對端測試（Playwright，後端以模擬回應攔截）
   驗證：顯示、首次/回訪/重新整理的計數語意、隱私（不送出識別資訊）、
   未設定或後端失敗時不留下壞掉的畫面。 */
const { chromium } = require('/tmp/claude-0/node_modules/playwright');
const fs = require('fs');
const LEAFLET_JS  = fs.readFileSync('/tmp/claude-0/vendor/dist/leaflet.js', 'utf8');
const LEAFLET_CSS = fs.readFileSync('/tmp/claude-0/vendor/dist/leaflet.css', 'utf8');

const fail = [];
function check(name, cond, extra) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) fail.push(name);
}

async function stub(ctx, opts = {}) {
  await ctx.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.js', r =>
    r.fulfill({ contentType: 'application/javascript', body: LEAFLET_JS }));
  await ctx.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.css', r =>
    r.fulfill({ contentType: 'text/css', body: LEAFLET_CSS }));
  await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**://*.basemaps.cartocdn.com/**', r => r.abort());
  await ctx.route('**://maps.googleapis.com/**', r => r.abort());
  await ctx.route('**/data/ppgis_config.js*', r => r.fulfill({
    contentType: 'application/javascript',
    body: opts.unconfigured
      ? `window.PPGIS_CONFIG={url:'',anonKey:''};`
      : `window.PPGIS_CONFIG={url:'https://test.supabase.co',anonKey:'anon-test-key'};`,
  }));
  await ctx.route('**://test.supabase.co/**', (route, req) => {
    const url = req.url();
    if (opts.calls) opts.calls.push({ url, body: req.postData() ? JSON.parse(req.postData()) : null });
    if (opts.down) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    const json = o => route.fulfill({ contentType: 'application/json', body: JSON.stringify(o) });
    if (url.includes('record_visit'))    return json([{ total_visits: 1234, total_visitors: 567, today_visits: 89 }]);
    if (url.includes('get_visit_stats')) return json([{ total_visits: 1234, total_visitors: 567, today_visits: 89 }]);
    return json([]);
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errs = [];

  console.log('\n— 首次造訪 —');
  const calls = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await stub(ctx, { calls });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  check('頁尾出現計數器', await page.locator('#visitCount').count() === 1);
  const txt = await page.locator('#visitCount').innerText();
  check('顯示三項數字', /1,234/.test(txt) && /567/.test(txt) && /89/.test(txt), txt.replace(/\n/g, ' '));
  check('位置在版權與標籤之間',
    await page.evaluate(() => {
      const f = document.querySelector('footer'), k = [...f.children];
      return k.indexOf(document.getElementById('visitCount')) === 1
          && k.indexOf(f.querySelector('.tags')) === 2;
    }));

  const rv = calls.find(c => c.url.includes('record_visit'));
  check('呼叫 record_visit', !!rv);
  check('首次造訪標記為新訪客', rv && rv.body.p_new === true);
  check('未送出任何識別資訊',
    rv && Object.keys(rv.body).length === 1 && 'p_new' in rv.body, rv && JSON.stringify(rv.body));

  console.log('\n— 同一分頁重新整理（不應重複計數）—');
  calls.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  check('改呼叫唯讀的 get_visit_stats', calls.some(c => c.url.includes('get_visit_stats')));
  check('未再呼叫 record_visit', !calls.some(c => c.url.includes('record_visit')));
  check('重新整理後仍顯示', (await page.locator('#visitCount').innerText()).includes('1,234'));

  console.log('\n— 回訪（新分頁，localStorage 保留）—');
  calls.length = 0;
  const page2 = await ctx.newPage();          // 新分頁 = 新 sessionStorage、同 localStorage
  await page2.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(1200);
  const rv2 = calls.find(c => c.url.includes('record_visit'));
  check('回訪仍計一次造訪', !!rv2);
  check('回訪不再計為新訪客', rv2 && rv2.body.p_new === false, rv2 && JSON.stringify(rv2.body));
  await ctx.close();

  console.log('\n— 語言切換 —');
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await stub(ctx2);
  const p3 = await ctx2.newPage();
  await p3.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
  await p3.waitForTimeout(1300);
  check('中文標籤', (await p3.locator('#visitCount').innerText()).includes('次造訪'));
  await p3.click('.lang-toggle [data-lang="en"]');
  await p3.waitForTimeout(400);
  const en = await p3.locator('#visitCount').innerText();
  check('切到英文後標籤更新', /visits/i.test(en) && !en.includes('次造訪'), en.replace(/\n/g, ' '));
  await ctx2.close();

  console.log('\n— 後端失敗時不得留下壞掉的畫面 —');
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await stub(ctx3, { down: true });
  const p4 = await ctx3.newPage();
  const errs4 = [];
  p4.on('pageerror', e => errs4.push(e.message));
  await p4.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
  await p4.waitForTimeout(1300);
  check('後端 500 時不顯示計數器', await p4.locator('#visitCount').count() === 0);
  check('後端 500 時無 JS 錯誤', errs4.length === 0, errs4.join(' | '));
  await ctx3.close();

  console.log('\n— 未設定後端 —');
  const ctx4 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await stub(ctx4, { unconfigured: true });
  const p5 = await ctx4.newPage();
  const errs5 = [];
  p5.on('pageerror', e => errs5.push(e.message));
  await p5.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
  await p5.waitForTimeout(1300);
  check('未設定時不顯示計數器', await p5.locator('#visitCount').count() === 0);
  check('未設定時無 JS 錯誤', errs5.length === 0, errs5.join(' | '));
  await ctx4.close();

  check('主流程無 JS 錯誤', errs.length === 0, errs.join(' | '));

  console.log('\n— 手機版頁尾不得溢出 —');
  for (const w of [320, 390]) {
    const c = await browser.newContext({ viewport: { width: w, height: 844 } });
    await stub(c);
    const p = await c.newPage();
    await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1300);
    const r = await p.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    }));
    check(`${w}px 無水平溢出`, r.sw <= r.cw, `scrollWidth=${r.sw} / ${r.cw}`);
    await c.close();
  }

  await browser.close();
  console.log(`\n${fail.length ? '✗ ' + fail.length + ' 項失敗:\n   - ' + fail.join('\n   - ') : '✓ 全部通過'}`);
  process.exit(fail.length ? 1 : 0);
})();
