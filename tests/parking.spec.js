/* parking-space.html 端對端測試。使用 data/taipei_parking_space.json（真實資料），
   檢查頁面數字與資料檔一致，以及圖表、tooltip、語言、主題與手機版。 */
const { chromium } = require('/tmp/claude-0/node_modules/playwright');
const fs = require('fs');
const DATA = fs.readFileSync('data/taipei_parking_space.json', 'utf8');
const D = JSON.parse(DATA);
const URL = 'http://127.0.0.1:8765/parking-space.html';

const fail = [];
const check = (name, cond, extra) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra != null ? '  — ' + extra : ''}`);
  if (!cond) fail.push(name);
};
async function open(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.vp || { width: 1280, height: 900 }, colorScheme: opts.dark ? 'dark' : 'light' });
  if (opts.lang) await ctx.addInitScript(l => { try { localStorage.setItem('lang', l); } catch (e) {} }, opts.lang);
  await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/data/taipei_parking_space.json*', r => opts.missing
    ? r.fulfill({ status: 404, body: 'not found' })
    : r.fulfill({ contentType: 'application/json', body: DATA }));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  return { ctx, page, errs };
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const M = D.meta.totals, NDIST = D.districts.length;
  const park = M.slot_m2.car + M.slot_m2.moto + M.slot_m2.zone;

  console.log('— 中文、白底 —');
  {
    const { ctx, page, errs } = await open(browser);
    check('12個行政區', NDIST === 12);
    check('資料檔：各區加總等於全市', D.districts.reduce((s, r) => s + r.slots.car, 0) === M.slots.car
      && D.districts.reduce((s, r) => s + r.slot_m2.moto, 0) === M.slot_m2.moto);
    check('資料檔：汽車格平均面積合理（8–13 m²）', M.slot_m2.car / M.slots.car > 8 && M.slot_m2.car / M.slots.car < 13);
    check('資料檔：機車格平均面積合理（1–2.5 m²）', M.slot_m2.moto / M.slots.moto > 1 && M.slot_m2.moto / M.slots.moto < 2.5);
    check('資料檔：道路內停車格不大於全部停車格', ['car', 'moto', 'zone'].every(k => M.slot_m2_in8m[k] <= M.slot_m2[k]));
    const tv = await page.$$eval('#tiles .value', a => a.map(e => e.firstChild.textContent));
    check('磚1：總面積（公頃）', tv[0] === (park / 1e4).toFixed(1), tv[0]);
    check('磚2：汽車格面積占比', tv[1] === Math.round(100 * M.slot_m2.car / park) + '%', tv[1]);
    check('磚3：人行道占8m以上道路', tv[2] === (100 * M.road8m.sidewalk / M.road8m.area).toFixed(1) + '%', tv[2]);
    const lead = await page.locator('#lead').textContent();
    check('結論段落含格數', lead.includes(M.slots.car.toLocaleString('en-US')) && lead.includes(M.slots.moto.toLocaleString('en-US')));
    check('圖1：全市＋12區＝13列', (await page.locator('#chart1 .row-hit').count()) === NDIST + 1);
    check('圖1：第一列是全市', (await page.locator('#chart1 .row-label').first().textContent()) === '全市');
    const w = await page.$$eval('#chart1 svg', s => {
      const ys = {}; s[0].querySelectorAll('.seg-rect').forEach(r => { const y = r.getAttribute('y'); ys[y] = (ys[y] || 0) + +r.getAttribute('width'); });
      return Object.values(ys);
    });
    check('圖1：每列堆疊到100%（寬度一致）', Math.max(...w) - Math.min(...w) < 1, w.map(v => v.toFixed(0)).join(','));
    const ha = await page.$$eval('#chart2 .row-val', a => a.map(e => parseFloat(e.textContent)));
    check('圖2：12區且由大到小', ha.length === NDIST && ha.every((v, i) => !i || v <= ha[i - 1]), ha.join(','));
    const top = D.districts.slice().sort((a, b) => (b.slot_m2.car + b.slot_m2.moto + b.slot_m2.zone) - (a.slot_m2.car + a.slot_m2.moto + a.slot_m2.zone))[0];
    check('圖2：第一名與資料一致', (await page.locator('#chart2 .row-label').first().textContent()) === top.district, top.district);
    await page.locator('#chart2').scrollIntoViewIfNeeded();
    const box = await page.locator('#chart2 .row-hit').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(80);
    const tip = await page.locator('#chart2 .tip').textContent();
    check('圖2 tooltip：格數與收費格', tip.includes(top.slots.car.toLocaleString('en-US')) && tip.includes(top.charged.car.toLocaleString('en-US')), tip.slice(0, 40));
    check('表格：全市＋12區', (await page.locator('#dtable tbody tr').count()) === NDIST + 1);
    check('看不見的部分：路外停車場數', (await page.locator('#unseen .tile .value').first().textContent()).startsWith(M.offstreet.lots.toLocaleString('en-US')));
    check('方法說明列出未說明代碼', (await page.locator('#notes').textContent()).includes(Object.keys(D.meta.other_codes)[0]));
    check('沒有 JS 錯誤', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log('\n— 英文與深色 —');
  {
    const { ctx, page, errs } = await open(browser, { lang: 'en', dark: true });
    check('英文標題', (await page.locator('h1').textContent()).startsWith('Taipei street space'));
    check('英文行政區名', (await page.locator('#chart1 .row-label').first().textContent()) === 'Taipei');
    check('英文 tooltip 不用全形括號', await (async () => {
      await page.locator('#chart1').scrollIntoViewIfNeeded();
      const b = await page.locator('#chart1 .row-hit').first().boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(80);
      const s = await page.locator('#chart1 .tip').textContent(); return s.includes('(') && !s.includes('（');
    })());
    check('深色背景', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(13, 13, 13)');
    await page.locator('#langSeg button[data-lang="zh"]').click();
    check('切回中文即時更新', (await page.locator('#chart1 .row-label').first().textContent()) === '全市');
    check('沒有 JS 錯誤', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log('\n— 手機 —');
  for (const [w, lang] of [[320, 'zh'], [390, 'en']]) {
    const { ctx, page, errs } = await open(browser, { vp: { width: w, height: 800 }, lang });
    const r = await page.evaluate(() => ({
      ovf: document.documentElement.scrollWidth - innerWidth,
      out: [...document.querySelectorAll('.chart svg text')].filter(t => { const b = t.getBoundingClientRect(); return b.right > innerWidth + 1 || b.left < -1; }).length,
    }));
    check(`${w}px ${lang}：無水平捲動、文字不出界`, r.ovf <= 0 && r.out === 0 && errs.length === 0, `ovf ${r.ovf} out ${r.out}`);
    await ctx.close();
  }

  console.log('\n— 返回連結 —');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    check('直接開啟：返回打造夢想街道', (await page.locator('header a.back').getAttribute('href')) === './'
      && (await page.locator('header a.back').textContent()).includes('打造夢想街道'));
    await page.goto(URL + '?from=atlas', { waitUntil: 'domcontentloaded' });
    check('從 atlas 進入：返回全國交通安全地圖', (await page.locator('header a.back').getAttribute('href')) === '/taiwan-mobility-atlas/'
      && (await page.locator('footer a').textContent()).includes('全國交通安全地圖'));
    await page.locator('#langSeg button[data-lang="en"]').click();
    check('切換英文後仍回 atlas', (await page.locator('header a.back').textContent()).includes('Taiwan Mobility Atlas'));
    await ctx.close();
  }

  console.log('\n— 資料缺失 —');
  {
    const { ctx, page } = await open(browser, { missing: true });
    check('沒有資料時顯示建置說明', await page.locator('#empty').isVisible() && !(await page.locator('#app').isVisible()));
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${fail.length ? '✗ ' + fail.length + ' 項失敗:\n   - ' + fail.join('\n   - ') : '✓ 全部通過'}`);
  process.exit(fail.length ? 1 : 0);
})();
