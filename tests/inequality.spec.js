/* road-safety-inequality.html 端對端測試。使用 data/road_safety_inequality.json（真實資料），
   檢查數字是否與資料檔一致，以及圖表、篩選、表格、語言與主題的行為。 */
const { chromium } = require('/tmp/claude-0/node_modules/playwright');
const fs = require('fs');
const DATA = fs.readFileSync(process.env.INEQ_FIXTURE || 'data/road_safety_inequality.json', 'utf8');
const D = JSON.parse(DATA);
const URL = 'http://127.0.0.1:8765/road-safety-inequality.html';

const fail = [];
const check = (name, cond, extra) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra != null ? '  — ' + extra : ''}`);
  if (!cond) fail.push(name);
};
async function open(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.vp || { width: 1280, height: 900 }, colorScheme: opts.dark ? 'dark' : 'light' });
  if (opts.lang) await ctx.addInitScript(l => { try { localStorage.setItem('lang', l); } catch (e) {} }, opts.lang);
  await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/data/road_safety_inequality.json*', r => opts.missing
    ? r.fulfill({ status: 404, body: 'not found' })
    : r.fulfill({ contentType: 'application/json', body: DATA }));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  return { ctx, page, errs };
}
const labels = (page, n) => page.$$eval(`#chart${n} .plabel`, a => a.map(e => e.textContent));

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const N = D.countries.length, NH = D.countries.filter(c => c.hic).length, M = D.meta;

  console.log('\n— 載入與數字 —');
  const { ctx, page, errs } = await open(browser);
  check('頁面顯示（非空狀態）', await page.locator('#app').isVisible() && !(await page.locator('#empty').isVisible()));
  check('圖一點數＝國家數', (await page.locator('#chart1 .pt').count()) === N, N);
  check('圖二點數＝國家數', (await page.locator('#chart2 .pt').count()) === N);
  const tiles = await page.$$eval('#tiles .value', a => a.map(e => e.firstChild.textContent));
  check('磚1＝Spearman', tiles[0] === M.corr_all.spearman.toFixed(2), tiles[0]);
  check('磚2＝M1效果', tiles[1] === '+' + M.models.M1.gini_pct.toFixed(1) + '%', tiles[1]);
  check('磚3＝M2效果', tiles[2] === '+' + M.models.M2.gini_pct.toFixed(1) + '%', tiles[2]);
  check('磚3：區間跨0時標示不顯著', (await page.locator('#tiles .tile:nth-child(3) .badge').count()) === 1);
  check('磚4＝臺灣實際÷預期', tiles[3] === M.taiwan.ratio.toFixed(1), tiles[3]);
  const lead = await page.locator('#lead').textContent();
  check('結論段落列出排在臺灣前面的國家', ['美國', '沙烏地阿拉伯', '哥斯大黎加'].every(s => lead.includes(s)));
  check('中文版用「臺灣」', (await labels(page, 1)).includes('臺灣') && !(await labels(page, 1)).includes('台灣'));

  console.log('\n— 座標正確性 —');
  const pos = await page.evaluate(() => {
    const svg = document.querySelector('#chart1 svg');
    const ticks = [...svg.querySelectorAll('.tick text')].filter(t => t.getAttribute('text-anchor') === 'end');
    const yOf = v => +ticks.find(t => t.textContent === String(v)).getAttribute('y') - 4;
    const ring = svg.querySelector('.tw-ring');
    return { y10: yOf(10), y20: yOf(20), ty: +ring.getAttribute('cy') };
  });
  const tw = D.countries.find(c => c.iso3 === 'TWN');
  const expectY = pos.y10 + (pos.y20 - pos.y10) * Math.log(tw.rate / 10) / Math.log(2);
  check('臺灣的 y 位置符合對數尺度', Math.abs(pos.ty - expectY) < 1, `${pos.ty.toFixed(1)} vs ${expectY.toFixed(1)}`);

  console.log('\n— 標籤 —');
  for (const n of [1, 2]) {
    const L = await labels(page, n);
    check(`圖${n}：臺灣、美國都有標籤`, L.includes('臺灣') && L.includes('美國'), L.length + ' 個');
  }
  const coll = await page.evaluate(() => {
    let bad = 0;
    for (const id of ['chart1', 'chart2']) {
      const b = [...document.querySelectorAll(`#${id} .plabel`)].map(e => e.getBBox());
      for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
        const p = b[i], q = b[j];
        if (p.x < q.x + q.width && p.x + p.width > q.x && p.y < q.y + q.height && p.y + p.height > q.y) bad++;
      }
    }
    return bad;
  });
  check('標籤彼此不重疊', coll === 0, coll);

  console.log('\n— 互動 —');
  await page.locator('#viewSeg [data-view=hic]').click();
  check('只看高所得：點數＝高所得國家數', (await page.locator('#chart1 .pt').count()) === NH, NH);
  check('只看高所得：按鈕狀態', (await page.locator('#viewSeg [data-view=hic]').getAttribute('aria-pressed')) === 'true');
  await page.locator('#viewSeg [data-view=all]').click();
  const nEu = D.countries.filter(c => c.group === 'europe').length;
  await page.locator('#legend1 .lg-item').nth(1).click();
  check('圖例隱藏歐洲：兩張圖同步減少', (await page.locator('#chart1 .pt').count()) === N - nEu && (await page.locator('#chart2 .pt').count()) === N - nEu);
  check('圖例按鈕保留焦點', await page.evaluate(() => document.activeElement.classList.contains('lg-item')));
  await page.locator('#legend1 .lg-item').nth(1).click();
  const ring = await page.locator('#chart1 .tw-ring').boundingBox();
  await page.mouse.move(ring.x + ring.width / 2, ring.y + ring.height / 2);
  await page.waitForTimeout(100);
  const tip = await page.locator('#chart1 .tip').textContent();
  check('滑過臺灣顯示 tooltip', tip.includes('臺灣') && tip.includes(tw.gini.toFixed(1)) && tip.includes('交通部'), tip.slice(0, 40));
  await page.mouse.move(5, 5);
  check('離開後 tooltip 收起', !(await page.locator('#chart1 .tip').isVisible()));

  console.log('\n— 表格 —');
  check('模型表 4 列', (await page.locator('#mtable tbody tr').count()) === 4);
  check('模型表：M2 標示不顯著、M1 沒有', (await page.locator('#mtable tbody tr:nth-child(3) .sig').count()) === 1
    && (await page.locator('#mtable tbody tr:nth-child(2) .sig').count()) === 0);
  check('各國表列數', (await page.locator('#ctable tbody tr').count()) === N);
  const top = D.countries.slice().sort((a, b) => b.ratio - a.ratio)[0];
  check('預設依實際÷預期由高到低', (await page.locator('#ctable tbody tr:first-child td:first-child').textContent()) === top.zh, top.zh);
  check('臺灣列醒目標示', (await page.locator('#ctable tr.tw').count()) === 1);
  await page.locator('#ctable th:nth-child(3) button').click();
  const g1 = parseFloat(await page.locator('#ctable tbody tr:first-child td:nth-child(3)').textContent());
  check('點吉尼係數排序（由高到低）', g1 === Math.max(...D.countries.map(c => c.gini)), g1);
  check('排序後焦點留在標題', await page.evaluate(() => document.activeElement.closest('th') !== null));
  check('沒有 JS 錯誤', errs.length === 0, errs.join(' | '));
  await ctx.close();

  console.log('\n— 英文與深色 —');
  {
    const { ctx, page, errs } = await open(browser, { lang: 'en', dark: true });
    check('英文標題', (await page.locator('h1').textContent()).startsWith('Road safety × income inequality'));
    const L = await labels(page, 1);
    check('英文標籤', L.includes('Taiwan') && L.includes('United States'));
    check('英文段落', (await page.locator('#lead').textContent()).includes('Saudi Arabia'));
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('深色主題背景', bg === 'rgb(13, 13, 13)', bg);
    await page.locator('#themeSeg [data-theme-opt=light]').click();
    check('切白底', await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(255, 255, 255)');
    await page.locator('#langSeg [data-lang=zh]').click();
    check('切回中文即時更新', (await page.locator('#tiles .label').first().textContent()) === '粗看的關聯');
    check('英文／深色沒有 JS 錯誤', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log('\n— 手機 —');
  for (const w of [320, 390]) {
    for (const lang of ['zh', 'en']) {
      const { ctx, page, errs } = await open(browser, { vp: { width: w, height: 800 }, lang });
      const ovf = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      const name = lang === 'en' ? 'Taiwan' : '臺灣';
      const ok = (await labels(page, 1)).includes(name) && (await labels(page, 2)).includes(name);
      const svgOut = await page.evaluate(() => [...document.querySelectorAll('.chart svg text')].some(t => {
        const r = t.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }));
      check(`${w}px ${lang}：無水平捲動、臺灣有標籤、文字不出界`, ovf <= 0 && ok && !svgOut && !errs.length, `ovf ${ovf}`);
      await ctx.close();
    }
  }

  console.log('\n— 資料缺失 —');
  {
    const { ctx, page } = await open(browser, { missing: true });
    check('沒有資料時顯示建置說明', await page.locator('#empty').isVisible() && (await page.locator('#empty').textContent()).includes('build_inequality.py'));
    await ctx.close();
  }

  console.log('\n— 從國際比較頁進入 —');
  {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await c.route('**://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    const p = await c.newPage();
    await p.goto('http://127.0.0.1:8765/road-safety.html', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    const link = p.locator('a.more[href="road-safety-inequality.html"]');
    check('國際比較頁有延伸分析入口', await link.isVisible());
    await link.click(); await p.waitForURL(/road-safety-inequality/);
    await p.waitForSelector('#chart1 .pt');
    check('點入口進到本頁', (await p.title()).includes('所得分配'));
    await p.locator('header a.back').click(); await p.waitForURL(/road-safety\.html/);
    check('返回連結回到國際比較頁', true);
    await c.close();
  }

  await browser.close();
  console.log(`\n${fail.length ? '✗ ' + fail.length + ' 項失敗:\n   - ' + fail.join('\n   - ') : '✓ 全部通過'}`);
  process.exit(fail.length ? 1 : 0);
})();
