/*
 * Trade-ME — mesin analisis teknikal.
 *
 * Semua fungsi murni (tanpa DOM, tanpa jaringan) supaya bisa diuji di Node dan dipakai di browser.
 * Format candle: { t, o, h, l, c, v } (waktu ms, open, high, low, close, volume).
 *
 * Prinsip:
 *  - Semua indikator bersifat kausal: nilai di indeks i hanya memakai data indeks <= i.
 *    Itu yang membuat backtest di bawah tidak "mengintip masa depan".
 *  - Skor memakai bobot yang tampil apa adanya di UI — tidak ada kotak hitam.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Analysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const nan = (n) => new Array(n).fill(NaN);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

  // Interpolasi linear lewat titik-titik [x, y] yang terurut.
  function interp(points, x) {
    if (x <= points[0][0]) return points[0][1];
    for (let k = 1; k < points.length; k++) {
      if (x <= points[k][0]) {
        const [x0, y0] = points[k - 1];
        const [x1, y1] = points[k];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return points[points.length - 1][1];
  }

  /* ───────────────────────────── Indikator ───────────────────────────── */

  function sma(v, p) {
    const out = nan(v.length);
    let sum = 0;
    for (let i = 0; i < v.length; i++) {
      sum += v[i];
      if (i >= p) sum -= v[i - p];
      if (i >= p - 1) out[i] = sum / p;
    }
    return out;
  }

  // EMA diseed dengan SMA p nilai pertama (konvensi TA-Lib). Aman untuk input yang diawali NaN.
  function ema(v, p) {
    const out = nan(v.length);
    const s = v.findIndex((x) => !Number.isNaN(x));
    if (s < 0 || v.length - s < p) return out;
    let sum = 0;
    for (let i = s; i < s + p; i++) sum += v[i];
    let prev = sum / p;
    out[s + p - 1] = prev;
    const k = 2 / (p + 1);
    for (let i = s + p; i < v.length; i++) {
      prev = v[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // RSI dengan smoothing Wilder.
  function rsi(c, p = 14) {
    const out = nan(c.length);
    if (c.length <= p) return out;
    let g = 0;
    let l = 0;
    for (let i = 1; i <= p; i++) {
      const d = c[i] - c[i - 1];
      if (d >= 0) g += d;
      else l -= d;
    }
    g /= p;
    l /= p;
    const val = () => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
    out[p] = val();
    for (let i = p + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
      l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
      out[i] = val();
    }
    return out;
  }

  function macd(c, fast = 12, slow = 26, sig = 9) {
    const f = ema(c, fast);
    const s = ema(c, slow);
    const line = c.map((_, i) => f[i] - s[i]);
    const signal = ema(line, sig);
    const hist = line.map((x, i) => x - signal[i]);
    return { line, signal, hist };
  }

  // Bollinger Bands dengan standar deviasi populasi (konvensi umum).
  function bollinger(c, p = 20, m = 2) {
    const mid = sma(c, p);
    const upper = nan(c.length);
    const lower = nan(c.length);
    const pctB = nan(c.length);
    const bw = nan(c.length);
    for (let i = p - 1; i < c.length; i++) {
      let ss = 0;
      for (let j = i - p + 1; j <= i; j++) ss += (c[j] - mid[i]) ** 2;
      const sd = Math.sqrt(ss / p);
      upper[i] = mid[i] + m * sd;
      lower[i] = mid[i] - m * sd;
      const width = upper[i] - lower[i];
      pctB[i] = width === 0 ? 0.5 : (c[i] - lower[i]) / width;
      bw[i] = mid[i] === 0 ? NaN : width / mid[i];
    }
    return { mid, upper, lower, pctB, bw };
  }

  function trueRange(h, l, c) {
    const tr = new Array(h.length);
    tr[0] = h[0] - l[0];
    for (let i = 1; i < h.length; i++) {
      tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    }
    return tr;
  }

  // ATR Wilder; nilai pertama di indeks p = rata-rata TR[1..p] (konvensi TA-Lib).
  function atr(h, l, c, p = 14) {
    const out = nan(h.length);
    if (h.length <= p) return out;
    const tr = trueRange(h, l, c);
    let a = 0;
    for (let i = 1; i <= p; i++) a += tr[i];
    a /= p;
    out[p] = a;
    for (let i = p + 1; i < h.length; i++) {
      a = (a * (p - 1) + tr[i]) / p;
      out[i] = a;
    }
    return out;
  }

  // ADX + DI (Wilder). ADX pertama di indeks 2p-1.
  function adx(h, l, c, p = 14) {
    const n = h.length;
    const outAdx = nan(n);
    const pdi = nan(n);
    const mdi = nan(n);
    if (n < 2 * p) return { adx: outAdx, pdi, mdi };
    const tr = trueRange(h, l, c);
    const pdm = new Array(n).fill(0);
    const mdm = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const up = h[i] - h[i - 1];
      const down = l[i - 1] - l[i];
      pdm[i] = up > down && up > 0 ? up : 0;
      mdm[i] = down > up && down > 0 ? down : 0;
    }
    let sTR = 0;
    let sP = 0;
    let sM = 0;
    for (let i = 1; i <= p; i++) {
      sTR += tr[i];
      sP += pdm[i];
      sM += mdm[i];
    }
    const dx = nan(n);
    const calc = (i) => {
      pdi[i] = sTR === 0 ? 0 : (100 * sP) / sTR;
      mdi[i] = sTR === 0 ? 0 : (100 * sM) / sTR;
      const sum = pdi[i] + mdi[i];
      dx[i] = sum === 0 ? 0 : (100 * Math.abs(pdi[i] - mdi[i])) / sum;
    };
    calc(p);
    for (let i = p + 1; i < n; i++) {
      sTR = sTR - sTR / p + tr[i];
      sP = sP - sP / p + pdm[i];
      sM = sM - sM / p + mdm[i];
      calc(i);
    }
    let a = 0;
    for (let i = p; i <= 2 * p - 1; i++) a += dx[i];
    a /= p;
    outAdx[2 * p - 1] = a;
    for (let i = 2 * p; i < n; i++) {
      a = (a * (p - 1) + dx[i]) / p;
      outAdx[i] = a;
    }
    return { adx: outAdx, pdi, mdi };
  }

  // Persentil nilai arr[i] terhadap `window` nilai valid terakhir (0..1).
  function percentileRank(arr, i, window = 200) {
    const x = arr[i];
    if (Number.isNaN(x)) return NaN;
    let n = 0;
    let le = 0;
    for (let j = Math.max(0, i - window + 1); j <= i; j++) {
      if (Number.isNaN(arr[j])) continue;
      n++;
      if (arr[j] <= x) le++;
    }
    return n ? le / n : NaN;
  }

  function buildIndicators(candles) {
    const open = candles.map((x) => x.o);
    const high = candles.map((x) => x.h);
    const low = candles.map((x) => x.l);
    const close = candles.map((x) => x.c);
    const vol = candles.map((x) => x.v);
    const a = atr(high, low, close, 14);
    return {
      n: candles.length,
      open,
      high,
      low,
      close,
      vol,
      ema20: ema(close, 20),
      ema50: ema(close, 50),
      ema200: ema(close, 200),
      rsi: rsi(close, 14),
      macd: macd(close),
      bb: bollinger(close, 20, 2),
      atr: a,
      atrPct: a.map((x, i) => x / close[i]),
      adx: adx(high, low, close, 14),
    };
  }

  /* ───────────────────────── Support / Resistance ────────────────────── */

  // Pivot swing (k candle di kiri & kanan), digabung bila berdekatan (< 0.5 ATR).
  function findLevels(candles, price, atrNow, k = 5, lookback = 300) {
    const n = candles.length;
    const from = Math.max(k, n - lookback);
    const raw = [];
    for (let i = from; i < n - k; i++) {
      let isH = true;
      let isL = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (candles[j].h >= candles[i].h) isH = false;
        if (candles[j].l <= candles[i].l) isL = false;
      }
      if (isH) raw.push(candles[i].h);
      if (isL) raw.push(candles[i].l);
    }
    raw.sort((a, b) => a - b);
    const tol = Number.isFinite(atrNow) ? atrNow * 0.5 : price * 0.005;
    const clusters = [];
    for (const p of raw) {
      const last = clusters[clusters.length - 1];
      if (last && p - last.sum / last.count <= tol) {
        last.sum += p;
        last.count++;
      } else clusters.push({ sum: p, count: 1 });
    }
    const levels = clusters.map((c) => ({ price: c.sum / c.count, touches: c.count }));
    const supports = levels.filter((x) => x.price < price - 0.1 * (atrNow || 0)).sort((a, b) => b.price - a.price);
    const resistances = levels.filter((x) => x.price > price + 0.1 * (atrNow || 0)).sort((a, b) => a.price - b.price);
    return { supports: supports.slice(0, 3), resistances: resistances.slice(0, 3) };
  }

  /* ──────────────────────────────── Skor ─────────────────────────────── */

  const BASE_WEIGHTS = { trend: 30, macd: 20, rsi: 20, bb: 10, vol: 10, adx: 10 };
  // Pasar trending: ikuti tren, kurangi sinyal pembalikan. Pasar sideways: sebaliknya.
  const REGIME_MULT = {
    trend: { trend: 1.2, macd: 1.0, rsi: 0.7, bb: 0.6, vol: 1, adx: 1.2 },
    range: { trend: 0.5, macd: 0.6, rsi: 1.4, bb: 1.5, vol: 1, adx: 0.5 },
    mixed: { trend: 1, macd: 1, rsi: 1, bb: 1, vol: 1, adx: 1 },
  };
  const RSI_CURVE = [[10, 1], [30, 0.7], [40, -0.1], [50, 0], [60, 0.4], [68, 0.2], [75, -0.4], [85, -0.9], [100, -1]];
  const BB_CURVE = [[-0.2, 0.9], [0, 0.6], [0.2, 0.3], [0.5, 0], [0.8, -0.3], [1, -0.6], [1.2, -0.9]];
  const MIN_BARS = 60;

  function regimeOf(adxVal) {
    return adxVal >= 25 ? 'trend' : adxVal < 20 ? 'range' : 'mixed';
  }

  // Skor di candle ke-i (hanya memakai data <= i). Mengembalikan null bila indikator belum siap.
  function scoreAt(ind, i) {
    const c = ind.close[i];
    const e20 = ind.ema20[i];
    const e50 = ind.ema50[i];
    const e200 = ind.ema200[i];
    const rs = ind.rsi[i];
    const hist = ind.macd.hist[i];
    const histPrev = ind.macd.hist[i - 1];
    const ml = ind.macd.line[i];
    const pb = ind.bb.pctB[i];
    const ad = ind.adx.adx[i];
    const pdi = ind.adx.pdi[i];
    const mdi = ind.adx.mdi[i];
    if ([e20, e50, rs, hist, histPrev, ml, pb, ad, pdi, mdi].some(Number.isNaN)) return null;

    // 1) Tren: struktur EMA
    const comps = [
      [c > e50 ? 1 : -1, 0.3, c > e50 ? 'harga di atas EMA50' : 'harga di bawah EMA50'],
      [e20 > e50 ? 1 : -1, 0.25, e20 > e50 ? 'EMA20 di atas EMA50' : 'EMA20 di bawah EMA50'],
    ];
    if (!Number.isNaN(e200)) comps.push([c > e200 ? 1 : -1, 0.25, c > e200 ? 'di atas EMA200' : 'di bawah EMA200']);
    if (i >= 55) comps.push([sign(e50 - ind.ema50[i - 5]), 0.2, e50 > ind.ema50[i - 5] ? 'EMA50 menanjak' : 'EMA50 menurun']);
    const wsum = comps.reduce((s, x) => s + x[1], 0);
    const trendScore = comps.reduce((s, x) => s + x[0] * x[1], 0) / wsum;

    // 2) Momentum MACD
    const macdScore = (hist > 0 ? 0.5 : -0.5) + (hist > histPrev ? 0.3 : -0.3) + (ml > 0 ? 0.2 : -0.2);

    // 3) RSI (kurva non-linear: momentum sehat 50–65 positif, jenuh beli/jual berlawanan)
    const rsiScore = interp(RSI_CURVE, rs);

    // 4) Bollinger %B (mean-reversion)
    const bbScore = interp(BB_CURVE, pb);

    // 5) Tekanan volume: 5 candle terakhir, dibobot volume; diredam bila volume sepi
    let signedV = 0;
    let totV = 0;
    for (let j = Math.max(0, i - 4); j <= i; j++) {
      signedV += sign(ind.close[j] - ind.open[j]) * ind.vol[j];
      totV += ind.vol[j];
    }
    const pressure = totV ? signedV / totV : 0;
    let v3 = 0;
    let v20 = 0;
    let n3 = 0;
    let n20 = 0;
    for (let j = Math.max(0, i - 19); j <= i; j++) {
      v20 += ind.vol[j];
      n20++;
      if (j > i - 3) {
        v3 += ind.vol[j];
        n3++;
      }
    }
    const volRatio = v20 ? v3 / n3 / (v20 / n20) : 1;
    const volScore = pressure * (clamp(volRatio, 0.6, 1.2) / 1.2);

    // 6) Arah & kekuatan tren: DI+/DI- diskalakan ADX
    const adxScore = (pdi > mdi ? 1 : -1) * clamp(ad / 40, 0, 1);

    const regime = regimeOf(ad);
    const mult = REGIME_MULT[regime];
    const defs = [
      { key: 'trend', label: 'Tren (EMA 20/50/200)', score: trendScore, value: comps.map((x) => x[2]).join(', ') },
      {
        key: 'macd',
        label: 'Momentum (MACD)',
        score: macdScore,
        value: `Histogram ${hist > 0 ? 'positif' : 'negatif'} & ${hist > histPrev ? 'menguat' : 'melemah'}`,
      },
      { key: 'rsi', label: 'RSI (14)', score: rsiScore, value: rs.toFixed(1) },
      { key: 'bb', label: 'Bollinger %B', score: bbScore, value: `${(pb * 100).toFixed(0)}% dari lebar band` },
      {
        key: 'vol',
        label: 'Tekanan volume (5 candle)',
        score: volScore,
        value: `${pressure >= 0 ? 'Beli' : 'Jual'} ${(Math.abs(pressure) * 100).toFixed(0)}% · volume ×${volRatio.toFixed(2)}`,
      },
      {
        key: 'adx',
        label: 'Kekuatan tren (ADX/DI)',
        score: adxScore,
        value: `ADX ${ad.toFixed(1)} · DI${pdi > mdi ? '+' : '−'} dominan`,
      },
    ];
    let num = 0;
    let den = 0;
    const factors = defs.map((d) => {
      const weight = BASE_WEIGHTS[d.key] * mult[d.key];
      num += weight * d.score;
      den += weight;
      return { ...d, weight };
    });
    const total = (num / den) * 100;
    // Kesepakatan: porsi bobot faktor (yang cukup tegas) searah dengan skor total.
    let agree = 0;
    let decisive = 0;
    for (const f of factors) {
      if (Math.abs(f.score) < 0.1) continue;
      decisive += f.weight;
      if (sign(f.score) === sign(total)) agree += f.weight;
    }
    return {
      total,
      regime,
      factors: factors.map((f) => ({ ...f, share: f.weight / den })),
      agreement: decisive ? agree / decisive : 0,
      volRatio,
      pressure,
    };
  }

  /* ───────────────────────── Keputusan & rencana ─────────────────────── */

  const LEVELS = {
    2: { label: 'BELI', tone: 'buy' },
    1: { label: 'CONDONG BELI', tone: 'buy-weak' },
    0: { label: 'TUNGGU', tone: 'wait' },
    '-1': { label: 'CONDONG JUAL', tone: 'sell-weak' },
    '-2': { label: 'JUAL / HINDARI', tone: 'sell' },
  };

  function fmtPrice(p) {
    if (!Number.isFinite(p)) return '–';
    const a = Math.abs(p);
    const d = a >= 100 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.1 ? 5 : 6;
    return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  const pct = (x, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;

  // Stop-loss: di bawah support terdekat bila posisinya wajar, kalau tidak 1.5×ATR.
  function buildPlan(entry, atrNow, supports, resistances, type) {
    const atrStop = entry - 1.5 * atrNow;
    let stop = atrStop;
    let basis = 'atr';
    const sup = supports.find((s) => s.price <= entry - 0.5 * atrNow && s.price >= entry - 1.5 * atrNow);
    if (sup) {
      stop = sup.price - 0.25 * atrNow;
      basis = 'support';
    }
    const risk = entry - stop;
    const tp1 = entry + 1.5 * risk;
    const tp2 = entry + 3 * risk;
    const res = resistances.find((r) => r.price > entry);
    return {
      type,
      entry,
      stop,
      stopPct: ((stop - entry) / entry) * 100,
      tp1,
      tp2,
      tp1Pct: ((tp1 - entry) / entry) * 100,
      tp2Pct: ((tp2 - entry) / entry) * 100,
      riskPerUnit: risk,
      stopBasis: basis,
      resistance: res ? res.price : null,
      rrToResistance: res ? (res.price - entry) / risk : null,
      sizeMult: 1,
    };
  }

  /**
   * Analisis lengkap pada candle yang SUDAH TUTUP.
   * opts.htf = { total } skor timeframe lebih tinggi (opsional).
   * opts.livePrice = harga terkini (opsional; default close terakhir).
   */
  function analyze(candles, opts = {}) {
    if (!candles || candles.length < MIN_BARS) {
      return { ok: false, error: `Data terlalu sedikit (${candles ? candles.length : 0} candle, minimal ${MIN_BARS}).` };
    }
    const ind = buildIndicators(candles);
    const i = candles.length - 1;
    const sc = scoreAt(ind, i);
    if (!sc) return { ok: false, error: 'Indikator belum siap — data belum cukup panjang.' };

    const close = ind.close[i];
    const price = Number.isFinite(opts.livePrice) ? opts.livePrice : close;
    const atrNow = ind.atr[i];
    const rsNow = ind.rsi[i];
    const e20 = ind.ema20[i];
    const e50 = ind.ema50[i];
    const levels = findLevels(candles, price, atrNow);
    const sup = levels.supports[0] || null;
    const res = levels.resistances[0] || null;
    const ext = (price - e20) / atrNow; // jarak dari EMA20 dalam satuan ATR
    const atrRank = percentileRank(ind.atrPct, i);
    const bwRank = percentileRank(ind.bb.bw, i);

    const notes = [];
    const note = (tone, text) => notes.push({ tone, text });

    const total = sc.total;
    let level = total >= 35 ? 2 : total >= 15 ? 1 : total > -15 ? 0 : total > -35 ? -1 : -2;
    const baseLevel = level;
    let chase = false; // true → jangan beli di harga pasar, tunggu pullback

    // Kondisi pasar
    const adxNow = ind.adx.adx[i];
    if (sc.regime === 'trend') {
      note('info', `Pasar sedang trending (ADX ${adxNow.toFixed(0)}): sinyal searah tren lebih andal; melawan tren berisiko.`);
    } else if (sc.regime === 'range') {
      note('info', `Pasar cenderung sideways (ADX ${adxNow.toFixed(0)}): sinyal tren kurang andal. Lebih masuk akal beli dekat support & ambil untung dekat resistance, bukan mengejar breakout.`);
    } else {
      note('info', `Tren sedang transisi (ADX ${adxNow.toFixed(0)}): tunggu konfirmasi sebelum percaya pada satu arah.`);
    }

    if (level > 0 && rsNow >= 75) {
      note('warn', `RSI ${rsNow.toFixed(0)} jenuh beli: probabilitas koreksi meningkat. Jangan mengejar harga.`);
      chase = true;
      level = Math.min(level, 1);
    } else if (level > 0 && ext >= 3) {
      note('warn', `Harga ${ext.toFixed(1)}×ATR di atas EMA20 — sudah menjauh dari rata-rata dan rawan ditarik balik.`);
      chase = true;
      level = Math.min(level, 1);
    }
    if (level < 0 && rsNow <= 25) {
      note('warn', `RSI ${rsNow.toFixed(0)} jenuh jual: pantulan teknikal mungkin terjadi, tetapi di tren turun pantulan sering gagal. Jangan menjual panik di dasar; juga jangan menangkap pisau jatuh.`);
    }

    // Timeframe lebih tinggi
    let htfState = null;
    if (opts.htf && Number.isFinite(opts.htf.total)) {
      const h = opts.htf.total;
      if (level > 0 && h <= -15) {
        note('bad', `Timeframe lebih tinggi sedang turun (skor ${h.toFixed(0)}): sinyal beli ini melawan arus, keyakinan diturunkan.`);
        level -= 1;
        htfState = 'opposed';
      } else if (level < 0 && h >= 15) {
        note('warn', `Timeframe lebih tinggi masih naik (skor ${h.toFixed(0)}): tekanan turun ini bisa hanya koreksi sementara.`);
        level += 1;
        htfState = 'opposed';
      } else if (level !== 0 && Math.sign(h) === Math.sign(level) && Math.abs(h) >= 15) {
        note('good', `Timeframe lebih tinggi searah (skor ${h.toFixed(0)}): sinyal terkonfirmasi.`);
        htfState = 'aligned';
      } else {
        const arah = Math.abs(h) < 15 ? 'netral' : h > 0 ? 'naik' : 'turun';
        note('info', `Timeframe lebih tinggi ${arah} (skor ${h.toFixed(0)})${level === 0 ? '.' : ' — tidak mengubah sinyal.'}`);
        htfState = 'neutral';
      }
    }

    // Volatilitas
    if (atrRank >= 0.8) note('warn', `Volatilitas tinggi (ATR ${(ind.atrPct[i] * 100).toFixed(2)}% per candle, persentil ${(atrRank * 100).toFixed(0)}): kecilkan ukuran posisi, stop akan lebar.`);
    else if (atrRank <= 0.2) note('info', `Volatilitas rendah (persentil ${(atrRank * 100).toFixed(0)}): pasar sedang tenang.`);
    if (bwRank <= 0.15) note('info', 'Bollinger Bands menyempit (squeeze): biasanya diikuti pergerakan besar, arahnya belum tentu searah sinyal. Tunggu breakout dengan volume.');
    if (sc.volRatio < 0.6) note('warn', `Volume sepi (×${sc.volRatio.toFixed(2)} dari rata-rata): pergerakan harga kurang meyakinkan.`);

    // Rencana trading (hanya untuk sisi beli / spot)
    let plan = null;
    let watch = null;
    if (level > 0) {
      let entry = price;
      let type = 'market';
      if (chase && e20 < price) {
        entry = e20;
        type = 'limit';
      }
      plan = buildPlan(entry, atrNow, levels.supports, levels.resistances, type);
      plan.sizeMult = level === 2 ? 1 : 0.5;
      if (plan.rrToResistance !== null && plan.rrToResistance < 1) {
        note('bad', `Resistance terdekat (${fmtPrice(plan.resistance)}) hanya ${plan.rrToResistance.toFixed(2)}R dari entri — risiko lebih besar dari potensi ruang naik. Tidak layak dibeli sekarang.`);
        level = 0;
        plan = null;
      } else if (plan.rrToResistance !== null && plan.rrToResistance < 3) {
        note('warn', `Resistance di ${fmtPrice(plan.resistance)} (${plan.rrToResistance.toFixed(1)}R): target 2 kemungkinan tertahan di sana. Pertimbangkan ambil untung lebih awal.`);
      }
    }
    if (level <= 0) {
      watch = {
        support: sup ? sup.price : null,
        resistance: res ? res.price : null,
        reclaim: price < e50 ? e50 : null,
        breakout: res ? res.price + 0.25 * atrNow : null,
        breakdownBelow: sup ? sup.price - 0.25 * atrNow : null,
      };
    }

    // Keyakinan = kesepakatan antar indikator (BUKAN probabilitas menang)
    let conf = 0.5 * sc.agreement + 0.5 * Math.min(1, Math.abs(total) / 60);
    if (htfState === 'aligned') conf += 0.1;
    if (htfState === 'opposed') conf -= 0.2;
    if (level === 0) conf = Math.min(conf, 0.4);
    conf = clamp(conf, 0, 1);
    const confLabel = conf < 0.45 ? 'Rendah' : conf < 0.65 ? 'Sedang' : 'Tinggi';

    return {
      ok: true,
      index: i,
      candles: candles.length,
      price,
      close,
      ind,
      score: sc,
      baseLevel,
      level,
      verdict: { ...LEVELS[level], level },
      confidence: { value: conf, label: confLabel },
      chase,
      notes,
      plan,
      watch,
      levels,
      stats: {
        atr: atrNow,
        atrPct: ind.atrPct[i] * 100,
        rsi: rsNow,
        ema20: e20,
        ema50: e50,
        ema200: ind.ema200[i],
        adx: adxNow,
        ext,
      },
    };
  }

  /* ───────────────────────── Ukuran posisi ───────────────────────────── */

  /**
   * Jumlah koin agar kerugian di stop (termasuk fee beli+jual) = riskPct% modal.
   * Spot tanpa leverage: nilai posisi dibatasi sebesar modal.
   */
  function positionSize({ capital, riskPct, entry, stop, feePct = 0.1 }) {
    if (!(capital > 0) || !(riskPct > 0) || !(entry > stop) || !(stop > 0)) return null;
    const f = feePct / 100;
    const riskAmt = capital * (riskPct / 100);
    const lossPerUnit = entry - stop + (entry + stop) * f;
    let qty = riskAmt / lossPerUnit;
    let capped = false;
    if (qty * entry > capital) {
      qty = capital / entry;
      capped = true;
    }
    const value = qty * entry;
    const lossAtStop = qty * lossPerUnit;
    return { qty, value, riskAmt, lossAtStop, effectiveRiskPct: (lossAtStop / capital) * 100, capped };
  }

  /* ──────────────────────────── Backtest ─────────────────────────────── */

  /**
   * Uji historis aturan inti: masuk di OPEN candle berikutnya setelah skor >= threshold.
   * Keluar: stop 1.5×ATR; 50% di 1.5R lalu stop geser ke entri; sisa di 3R; batas waktu `maxBars`.
   * Asumsi konservatif: bila stop dan target tersentuh di candle yang sama, stop dianggap kena lebih dulu.
   */
  function backtest(candles, opts = {}) {
    const { threshold = 35, stopAtr = 1.5, tp1R = 1.5, tp2R = 3, maxBars = 60, feePct = 0.1 } = opts;
    const ind = opts.ind || buildIndicators(candles);
    const n = candles.length;
    const start = opts.start !== undefined ? opts.start : Math.min(210, Math.floor(n * 0.4));
    const fee = feePct / 100;
    const trades = [];
    for (let i = start; i < n - 1; i++) {
      const s = scoreAt(ind, i);
      if (!s || s.total < threshold) continue;
      const a = ind.atr[i];
      if (!(a > 0)) continue;
      const entry = ind.open[i + 1];
      const risk = stopAtr * a;
      const stop0 = entry - risk;
      const tp1 = entry + tp1R * risk;
      const tp2 = entry + tp2R * risk;
      let remaining = 1;
      let r = 0;
      let stopPx = stop0;
      let tp1Hit = false;
      let exit = -1;
      for (let j = i + 1; j < n; j++) {
        const lo = ind.low[j];
        const hi = ind.high[j];
        if (lo <= stopPx) {
          const fill = Math.min(ind.open[j], stopPx);
          r += (remaining * (fill - entry)) / risk;
          remaining = 0;
          exit = j;
          break;
        }
        if (!tp1Hit && hi >= tp1) {
          r += 0.5 * tp1R;
          remaining = 0.5;
          tp1Hit = true;
          stopPx = entry;
          if (lo <= entry) {
            // urutan intrabar tak diketahui → anggap sisa keluar di titik impas
            remaining = 0;
            exit = j;
            break;
          }
        }
        if (tp1Hit && hi >= tp2) {
          r += remaining * tp2R;
          remaining = 0;
          exit = j;
          break;
        }
        if (j - (i + 1) >= maxBars - 1) {
          r += (remaining * (ind.close[j] - entry)) / risk;
          remaining = 0;
          exit = j;
          break;
        }
      }
      if (exit < 0) break; // posisi belum selesai di ujung data → tidak dihitung
      r -= (2 * fee * entry) / risk;
      trades.push({ entryIdx: i + 1, exitIdx: exit, r, bars: exit - (i + 1) + 1 });
      i = exit; // tidak ada posisi tumpang tindih
    }
    const nT = trades.length;
    const wins = trades.filter((t) => t.r > 0);
    const losses = trades.filter((t) => t.r <= 0);
    const totalR = trades.reduce((s, t) => s + t.r, 0);
    const grossW = wins.reduce((s, t) => s + t.r, 0);
    const grossL = -losses.reduce((s, t) => s + t.r, 0);
    let peak = 0;
    let eq = 0;
    let maxDD = 0;
    for (const t of trades) {
      eq += t.r;
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, peak - eq);
    }
    const bhStart = ind.close[start];
    const bhEnd = ind.close[n - 1];
    return {
      trades: nT,
      winRate: nT ? wins.length / nT : NaN,
      avgR: nT ? totalR / nT : NaN,
      totalR,
      profitFactor: grossL > 0 ? grossW / grossL : nT && grossW > 0 ? Infinity : NaN,
      maxDrawdownR: maxDD,
      avgBars: nT ? trades.reduce((s, t) => s + t.bars, 0) / nT : NaN,
      buyHoldPct: ((bhEnd - bhStart) / bhStart) * 100,
      bars: n - start,
      list: trades,
    };
  }

  return {
    sma, ema, rsi, macd, bollinger, atr, adx, trueRange, percentileRank,
    buildIndicators, findLevels, scoreAt, analyze, positionSize, backtest,
    fmtPrice, pct, LEVELS, BASE_WEIGHTS, MIN_BARS,
  };
});
