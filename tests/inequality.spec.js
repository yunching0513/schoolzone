/* road-safety-inequality.html 端對端測試。使用 data/road_safety_inequality.json（真實資料），
   檢查數字是否與資料檔一致，以及圖表、篩選、表格、語言與主題的行為。 */
const { chromium } = require('/tmp/claude-0/node_modules/playwright');
const fs = require('fs');
const DATA = fs.readFileSync(process.env.INEQ_FIXTURE || 'data/road_safety_inequality.json', 'utf8');
const D = JSON.parse(DATA);
const TWDATA = fs.readFileSync('data/road_safety_inequality_tw.json', 'utf8');
const TW = JSON.parse(TWDATA);
const URL = 'http://127.0.0.1:8765/road-safety-inequality.html';
const REGION_OF = {
  臺北市: 'north', 新北市: 'north', 基隆市: 'north', 桃園市: 'north', 新竹市: 'north', 新竹縣: 'north', 宜蘭縣: 'north',
  苗栗縣: 'central', 臺中市: 'central', 彰化縣: 'central', 南投縣: 'central', 雲林縣: 'central',
  嘉義市: 'south', 嘉義縣: 'south', 臺南市: 'south', 高雄市: 'south', 屏東縣: 'south',
  花蓮縣: 'east', 臺東縣: 'east', 澎湖縣: 'island', 金門縣: 'island', 連江縣: 'island',
};
const REGION_ZH = { north: '北部', central: '中部', south: '南部', east: '東部', island: '離島' };

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
  await ctx.route('**/data/road_safety_inequality_tw.json*', r => opts.twMissing
    ? r.fulfill({ status: 404, body: 'not found' })
    : r.fulfill({ contentType: 'application/json', body: TWDATA }));
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
  await page.locator('#chart1 .tw-ring').scrollIntoViewIfNeeded();            // 先捲到圖表，滑鼠才點得到
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

  console.log('\n— 臺灣內部 —');
  const tm = TW.meta, NC = TW.counties.length;
  check('第03節顯示', await page.locator('#twSec').isVisible());
  for (const id of ['twc1', 'twc2', 'twc3']) {
    const L = await page.$$eval(`#${id} .plabel`, a => a.map(e => e.textContent));
    check(`${id}：22個點，臺東縣與臺北市有標籤`, (await page.locator(`#${id} .pt`).count()) === NC && L.includes('臺東縣') && L.includes('臺北市'), L.length + ' 個標籤');
  }
  const twt = await page.$$eval('#twTiles .value', a => a.map(e => e.firstChild.textContent));
  const R = v => (v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
  check('磚：縣市吉尼相關', twt[0] === R(tm.county_corr.gini_est.spearman), twt[0]);
  check('磚：縣市中位數相關', twt[1] === R(tm.county_corr.median_est.spearman), twt[1]);
  check('磚：鄉鎮 Q3/Q1 效果', twt[2] === '−' + Math.abs(tm.models.T3.effects.iqr.pct).toFixed(1) + '%', twt[2]);
  const ciCross = ci => ci[0] <= 0 && ci[1] >= 0;
  check('不顯著標記與區間一致（吉尼／中位數／Q3Q1／密度）',
    (await page.locator('#twTiles .tile:nth-child(1) .badge').count()) === +ciCross(tm.county_corr.gini_est.ci)
    && (await page.locator('#twTiles .tile:nth-child(2) .badge').count()) === +ciCross(tm.county_corr.median_est.ci)
    && (await page.locator('#twTiles .tile:nth-child(3) .badge').count()) === +ciCross(tm.models.T3.effects.iqr.pct_ci)
    && (await page.locator('#twTiles .tile:nth-child(4) .badge').count()) === +ciCross(tm.models.T3.effects.density.pct_ci));
  const tpos = await page.evaluate(() => {
    const svg = document.querySelector('#twc2 svg');
    const ticks = [...svg.querySelectorAll('.tick text')].filter(t => t.getAttribute('text-anchor') === 'end');
    const yOf = v => +ticks.find(t => t.textContent === String(v)).getAttribute('y') - 4;
    const ys = [...svg.querySelectorAll('.pt')].map(p => p.getBBox()).map(b => b.y + b.height / 2);
    return { y0: yOf(0), y30: yOf(30), top: Math.min(...ys) };
  });
  const maxRate = Math.max(...TW.counties.map(c => c.rate));
  const expTop = tpos.y0 + (tpos.y30 - tpos.y0) * maxRate / 30;
  check('縣市圖：最高死亡率的縱軸位置正確（線性軸）', Math.abs(tpos.top - expTop) < 1.5, `${tpos.top.toFixed(1)} vs ${expTop.toFixed(1)}`);
  const tt = await page.locator('#twc1 .tw-ring').count();
  check('縣市圖沒有臺灣圈（只有國際圖有）', tt === 0);
  const taitung = TW.counties.find(c => c.county === '臺東縣');
  await page.locator('#twc1').scrollIntoViewIfNeeded();
  const pts = await page.locator('#twc1 .pt').all();
  let hitTip = '';
  for (const p of pts) {
    const b = await p.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(30);
    const s = await page.locator('#twc1 .tip').textContent(); if (s.includes('臺東縣')) { hitTip = s; break; }
  }
  check('滑過臺東縣顯示縣市 tooltip（含區域）', hitTip.includes(taitung.rate.toFixed(1)) && hitTip.includes('Taitung County') && hitTip.includes('東部'), hitTip.slice(0, 30));

  // 區域：五組顏色＋形狀，圖例可隱藏，三張圖同步
  const lg = await page.$$eval('#twLegend .lg-item', a => a.map(b => [b.dataset.group, +b.querySelector('.n').textContent]));
  const want = Object.entries(TW.counties.reduce((m, c) => (m[REGION_OF[c.county]] = (m[REGION_OF[c.county]] || 0) + 1, m), {}));
  check('區域圖例：北中南東離島五組，數量正確', JSON.stringify(lg) === JSON.stringify(['north', 'central', 'south', 'east', 'island'].map(k => [k, Object.fromEntries(want)[k]])), JSON.stringify(lg));
  check('每個縣市都有區域', TW.counties.every(c => REGION_OF[c.county]));
  const cls = await page.$$eval('#twc1 .pt', a => [...new Set(a.map(p => [...p.classList].find(c => c.startsWith('g-'))))].sort());
  check('點依區域上色', JSON.stringify(cls) === JSON.stringify(['g-central', 'g-east', 'g-island', 'g-north', 'g-south']), cls.join(','));
  const fills = await page.evaluate(() => ['north', 'central', 'south', 'east', 'island'].map(k => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', 'path'); e.setAttribute('class', 'g-' + k);
    document.querySelector('#twc1 svg').appendChild(e); const f = getComputedStyle(e).fill; e.remove(); return f; }));
  check('五個區域顏色都不同', new Set(fills).size === 5, fills.join(' '));
  await page.locator('#twLegend .lg-item[data-group="east"]').click();
  const nEast = TW.counties.filter(c => REGION_OF[c.county] === 'east').length;
  const counts = await Promise.all(['twc1', 'twc2', 'twc3'].map(id => page.locator(`#${id} .pt`).count()));
  check('隱藏東部：三張圖同步少掉東部縣市', counts.every(n => n === NC - nEast), counts.join(','));
  check('區域圖例按鈕保留焦點且標為未按下', await page.evaluate(() => document.activeElement.dataset.group === 'east'
    && document.activeElement.getAttribute('aria-pressed') === 'false'));
  await page.locator('#twLegend .lg-item[data-group="east"]').click();
  check('再按一次恢復', (await page.locator('#twc1 .pt').count()) === NC);
  check('鄉鎮模型表 4 列', (await page.locator('#twMtable tbody tr').count()) === 4);
  const t3 = await page.$$eval('#twMtable tbody tr:nth-child(3) td', a => a.map(e => e.textContent));
  check('T3：所得差距不顯著、密度顯著', t3[3].includes('不顯著') === ciCross(tm.models.T3.effects.iqr.pct_ci)
    && t3[5].includes('不顯著') === ciCross(tm.models.T3.effects.density.pct_ci), t3.slice(3).join(' / '));
  check('T1 沒有中位數／密度欄位值', t3.length === 6 && (await page.locator('#twMtable tbody tr:nth-child(1) td:nth-child(5)').textContent()) === '—');
  check('縣市表 22 列', (await page.locator('#twCtable tbody tr').count()) === NC);
  const topC = TW.counties.slice().sort((a, b) => b.rate - a.rate)[0].county;
  check('縣市表預設依死亡率由高到低', (await page.locator('#twCtable tbody tr:first-child td:first-child').textContent()) === topC, topC);
  check('縣市表列出區域', (await page.locator('#twCtable tbody tr:first-child td:nth-child(2)').textContent()) === REGION_ZH[REGION_OF[topC]]);
  await page.locator('#twCtable th:nth-child(4) button').click();
  const gTop = parseFloat(await page.locator('#twCtable tbody tr:first-child td:nth-child(4)').textContent());
  check('縣市表依吉尼排序', Math.abs(gTop - Math.max(...TW.counties.map(c => c.gini_est))) < 0.001, gTop);
  check('方法說明含臺灣內部資料', (await page.locator('#notes').textContent()).includes('財政部財政資訊中心'));
  check('沒有 JS 錯誤', errs.length === 0, errs.join(' | '));
  await ctx.close();

  console.log('\n— 英文與深色 —');
  {
    const { ctx, page, errs } = await open(browser, { lang: 'en', dark: true });
    check('英文標題', (await page.locator('h1').textContent()).startsWith('Road safety × income inequality'));
    const L = await labels(page, 1);
    check('英文標籤', L.includes('Taiwan') && L.includes('United States'));
    check('英文段落', (await page.locator('#lead').textContent()).includes('Saudi Arabia'));
    const twL = await page.$$eval('.sm .plabel', a => a.map(e => e.textContent));
    check('英文縣市名：新竹／嘉義保留 City／County', !twL.includes('Hsinchu') && !twL.includes('Chiayi') && twL.includes('Taitung'), twL.slice(0, 8).join(', '));
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

  {
    const { ctx, page, errs } = await open(browser, { twMissing: true });
    check('臺灣資料缺少：第03節與相關表格隱藏，國際部分照常', !(await page.locator('#twSec').isVisible())
      && !(await page.locator('#twMtable').isVisible()) && (await page.locator('#chart1 .pt').count()) === N
      && !(await page.locator('#empty').isVisible()) && errs.length === 0);
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
