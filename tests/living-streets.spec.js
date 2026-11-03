/* living-streets.html 端對端測試。讀真實資料（data/tiles/*.json、data/living_streets_taipei_check.json）。
   地圖圖磚為 PMTiles，需要支援 HTTP Range 的伺服器（python -m http.server 不支援）；
   用法：node <支援 Range 的靜態伺服器> . 8765，再執行 node tests/living-streets.spec.js */
const { chromium } = require('/tmp/claude-0/node_modules/playwright');
const fs = require('fs');
const SUM = JSON.parse(fs.readFileSync('data/tiles/living_streets_summary.json', 'utf8'));
const HIER = JSON.parse(fs.readFileSync('data/tiles/hierarchy_stats.json', 'utf8'));
const COUNTY = JSON.parse(fs.readFileSync('data/tiles/county_stats.json', 'utf8'));
const CHECK = JSON.parse(fs.readFileSync('data/living_streets_taipei_check.json', 'utf8'));
const PARK = JSON.parse(fs.readFileSync('data/taipei_parking_space.json', 'utf8'));
const URL = 'http://127.0.0.1:8765/living-streets.html';

const fail = [];
const check = (name, cond, extra) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra != null ? '  — ' + extra : ''}`);
  if (!cond) fail.push(name);
};
const pct = v => Math.round(100 * v) + '%';
async function open(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.vp || { width: 1280, height: 900 }, colorScheme: opts.dark ? 'dark' : 'light' });
  if (opts.lang) await ctx.addInitScript(l => { try { localStorage.setItem('lang', l); } catch (e) {} }, opts.lang);
  await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**://wmts.nlsc.gov.tw/**', r => r.fulfill({ status: 204, body: '' }));   // 底圖不在測試範圍
  if (opts.missing) await ctx.route('**/data/living_streets_taipei_check.json*', r => r.fulfill({ status: 404, body: 'not found' }));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL + (opts.query || ''), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  return { ctx, page, errs };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const NC = Object.keys(COUNTY).filter(k => /[縣市]$/.test(k)).length;

  console.log('— 中文、白底 —');
  {
    const { ctx, page, errs } = await open(browser);
    const tv = await page.$$eval('#tiles .value', a => a.map(e => e.firstChild.textContent));
    const le12 = SUM.by_class.A.km + SUM.by_class.B.km;
    check('磚1：12公尺以下道路公里數', tv[0] === Math.round(le12).toLocaleString('en-US'), tv[0]);
    check('磚2：進出道路比例', tv[1] === pct(HIER.A.km / (HIER.T.km + HIER.D.km + HIER.A.km)), tv[1]);
    const B = PARK.meta.totals.slot_m2_by_width.car, tot = B.lt8 + B.w8_12 + B.w12_15 + B.gt15;
    check('磚3：臺北汽車格在12m以下街道', tv[2] === pct((B.lt8 + B.w8_12) / tot), tv[2]);
    check('磚4：召回率', tv[3] === pct(CHECK.le12.recall), tv[3]);
    check('縣市圖：22縣市且由高到低', (await page.locator('#chart3 .row-hit').count()) === NC);
    const vals = await page.$$eval('#chart3 .row-val', a => a.map(e => parseFloat(e.textContent)));
    check('縣市圖：排序正確', vals.every((v, i) => !i || v <= vals[i - 1]), vals.slice(0, 4).join(','));
    check('地圖：生活街道圖層已繪製（canvas）', (await page.locator('#map canvas').count()) > 0);
    check('圖例：路寬模式兩項', (await page.locator('#mkey > span').count()) === 2);
    await page.check('#show15');
    check('勾選12–15公尺後圖例三項', (await page.locator('#mkey > span').count()) === 3);
    await page.click('#modeSeg .chip[data-mode="ss"]');
    check('切換道路功能層級：圖例三項、邊界案例選項隱藏', (await page.locator('#mkey > span').count()) === 3
      && !(await page.locator('#c15wrap').isVisible()));
    check('模式按鈕狀態', (await page.getAttribute('#modeSeg .chip[data-mode="ss"]', 'aria-pressed')) === 'true');
    await page.click('#modeSeg .chip[data-mode="width"]');
    // 移到臺北，放大後點選路段
    await page.selectOption('#goCounty', '臺北市'); await page.waitForTimeout(1500);
    const m = page.locator('#map'); await m.scrollIntoViewIfNeeded();
    const bb = await m.boundingBox();
    for (let i = 0; i < 3; i++) { await page.mouse.dblclick(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(800); }
    await page.waitForTimeout(2000);
    let shown = false;
    for (let k = 0; k < 64 && !shown; k++) {
      await page.mouse.click(bb.x + bb.width / 2 + ((k % 8) - 4) * 14, bb.y + bb.height / 2 + (Math.floor(k / 8) - 4) * 14);
      await page.waitForTimeout(200); shown = await page.locator('#info').isVisible();
    }
    const info = shown ? await page.locator('#info').textContent() : '';
    check('點選路段顯示估算路寬與 OSM 連結', shown && info.includes('估算路寬') && info.includes('OSM way/'), info.slice(0, 40));
    check('分級對照表：4×4＋合計', (await page.locator('#cmTable tbody tr').count()) === 4
      && (await page.locator('#cmTable tbody tr:first-child td').count()) === 5);
    const diag = await page.$$eval('#cmTable td.hl', a => a.length);
    check('對角線標示', diag === 4);
    check('路名後綴表含「街」', (await page.locator('#sfxTable').textContent()).includes('街'));
    check('臺北停車段落連到街道空間頁', (await page.locator('#park a[href="parking-space.html"]').count()) === 1);
    check('沒有 JS 錯誤', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log('\n— 英文與深色 —');
  {
    const { ctx, page, errs } = await open(browser, { lang: 'en', dark: true });
    check('英文標題', (await page.locator('h1').textContent()).startsWith('Living streets'));
    check('英文縣市名', (await page.locator('#chart3 .row-label').first().textContent()).match(/^[A-Za-z]/) !== null);
    check('深色背景', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(13, 13, 13)');
    check('沒有 JS 錯誤', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log('\n— 返回連結與手機 —');
  {
    const { ctx, page } = await open(browser, { query: '?from=atlas' });
    check('從 atlas 進入：返回全國交通安全地圖', (await page.locator('header a.back').getAttribute('href')) === '/taiwan-mobility-atlas/');
    await ctx.close();
  }
  for (const [w, lang] of [[320, 'zh'], [390, 'en']]) {
    const { ctx, page, errs } = await open(browser, { vp: { width: w, height: 800 }, lang });
    const r = await page.evaluate(() => ({
      ovf: document.documentElement.scrollWidth - innerWidth,
      out: [...document.querySelectorAll('.chart svg text')].filter(t => { const b = t.getBoundingClientRect(); return b.right > innerWidth + 1 || b.left < -1; }).length,
    }));
    check(`${w}px ${lang}：無水平捲動、文字不出界`, r.ovf <= 0 && r.out === 0 && errs.length === 0, `ovf ${r.ovf} out ${r.out}`);
    await ctx.close();
  }

  console.log('\n— 資料缺失 —');
  {
    const { ctx, page } = await open(browser, { missing: true });
    check('檢核資料缺少時顯示建置說明', await page.locator('#empty').isVisible());
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${fail.length ? '✗ ' + fail.length + ' 項失敗:\n   - ' + fail.join('\n   - ') : '✓ 全部通過'}`);
  process.exit(fail.length ? 1 : 0);
})();
