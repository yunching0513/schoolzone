/* road-safety.html 端對端測試。資料以 tests 內產生的合成資料攔截注入——
   不是真實統計，只用來驗證圖表行為。 */
const { chromium } = require('/tmp/claude-0/node_modules/playwright');
const fs = require('fs');
const DATA = fs.readFileSync(process.env.RS_FIXTURE || '/tmp/claude-0/rs/synthetic.json', 'utf8');
const D = JSON.parse(DATA);

const fail = [];
const check = (name, cond, extra) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra != null ? '  — ' + extra : ''}`);
  if (!cond) fail.push(name);
};
async function open(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.vp || { width: 1280, height: 900 },
    colorScheme: opts.dark ? 'dark' : 'light', deviceScaleFactor: opts.dpr || 1 });
  await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/data/road_safety_gdp.json*', r => opts.missing
    ? r.fulfill({ status: 404, body: 'not found' })
    : r.fulfill({ contentType: 'application/json', body: DATA }));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:8765/road-safety.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  return { ctx, page, errs };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  console.log('\n— 載入與渲染 —');
  const { ctx, page, errs } = await open(browser);
  check('頁面顯示（非空狀態）', await page.locator('#app').isVisible() && !(await page.locator('#empty').isVisible()));
  const n = D.countries.length;
  const npts = await page.locator('#chart path.pt').count();
  check('每國一個點', npts === n, `${npts} / ${n}`);
  check('台灣有墨色外環', await page.locator('#chart .tw-ring').count() === 1);
  check('台灣有直接標籤', await page.locator('#chart .plabel.tw').count() === 1);
  const qsum = await page.evaluate(() => [...document.querySelectorAll('.qcount')].reduce((s, t) => s + parseInt(t.textContent), 0));
  check('四象限國家數加總＝全部', qsum === n, `${qsum}`);
  const qlabels = await page.evaluate(() => [...document.querySelectorAll('.qlabel')].map(t => t.textContent));
  check('四個象限標籤皆依研究定義', ['① 富裕國家｜低交通死亡率','② 中低收入國家｜低交通死亡率','③ 富裕國家｜高交通死亡率','④ 中低收入國家｜高交通死亡率']
        .every(q => qlabels.includes(q)), qlabels.join(' / '));

  // 象限幾何：① 右上、② 左上、③ 右下、④ 左下
  const geo = await page.evaluate(() => {
    const q = {}; document.querySelectorAll('.qlabel').forEach(t => { q[t.textContent[0]] = { x: +t.getAttribute('x'), y: +t.getAttribute('y') }; });
    return q;
  });
  check('① 在右上、② 在左上', geo['①'].x > geo['②'].x && Math.abs(geo['①'].y - geo['②'].y) < 1);
  check('③ 在右下、④ 在左下', geo['③'].x > geo['④'].x && geo['③'].y > geo['①'].y);

  // 縱軸倒置：死亡率較低的國家應畫在較高的位置（y 較小）
  const inv = await page.evaluate(() => {
    const ys = {}; document.querySelectorAll('#chart path.pt').forEach(p => {
      const m = /M([\d.-]+),([\d.-]+)/.exec(p.getAttribute('d')); ys[p.dataset.iso] = +m[2]; });
    return ys;
  });
  const sorted = D.countries.slice().sort((a, b) => a.rate - b.rate);
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  check('縱軸倒置（低死亡率在上）', inv[lo.iso3] < inv[hi.iso3], `${lo.iso3} ${lo.rate} vs ${hi.iso3} ${hi.rate}`);

  console.log('\n— 01 台灣統計 —');
  const tiles = await page.locator('#tiles .tile').allInnerTexts();
  const tw = D.countries.find(c => c.iso3 === 'TWN');
  check('四張統計卡', tiles.length === 4);
  check('台灣死亡率正確', tiles[0].includes(tw.rate.toFixed(1)), tiles[0].replace(/\n/g, ' '));
  const unverified = D.meta.taiwan && D.meta.taiwan.verified === false;
  check(unverified ? '未核對時標示「待核對」' : '已核對時不標示「待核對」', tiles[0].includes('待核對') === unverified);
  const rich = D.countries.filter(c => c.iso3 !== 'TWN' && c.gdp_pc >= D.meta.gdp_threshold).map(c => c.rate).sort((a, b) => a - b);
  const med = rich.length % 2 ? rich[(rich.length - 1) / 2] : (rich[rich.length / 2 - 1] + rich[rich.length / 2]) / 2;
  check('富裕國家中位數正確', tiles[1].includes(med.toFixed(1)), `預期 ${med.toFixed(1)}`);
  check('倍數正確', tiles[2].includes((tw.rate / med).toFixed(1)), `預期 ${(tw.rate / med).toFixed(1)}`);

  console.log('\n— 門檻拖曳 —');
  const qc = () => page.$$eval('.qcount', t => t.map(x => x.textContent));
  const before = await qc();
  await page.locator('#rateThr').fill('5');
  await page.waitForTimeout(150);
  const after = await qc();
  check('調整死亡率門檻後象限數改變', before.join() !== after.join(), `${before.join(',')} → ${after.join(',')}`);
  check('輸出值同步', (await page.locator('#rateOut').innerText()) === '5.0');
  const q2 = await page.evaluate(() => [...document.querySelectorAll('.qcount')].reduce((s, t) => s + parseInt(t.textContent), 0));
  check('調整後加總仍等於全部', q2 === n);
  await page.click('#thrReset'); await page.waitForTimeout(150);
  check('重設回預設門檻', (await page.locator('#rateOut').innerText()) === D.meta.global_rate.toFixed(1));
  check('重設後象限數還原', (await qc()).join() === before.join());

  console.log('\n— 突顯切換 —');
  const hiCount = async () => page.evaluate(() => document.querySelectorAll('.focus-hit').length);
  const focusN = D.countries.filter(c => c.focus).length;
  check('預設突顯＝焦點國家＋台灣', await hiCount() === focusN, `${await hiCount()} / ${focusN}`);
  await page.click('#chips .chip:has-text("人口密度相近")'); await page.waitForTimeout(150);
  const densN = D.countries.filter(c => c.tags.includes('density')).length + 1;
  check('切到人口密度相近', await hiCount() === densN, `${await hiCount()} / ${densN}`);
  check('非突顯國家淡化', await page.locator('#chart path.pt.bg').count() > 0);
  await page.click('#chips .chip:has-text("不突顯")'); await page.waitForTimeout(150);
  check('不突顯時只剩台灣', await hiCount() === 1);
  await page.click('#chips .chip:has-text("焦點國家")'); await page.waitForTimeout(150);

  console.log('\n— 圖例隱藏大洲 —');
  const europeN = D.countries.filter(c => c.group === 'europe').length;
  await page.click('#legend .lg-item:has-text("歐洲")'); await page.waitForTimeout(150);
  check('隱藏歐洲後點數減少', await page.locator('#chart path.pt').count() === n - europeN);
  check('圖例標為未按下', (await page.locator('#legend .lg-item:has-text("歐洲")').getAttribute('aria-pressed')) === 'false');
  const asiaColor = await page.evaluate(() => getComputedStyle(document.querySelector('#chart path.g-asia')).fill);
  await page.click('#legend .lg-item:has-text("歐洲")'); await page.waitForTimeout(150);
  const asiaColor2 = await page.evaluate(() => getComputedStyle(document.querySelector('#chart path.g-asia')).fill);
  check('篩選前後顏色跟著實體不變', asiaColor === asiaColor2, asiaColor);

  console.log('\n— 提示框 —');
  await page.locator('#chart').scrollIntoViewIfNeeded();
  await page.evaluate(() => document.querySelector('#chart').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(150);
  const twPos = await page.evaluate(() => {
    const svg = document.querySelector('#chart svg'), r = svg.getBoundingClientRect();
    const k = r.width / +svg.getAttribute('viewBox').split(' ')[2];
    const ring = document.querySelector('#chart svg[role=img] .tw-ring');
    return { x: r.left + +ring.getAttribute('cx') * k, y: r.top + +ring.getAttribute('cy') * k };
  });
  await page.mouse.move(twPos.x + 9, twPos.y + 9);            // 不必精準點中
  await page.waitForTimeout(150);
  const tip = await page.locator('#tip').innerText();
  check('滑近台灣即顯示提示框', await page.locator('#tip').isVisible() && tip.includes('台灣'), tip.split('\n').slice(0, 3).join(' | '));
  check('提示框以數值開頭', tip.trim().startsWith(tw.rate.toFixed(1)));
  check('提示框標示台灣資料來源', tip.includes('交通部 30 日死亡'));
  check('被指到的點有反應', await page.locator('#chart path.pt.hot').count() === 1);
  await page.mouse.move(5, 5); await page.waitForTimeout(100);
  check('移開後提示框消失', !(await page.locator('#tip').isVisible()));

  await page.locator('.focus-hit').first().focus(); await page.waitForTimeout(100);
  check('鍵盤聚焦也顯示提示框', await page.locator('#tip').isVisible());

  console.log('\n— 比較表 —');
  const rows = await page.locator('#table tbody tr').count();
  check('預設列出台灣＋突顯國家', rows === focusN, `${rows}`);
  check('台灣列有標示', await page.locator('#table tr.tw').count() === 1);
  const firstRates = await page.$$eval('#table tbody tr td:nth-child(3)', t => t.map(x => parseFloat(x.textContent)));
  check('預設依死亡率由低到高', firstRates.every((v, i) => i === 0 || firstRates[i - 1] <= v));
  await page.click('#table th:nth-child(3) button'); await page.waitForTimeout(100);
  const rev = await page.$$eval('#table tbody tr td:nth-child(3)', t => t.map(x => parseFloat(x.textContent)));
  check('點表頭可反向排序', rev.every((v, i) => i === 0 || rev[i - 1] >= v));
  check('aria-sort 正確', (await page.locator('#table th:nth-child(3)').getAttribute('aria-sort')) === 'descending');
  await page.check('#showAll'); await page.waitForTimeout(100);
  check('顯示全部國家', await page.locator('#table tbody tr').count() === n);
  check('主流程無 JS 錯誤', errs.length === 0, errs.join(' | '));
  await page.screenshot({ path: '/tmp/claude-0/rs/desktop.png', fullPage: true });
  await ctx.close();

  console.log('\n— 資料缺失時 —');
  const e = await open(browser, { missing: true });
  check('顯示「資料尚未建置」', await e.page.locator('#empty').isVisible());
  check('圖表區不顯示', !(await e.page.locator('#app').isVisible()));
  check('無 JS 錯誤', e.errs.length === 0, e.errs.join(' | '));
  await e.ctx.close();

  console.log('\n— 手機版 —');
  for (const w of [320, 390]) {
    const mb = await open(browser, { vp: { width: w, height: 844 }, dpr: 2 });
    const r = await mb.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    check(`${w}px 無水平溢出`, r.sw <= r.cw, `${r.sw}/${r.cw}`);
    const labs = await mb.page.locator('#chart .plabel').count();
    check(`${w}px 標籤有節制（≤10）`, labs <= 10, `${labs}`);
    const overlap = await mb.page.evaluate(() => {
      const b = [...document.querySelectorAll('#chart .plabel, #chart .qlabel, #chart .qcount')].map(t => t.getBBox());
      for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
        const A = b[i], B = b[j];
        if (A.x < B.x + B.width - 1 && A.x + A.width - 1 > B.x && A.y < B.y + B.height - 1 && A.y + A.height - 1 > B.y) return true;
      }
      return false;
    });
    check(`${w}px 標籤互不重疊`, !overlap);
    if (w === 390) await mb.page.screenshot({ path: '/tmp/claude-0/rs/mobile.png', fullPage: true });
    check(`${w}px 無 JS 錯誤`, mb.errs.length === 0, mb.errs.join(' | '));
    await mb.ctx.close();
  }

  console.log('\n— 桌機標籤不重疊 —');
  const dk = await open(browser);
  const ov = await dk.page.evaluate(() => {
    const b = [...document.querySelectorAll('#chart .plabel, #chart .qlabel, #chart .qcount')].map(t => t.getBBox());
    let c = 0; for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
      const A = b[i], B = b[j];
      if (A.x < B.x + B.width - 1 && A.x + A.width - 1 > B.x && A.y < B.y + B.height - 1 && A.y + A.height - 1 > B.y) c++;
    } return c;
  });
  check('桌機標籤互不重疊', ov === 0, `${ov} 組重疊`);
  await dk.ctx.close();

  console.log('\n— 暗色模式 —');
  const dm = await open(browser, { dark: true });
  const bg = await dm.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const asiaDark = await dm.page.evaluate(() => getComputedStyle(document.querySelector('#chart path.g-asia')).fill);
  check('暗色背景生效', bg === 'rgb(13, 13, 13)', bg);
  check('暗色使用暗色版分類色', asiaDark === 'rgb(57, 135, 229)', asiaDark);
  await dm.page.screenshot({ path: '/tmp/claude-0/rs/dark.png', fullPage: false });
  check('暗色無 JS 錯誤', dm.errs.length === 0);
  await dm.ctx.close();

  console.log('\n— 主頁入口（資料存在才顯示）—');
  const LJ = fs.readFileSync('/tmp/claude-0/vendor/dist/leaflet.js', 'utf8');
  const LC = fs.readFileSync('/tmp/claude-0/vendor/dist/leaflet.css', 'utf8');
  for (const present of [true, false]) {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await c.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.js', r => r.fulfill({ contentType: 'application/javascript', body: LJ }));
    await c.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.css', r => r.fulfill({ contentType: 'text/css', body: LC }));
    await c.route('**://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await c.route('**://*.basemaps.cartocdn.com/**', r => r.abort());
    await c.route('**://wmts.nlsc.gov.tw/**', r => r.abort());
    await c.route('**://tile.openstreetmap.org/**', r => r.abort());
    await c.route('**://maps.googleapis.com/**', r => r.abort());
    await c.route('**://*.supabase.co/**', r => r.abort());
    await c.route('**/data/road_safety_gdp.json*', r => present
      ? r.fulfill({ contentType: 'application/json', body: DATA })
      : r.fulfill({ status: 404, body: '' }));
    const pg = await c.newPage();
    await pg.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(900);
    const vis = await pg.locator('#rsLink').isVisible();
    check(present ? '資料存在 → 顯示入口' : '資料不存在 → 隱藏入口', vis === present);
    if (present) check('入口指向 road-safety.html', (await pg.locator('#rsLink').getAttribute('href')) === 'road-safety.html');
    await c.close();
  }

  await browser.close();
  console.log(`\n${fail.length ? '✗ ' + fail.length + ' 項失敗:\n   - ' + fail.join('\n   - ') : '✓ 全部通過'}`);
  process.exit(fail.length ? 1 : 0);
})();
