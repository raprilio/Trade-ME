/* Trade-ME — antarmuka. Data publik (tanpa API key), semua perhitungan di browser. */
(function () {
  'use strict';
  const A = window.Analysis;

  /* ───────────────────────────── Konfigurasi ───────────────────────────── */
  const COINS = ['SOL', 'BTC', 'ETH', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TON'];
  const MORE_COINS = ['DOT', 'POL', 'LTC', 'NEAR', 'SUI', 'APT', 'ARB', 'OP', 'PEPE', 'SHIB', 'TRX', 'ATOM', 'INJ', 'JUP', 'WIF', 'RENDER'];
  const TFS = {
    '15m': { bin: '15m', okx: '15m', htf: '1h' },
    '1h': { bin: '1h', okx: '1H', htf: '4h' },
    '4h': { bin: '4h', okx: '4H', htf: '1d' },
    '1d': { bin: '1d', okx: '1Dutc', htf: '1w' },
    '1w': { bin: '1w', okx: '1Wutc' },
  };
  const TF_NAME = { '15m': '15 menit', '1h': '1 jam', '4h': '4 jam', '1d': '1 hari', '1w': '1 minggu' };
  const REFRESH_MS = 60000;
  const LIMIT_MAIN = 1000;
  const LIMIT_HTF = 400;

  const store = {
    get(k, d) { try { const v = localStorage.getItem('trademe.' + k); return v === null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('trademe.' + k, v); } catch (_) { /* abaikan */ } },
  };

  const state = {
    base: (store.get('base', 'SOL') || 'SOL').replace(/[^A-Z0-9]/gi, '').toUpperCase() || 'SOL',
    tf: TFS[store.get('tf', '1h')] ? store.get('tf', '1h') : '1h',
    capital: parseFloat(store.get('capital', '1000')) || 1000,
    riskPct: parseFloat(store.get('risk', '1')) || 1,
    result: null,
    loadId: 0,
  };

  /* ──────────────────────────── Pengambilan data ───────────────────────── */
  const SOURCES = [
    {
      name: 'Binance',
      klines: (b, tf, n) => `https://data-api.binance.vision/api/v3/klines?symbol=${b}USDT&interval=${TFS[tf].bin}&limit=${Math.min(n, 1000)}`,
      ticker: (b) => `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${b}USDT`,
      parseKlines: (rows) => rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], closed: r[6] < Date.now() })),
      parseTicker: (j) => ({ last: +j.lastPrice, changePct: +j.priceChangePercent, high: +j.highPrice, low: +j.lowPrice, quoteVol: +j.quoteVolume }),
    },
    {
      name: 'Binance (api)',
      klines: (b, tf, n) => `https://api.binance.com/api/v3/klines?symbol=${b}USDT&interval=${TFS[tf].bin}&limit=${Math.min(n, 1000)}`,
      ticker: (b) => `https://api.binance.com/api/v3/ticker/24hr?symbol=${b}USDT`,
      parseKlines: (rows) => rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], closed: r[6] < Date.now() })),
      parseTicker: (j) => ({ last: +j.lastPrice, changePct: +j.priceChangePercent, high: +j.highPrice, low: +j.lowPrice, quoteVol: +j.quoteVolume }),
    },
    {
      name: 'OKX',
      klines: (b, tf, n) => `https://www.okx.com/api/v5/market/candles?instId=${b}-USDT&bar=${TFS[tf].okx}&limit=${Math.min(n, 300)}`,
      ticker: (b) => `https://www.okx.com/api/v5/market/ticker?instId=${b}-USDT`,
      parseKlines: (j) => {
        if (j.code !== '0' || !Array.isArray(j.data)) throw new Error(j.msg || 'respons OKX tidak valid');
        return j.data.slice().reverse().map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], closed: r[8] === '1' }));
      },
      parseTicker: (j) => {
        const d = j.data && j.data[0];
        if (!d) throw new Error('ticker OKX kosong');
        const last = +d.last;
        const open = +d.open24h;
        return { last, changePct: open ? ((last - open) / open) * 100 : NaN, high: +d.high24h, low: +d.low24h, quoteVol: +d.volCcy24h };
      },
    },
  ];

  async function getJSON(url, ms = 9000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Coba sumber satu per satu sampai berhasil.
  async function fetchKlines(base, tf, limit, preferred) {
    const order = preferred ? [preferred, ...SOURCES.filter((s) => s !== preferred)] : SOURCES;
    const errors = [];
    for (const src of order) {
      try {
        const candles = src.parseKlines(await getJSON(src.klines(base, tf, limit)));
        if (!candles.length || candles.some((c) => ![c.o, c.h, c.l, c.c, c.v].every(Number.isFinite))) throw new Error('data candle tidak valid');
        return { candles, src };
      } catch (e) {
        errors.push(`${src.name}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
      }
    }
    const err = new Error(`Tidak bisa memuat ${base}/USDT. ${errors.join(' · ')}`);
    err.attempts = errors;
    throw err;
  }

  async function fetchTicker(base, src) {
    try { return src.parseTicker(await getJSON(src.ticker(base), 6000)); } catch (_) { return null; }
  }

  /* ─────────────────────────────── Utilitas DOM ────────────────────────── */
  const $ = (id) => document.getElementById(id);
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const fp = A.fmtPrice;
  const usd = (x, d = 2) => (Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const compact = (x) => (Number.isFinite(x) ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(x) : '–');

  function row(label, valueNode, cls) {
    return h('div', { class: 'lv' }, h('span', { text: label }), h('b', { class: cls, text: typeof valueNode === 'string' ? valueNode : undefined }, typeof valueNode === 'string' ? null : valueNode));
  }

  /* ───────────────────────────────── Render ────────────────────────────── */
  function renderControls() {
    const chips = $('chips');
    chips.replaceChildren(...COINS.map((c) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(c === state.base), 'data-coin': c, text: c })));
    $('coin-list').replaceChildren(...[...COINS, ...MORE_COINS].map((c) => h('option', { value: c })));
    $('tfs').replaceChildren(...Object.keys(TFS).map((t) => h('button', { class: 'tf', type: 'button', 'aria-pressed': String(t === state.tf), 'data-tf': t, title: TF_NAME[t], text: t })));
  }

  function renderSummary(r, ticker) {
    const v = r.verdict;
    const pos = clampPct(((r.score.total + 100) / 200) * 100);
    const chg = ticker && Number.isFinite(ticker.changePct) ? ticker.changePct : null;

    const head = h('div', null,
      h('div', { class: 'price-row' },
        h('span', { class: 'sym', text: `${state.base}/USDT` }),
        h('span', { class: 'price', text: fp(r.price) }),
        chg === null ? null : h('span', { class: 'chg ' + (chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat'), text: `${A.pct(chg)} (24j)` })),
      h('div', { class: 'meta', text: ticker ? `H ${fp(ticker.high)} · L ${fp(ticker.low)} · Vol 24j ${compact(ticker.quoteVol)} USDT` : 'Data 24 jam tidak tersedia' }));

    const verdict = h('div', { class: 'verdict' },
      h('span', { class: 'badge ' + v.tone, text: v.label }),
      h('span', { class: 'conf' }, 'Keyakinan sinyal: ', h('b', { text: r.confidence.label }), ` · skor ${r.score.total >= 0 ? '+' : ''}${r.score.total.toFixed(0)}/100 · TF ${state.tf}`));

    const meter = h('div', null,
      h('div', { class: 'meter', role: 'img', 'aria-label': `Skor ${r.score.total.toFixed(0)} dari −100 sampai +100` }, h('i', { style: `left:${pos}%` })),
      h('div', { class: 'meter-labels' }, h('span', { text: 'Jual kuat' }), h('span', { text: 'Netral' }), h('span', { text: 'Beli kuat' })));

    const advice = h('p', { class: 'advice', text: adviceText(r) });
    const notes = h('ul', { class: 'notes' }, r.notes.map((n) => h('li', { class: n.tone, text: n.text })));
    return h('section', { class: 'card' }, head, verdict, meter, advice, notes);
  }

  const clampPct = (x) => Math.max(1, Math.min(99, x));

  function adviceText(r) {
    const p = r.plan;
    const w = r.watch;
    const s = (x) => (x ? fp(x) : null);
    switch (r.level) {
      case 2:
        return `Kondisi mendukung beli bertahap. Entri ${s(p.entry)}, stop-loss ${s(p.stop)} (${A.pct(p.stopPct)}), target ${s(p.tp1)} lalu ${s(p.tp2)}. Risiko per transaksi tetap dibatasi oleh ukuran posisi di bawah.`;
      case 1:
        return p.type === 'limit'
          ? `Bias naik, tapi harga sudah terlalu jauh dari rata-rata. Jangan kejar. Pasang limit beli di sekitar ${s(p.entry)} (EMA20) dengan stop ${s(p.stop)}, dan pakai ukuran posisi setengah.`
          : `Bias naik tetapi belum meyakinkan. Kalau masuk, pakai ukuran posisi setengah: entri ${s(p.entry)}, stop ${s(p.stop)}. Menunggu konfirmasi (close candle berikutnya searah) lebih aman.`;
      case 0:
        return `Sinyal campuran atau tidak ada keunggulan jelas. Tidak membuka posisi juga keputusan yang sah. Pantau: ${w.support ? `beli pantulan di dekat support ${s(w.support)} (stop di bawah ${s(w.breakdownBelow)})` : 'belum ada support jelas di bawah'}${w.breakout ? `, atau setelah candle close di atas ${s(w.breakout)}` : ''}.`;
      case -1:
        return `Tekanan turun lebih dominan. Hindari membuka posisi beli baru.${w.support ? ` Jika sudah memegang, waspadai close di bawah ${s(w.breakdownBelow)} — itu tanda tren turun berlanjut.` : ''} Beli hanya jika ada tanda pembalikan: close kembali di atas ${s(w.reclaim || w.resistance)}.`;
      default:
        return `Tren turun kuat. Jangan menangkap pisau jatuh.${w.support ? ` Jika sudah memegang, pertimbangkan mengurangi posisi; support terdekat ${s(w.support)}.` : ''} Tunggu struktur membaik (harga merebut kembali ${s(w.reclaim || w.resistance)}) sebelum beli lagi.`;
    }
  }

  function renderPlan(r) {
    const card = h('section', { class: 'card' }, h('h2', { text: r.plan ? 'Rencana trading (spot)' : 'Level untuk dipantau' }));
    const p = r.plan;
    if (p) {
      card.append(...[
        row(p.type === 'limit' ? 'Entri (limit, tunggu pullback)' : 'Entri (harga sekarang)', fp(p.entry)),
        row(`Stop-loss (${p.stopBasis === 'support' ? 'di bawah support' : '1.5×ATR'})`, `${fp(p.stop)}  (${A.pct(p.stopPct)})`, 'down'),
        row('Target 1 (R:R 1.5) — jual separuh', `${fp(p.tp1)}  (${A.pct(p.tp1Pct)})`, 'up'),
        row('Target 2 (R:R 3) — sisa', `${fp(p.tp2)}  (${A.pct(p.tp2Pct)})`, 'up'),
        p.resistance ? row('Resistance terdekat', `${fp(p.resistance)}  (${p.rrToResistance.toFixed(1)}R)`) : null,
        h('p', { class: 'plan-hint', text: 'Setelah target 1 kena, geser stop ke titik entri. Batalkan ide ini bila close candle menembus stop.' }),
      ].filter(Boolean));
      card.append(calculator(p));
    } else {
      const w = r.watch;
      card.append(...[
        row('Support terdekat', w.support ? fp(w.support) : 'tidak ada di data'),
        row('Resistance terdekat', w.resistance ? fp(w.resistance) : 'tidak ada (harga di level tertinggi data)'),
        w.reclaim ? row('Rebut kembali EMA50 (tanda membaik)', fp(w.reclaim)) : null,
        row('Breakout valid bila close di atas', w.breakout ? fp(w.breakout) : '–', 'up'),
        row('Tren turun lanjut bila close di bawah', w.breakdownBelow ? fp(w.breakdownBelow) : '–', 'down'),
        h('p', { class: 'plan-hint', text: 'Belum ada rencana entri karena keunggulan sinyal belum cukup. Level di atas adalah pemicu untuk menilai ulang.' }),
      ].filter(Boolean));
    }
    return card;
  }

  function calculator(plan) {
    const cap = h('input', { id: 'capital', type: 'number', min: '1', step: 'any', inputmode: 'decimal', value: String(state.capital) });
    const risk = h('input', { id: 'risk', type: 'number', min: '0.1', max: '10', step: '0.1', inputmode: 'decimal', value: String(state.riskPct) });
    const out = h('div', { id: 'calc-out', 'aria-live': 'polite' });
    const update = () => {
      state.capital = parseFloat(cap.value) || 0;
      state.riskPct = parseFloat(risk.value) || 0;
      store.set('capital', state.capital);
      store.set('risk', state.riskPct);
      const eff = state.riskPct * plan.sizeMult;
      const ps = A.positionSize({ capital: state.capital, riskPct: eff, entry: plan.entry, stop: plan.stop });
      if (!ps) { out.replaceChildren(h('p', { class: 'small', text: 'Isi modal dan risiko dengan angka valid.' })); return; }
      out.replaceChildren(...[
        plan.sizeMult < 1 ? h('p', { class: 'small', text: `Sinyal lemah → risiko dipakai ${eff.toFixed(2)}% (setengah dari ${state.riskPct}%).` }) : null,
        row('Jumlah beli', `${ps.qty.toLocaleString('en-US', { maximumSignificantDigits: 6 })} ${state.base}`),
        row('Nilai posisi', `${usd(ps.value)} USDT (${((ps.value / state.capital) * 100).toFixed(0)}% modal)`),
        row('Rugi bila kena stop (+fee 0.1%×2)', `−${usd(ps.lossAtStop)} USDT (${ps.effectiveRiskPct.toFixed(2)}%)`, 'down'),
        row('Untung di target 1 / target 2', `+${usd(ps.qty * (plan.tp1 - plan.entry))} / +${usd(ps.qty * (plan.tp2 - plan.entry))} USDT`, 'up'),
        ps.capped ? h('p', { class: 'small', text: 'Nilai posisi dibatasi sebesar modal (tanpa leverage), jadi risiko aktual lebih kecil dari target.' }) : null,
      ].filter(Boolean));
    };
    cap.addEventListener('input', update);
    risk.addEventListener('input', update);
    const box = h('div', { class: 'calc' },
      h('h2', { text: 'Ukuran posisi' }),
      h('div', { class: 'calc-in' },
        h('label', null, 'Modal (USDT)', cap),
        h('label', null, 'Risiko per transaksi (%)', risk)),
      out);
    update();
    return box;
  }

  function renderIndicators(r) {
    const tbody = h('tbody', null, r.score.factors.map((f) => {
      const c = f.score > 0.1 ? 'up' : f.score < -0.1 ? 'down' : 'flat';
      return h('tr', null,
        h('td', { text: f.label }),
        h('td', { text: f.value }),
        h('td', { class: 'num', text: `${(f.share * 100).toFixed(0)}%` }),
        h('td', { class: 'num ' + c, text: `${f.score >= 0 ? '+' : ''}${(f.score * 100).toFixed(0)}` }));
    }));
    const regime = { trend: 'trending', range: 'sideways', mixed: 'transisi' }[r.score.regime];
    return h('section', { class: 'card span2' },
      h('h2', { text: 'Dasar penilaian' }),
      h('table', null,
        h('thead', null, h('tr', null, h('th', { text: 'Faktor' }), h('th', { text: 'Kondisi' }), h('th', { class: 'num', text: 'Bobot' }), h('th', { class: 'num', text: 'Skor' }))),
        tbody),
      h('p', { class: 'small', text: `Rezim pasar: ${regime}. Bobot menyesuaikan rezim: saat trending, sinyal tren dinaikkan dan sinyal pembalikan diturunkan; saat sideways kebalikannya. Skor tiap faktor −100…+100; total = rata-rata berbobot.` }),
      h('details', null,
        h('summary', { text: 'Nilai indikator mentah' }),
        h('div', { class: 'small' },
          `EMA20 ${fp(r.stats.ema20)} · EMA50 ${fp(r.stats.ema50)} · EMA200 ${Number.isFinite(r.stats.ema200) ? fp(r.stats.ema200) : 'n/a'} · RSI ${r.stats.rsi.toFixed(1)} · ADX ${r.stats.adx.toFixed(1)} · ATR ${fp(r.stats.atr)} (${r.stats.atrPct.toFixed(2)}%)`)));
  }

  function renderBacktest(bt, candlesN) {
    const card = h('section', { class: 'card span2' }, h('h2', { text: 'Uji historis aturan ini (backtest)' }));
    if (!bt || !bt.trades) {
      card.append(h('p', { class: 'small', text: `Pada ${bt ? bt.bars : 0} candle terakhir tidak ada sinyal BELI (skor ≥ 35) yang selesai. Coba timeframe lebih kecil untuk sampel lebih banyak.` }));
      return card;
    }
    const good = bt.avgR > 0;
    const stat = (label, value, cls) => h('div', { class: 'stat' }, h('small', { text: label }), h('b', { class: cls, text: value }));
    card.append(
      h('div', { class: 'bt-grid' },
        stat('Jumlah trade', String(bt.trades)),
        stat('Win rate', `${(bt.winRate * 100).toFixed(0)}%`),
        stat('Rata-rata per trade', `${bt.avgR >= 0 ? '+' : ''}${bt.avgR.toFixed(2)}R`, good ? 'up' : 'down'),
        stat('Total', `${bt.totalR >= 0 ? '+' : ''}${bt.totalR.toFixed(1)}R`, bt.totalR >= 0 ? 'up' : 'down'),
        stat('Profit factor', Number.isFinite(bt.profitFactor) ? bt.profitFactor.toFixed(2) : '∞'),
        stat('Penurunan maks.', `−${bt.maxDrawdownR.toFixed(1)}R`, 'down'),
        stat(`Beli & tahan (${bt.bars} candle)`, A.pct(bt.buyHoldPct, 1), bt.buyHoldPct >= 0 ? 'up' : 'down')),
      h('p', { class: bt.trades < 20 ? 'notes' : 'small', text: backtestVerdict(bt) }),
      h('p', { class: 'small', text: '1R = jarak entri ke stop. Aturan: masuk di open candle setelah skor ≥ 35, stop 1.5×ATR, jual separuh di 1.5R lalu geser stop ke entri, sisa di 3R, maksimal 60 candle. Fee 0.1% per sisi sudah dihitung. Bila stop dan target tersentuh di candle yang sama, dianggap stop kena lebih dulu. Hanya aturan skor inti — tanpa filter timeframe tinggi. Performa lampau tidak menjamin hasil ke depan.' }));
    return card;
  }

  function backtestVerdict(bt) {
    const parts = [];
    if (bt.trades < 20) parts.push(`Sampel hanya ${bt.trades} trade — terlalu sedikit untuk menyimpulkan apa pun secara statistik.`);
    if (bt.avgR <= 0) parts.push('Pada data ini aturan belum terbukti menguntungkan setelah fee; jangan terlalu percaya sinyalnya di koin/timeframe ini.');
    else if (bt.trades >= 20) parts.push('Rata-rata positif setelah fee pada data ini, tetapi tetap bisa kebetulan atau berubah saat kondisi pasar berubah.');
    else parts.push('Hasil positif, tapi sampel kecil.');
    return parts.join(' ');
  }

  /* ─────────────────────────────── Grafik candle ───────────────────────── */
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function drawChart(canvas, r, candles) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const N = Math.min(110, candles.length);
    const start = candles.length - N;
    const vis = candles.slice(start);
    const ind = r.ind;
    const col = { up: cssVar('--green'), down: cssVar('--red'), muted: cssVar('--muted'), line: cssVar('--line'), text: cssVar('--text'), blue: cssVar('--blue'), amber: cssVar('--amber') };
    const padR = 70;
    const padT = 10;
    const volH = Math.round(H * 0.16);
    const plotH = H - padT - volH - 22;
    const plotW = W - padR;

    let lo = Math.min(...vis.map((c) => c.l));
    let hi = Math.max(...vis.map((c) => c.h));
    const span0 = hi - lo || 1;
    lo -= span0 * 0.04;
    hi += span0 * 0.04;
    const y = (p) => padT + (1 - (p - lo) / (hi - lo)) * plotH;
    const step = plotW / N;
    const x = (i) => i * step + step / 2;

    // grid + label harga
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.strokeStyle = col.line;
    g.fillStyle = col.muted;
    g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const p = lo + ((hi - lo) * k) / 4;
      const yy = Math.round(y(p)) + 0.5;
      g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke();
      g.fillText(fp(p), plotW + 6, yy);
    }

    // volume
    const maxV = Math.max(...vis.map((c) => c.v)) || 1;
    vis.forEach((c, i) => {
      const hh = (c.v / maxV) * (volH - 4);
      g.globalAlpha = 0.35;
      g.fillStyle = c.c >= c.o ? col.up : col.down;
      g.fillRect(x(i) - step * 0.35, H - 22 - hh, step * 0.7, hh);
    });
    g.globalAlpha = 1;

    // garis level (di belakang candle)
    const hline = (price, color, label, dash, right) => {
      if (!Number.isFinite(price) || price < lo || price > hi) return;
      const yy = Math.round(y(price)) + 0.5;
      g.save();
      g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 1;
      g.setLineDash(dash || [5, 4]);
      g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke();
      g.restore();
      g.fillStyle = color;
      g.font = '600 11px system-ui, sans-serif';
      if (right) { g.textAlign = 'right'; g.fillText(label, plotW - 6, yy - 7); g.textAlign = 'left'; } else g.fillText(label, 6, yy - 7);
    };
    r.levels.supports.slice(0, 2).forEach((s, i) => hline(s.price, col.muted, i ? '' : 'Support', [2, 4], true));
    r.levels.resistances.slice(0, 2).forEach((s, i) => hline(s.price, col.muted, i ? '' : 'Resistance', [2, 4], true));
    if (r.plan) {
      hline(r.plan.entry, col.blue, 'Entri');
      hline(r.plan.stop, col.down, 'Stop');
      hline(r.plan.tp1, col.up, 'TP1');
      hline(r.plan.tp2, col.up, 'TP2');
    }

    // EMA
    const line = (arr, color) => {
      g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
      let started = false;
      for (let i = 0; i < N; i++) {
        const v = arr[start + i];
        if (!Number.isFinite(v) || v < lo || v > hi) { started = false; continue; }
        if (!started) { g.moveTo(x(i), y(v)); started = true; } else g.lineTo(x(i), y(v));
      }
      g.stroke();
    };

    // candle
    vis.forEach((c, i) => {
      const color = c.c >= c.o ? col.up : col.down;
      g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 1;
      const xx = Math.round(x(i)) + 0.5;
      g.beginPath(); g.moveTo(xx, y(c.h)); g.lineTo(xx, y(c.l)); g.stroke();
      const top = y(Math.max(c.o, c.c));
      const bh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
      g.fillRect(x(i) - step * 0.34, top, step * 0.68, bh);
    });
    line(ind.ema20, col.amber);
    line(ind.ema50, col.blue);

    // harga sekarang
    const py = y(r.price);
    if (py >= padT && py <= padT + plotH) {
      g.fillStyle = col.text;
      g.fillRect(plotW, py - 9, padR - 2, 18);
      g.fillStyle = cssVar('--bg');
      g.font = '600 11px system-ui, sans-serif';
      g.fillText(fp(r.price), plotW + 4, py);
    }

    // label waktu
    g.fillStyle = col.muted;
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'alphabetic';
    const fmt = (t) => {
      const d = new Date(t);
      const dd = d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
      return state.tf === '1d' || state.tf === '1w' ? dd : `${dd} ${d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
    };
    [0, Math.floor(N / 2), N - 1].forEach((i, k) => {
      const txt = fmt(vis[i].t);
      const w = g.measureText(txt).width;
      const xx = k === 0 ? 2 : k === 2 ? plotW - w - 2 : x(i) - w / 2;
      g.fillText(txt, xx, H - 6);
    });
  }

  function renderChartCard() {
    return h('section', { class: 'card span2' },
      h('h2', { text: `Grafik ${state.base}/USDT · ${state.tf}` }),
      h('div', { class: 'chart-box' }, h('canvas', { id: 'chart', role: 'img', 'aria-label': 'Grafik candlestick dengan EMA20, EMA50, support dan resistance' })),
      h('div', { class: 'legend' },
        h('span', null, h('i', { style: `background:${cssVar('--amber')}` }), 'EMA20'),
        h('span', null, h('i', { style: `background:${cssVar('--blue')}` }), 'EMA50'),
        h('span', null, 'Garis putus-putus abu-abu: support/resistance'),
        h('span', null, 'Hanya candle yang sudah tutup dipakai untuk sinyal')));
  }

  function renderAll() {
    const { r, ticker, bt, candles } = state.result;
    const app = $('app');
    app.replaceChildren(
      h('div', { class: 'grid' },
        renderSummary(r, ticker),
        renderPlan(r),
        renderChartCard(),
        renderIndicators(r),
        renderBacktest(bt),
      ));
    drawChart($('chart'), r, candles);
  }

  function showState(kind, text) {
    $('app').replaceChildren(h('div', { class: 'card state ' + (kind === 'error' ? 'error' : '') }, kind === 'loading' ? h('span', { class: 'spin' }) : null, text));
  }

  /* ───────────────────────────────── Alur utama ────────────────────────── */
  async function load(silent) {
    const id = ++state.loadId;
    const { base, tf } = state;
    if (!silent) showState('loading', `Memuat ${base}/USDT ${tf}…`);
    try {
      const main = await fetchKlines(base, tf, LIMIT_MAIN);
      const htfTf = TFS[tf].htf;
      const [htf, ticker] = await Promise.all([
        htfTf ? fetchKlines(base, htfTf, LIMIT_HTF, main.src).catch(() => null) : null,
        fetchTicker(base, main.src),
      ]);
      if (id !== state.loadId) return; // pengguna sudah ganti pilihan

      const closed = main.candles.filter((c) => c.closed);
      const live = main.candles[main.candles.length - 1].c;
      const livePrice = ticker && Number.isFinite(ticker.last) ? ticker.last : live;

      let htfScore = null;
      if (htf) {
        const hr = A.analyze(htf.candles.filter((c) => c.closed));
        if (hr.ok) htfScore = { total: hr.score.total };
      }
      const r = A.analyze(closed, { livePrice, htf: htfScore });
      if (!r.ok) { showState('error', r.error); return; }
      const bt = A.backtest(closed, { ind: r.ind });
      if (r.level > 0) { // jangan sembunyikan fakta tidak enak di dasar halaman
        if (bt.trades >= 20 && bt.avgR <= 0 && r.confidence.label === 'Tinggi') r.confidence.label = 'Sedang';
        if (bt.trades >= 20 && bt.avgR <= 0) r.notes.push({ tone: 'bad', text: `Uji historis aturan beli di ${base}/${tf} negatif setelah fee (${bt.trades} trade, rata-rata ${bt.avgR.toFixed(2)}R). Anggap sinyal ini informasi, bukan keunggulan terbukti.` });
        else if (bt.trades < 20) r.notes.push({ tone: 'info', text: `Uji historis baru ${bt.trades} trade — terlalu sedikit untuk membuktikan aturan ini bekerja di ${base}/${tf}.` });
      }

      state.result = { r, ticker, bt, candles: closed };
      renderAll();
      $('source').textContent = `Sumber data: ${main.src.name} · ${closed.length} candle ${tf} tertutup${htfTf ? ` · konfirmasi ${htfTf}${htf ? '' : ' (gagal dimuat)'}` : ''}`;
      $('updated').textContent = `Diperbarui ${new Date().toLocaleTimeString('id-ID')}`;
    } catch (e) {
      if (id !== state.loadId) return;
      if (silent && state.result) { $('updated').textContent = 'Gagal memperbarui — memakai data terakhir'; return; }
      const hint = e.attempts && e.attempts.every((a) => /HTTP 4(00|51)/.test(a)) ? ` Pastikan simbol benar (pair ${base}/USDT harus ada di bursa).` : '';
      showState('error', `${e.message}${hint}`);
    }
  }

  function setCoin(raw) {
    const c = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/USDT$/, '');
    if (!c) return;
    state.base = c;
    store.set('base', c);
    $('coin').value = COINS.includes(c) ? '' : c;
    document.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.coin === c)));
    load();
  }
  function setTf(tf) {
    if (!TFS[tf]) return;
    state.tf = tf;
    store.set('tf', tf);
    document.querySelectorAll('.tf').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tf === tf)));
    load();
  }

  renderControls();
  if (!COINS.includes(state.base)) $('coin').value = state.base;
  $('chips').addEventListener('click', (e) => { const b = e.target.closest('[data-coin]'); if (b) setCoin(b.dataset.coin); });
  $('tfs').addEventListener('click', (e) => { const b = e.target.closest('[data-tf]'); if (b) setTf(b.dataset.tf); });
  $('refresh').addEventListener('click', () => load());
  $('coin').addEventListener('change', (e) => setCoin(e.target.value));
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.result && $('chart')) drawChart($('chart'), state.result.r, state.result.candles); }, 120);
  });
  setInterval(() => {
    const a = document.activeElement;
    if (document.hidden || (a && a.tagName === 'INPUT' && $('app').contains(a))) return; // jangan ganggu saat mengetik
    load(true);
  }, REFRESH_MS);
  load();
})();
