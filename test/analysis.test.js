// Jalankan: node test/analysis.test.js
const assert = require('assert');
const A = require('../analysis.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name, '\n      ', e.message); process.exitCode = 1; }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (tol ${tol})`);

// Deret acak deterministik (LCG) — sama persis dengan referensi Python di test/reference.py
function series(n, seed = 42) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o * (1 + (rnd() - 0.48) * 0.04);
    const h = Math.max(o, c) * (1 + rnd() * 0.01);
    const l = Math.min(o, c) * (1 - rnd() * 0.01);
    out.push({ t: i * 3600000, o, h, l, c, v: 100 + rnd() * 900 });
    p = c;
  }
  return out;
}

console.log('Indikator');
test('SMA benar', () => {
  const r = A.sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(r[1]));
  assert.deepStrictEqual(r.slice(2), [2, 3, 4]);
});
test('EMA diseed SMA & rumus rekursif', () => {
  const r = A.ema([1, 2, 3, 4, 5], 3);
  assert.strictEqual(r[2], 2);
  assert.strictEqual(r[3], 3);
  assert.strictEqual(r[4], 4);
});
test('EMA tahan input berawalan NaN', () => {
  const r = A.ema([NaN, NaN, 1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(r[3]));
  assert.strictEqual(r[4], 2);
});
test('RSI Wilder cocok dengan contoh klasik StockCharts', () => {
  const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826,
    45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122,
    46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314];
  const r = A.rsi(closes, 14);
  const expected = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77];
  expected.forEach((e, k) => near(r[14 + k], e, 0.06, `RSI[${14 + k}]`));
});
test('RSI: naik terus = 100, turun terus = 0, datar = 50', () => {
  assert.strictEqual(A.rsi(Array.from({ length: 30 }, (_, i) => i + 1))[29], 100);
  assert.strictEqual(A.rsi(Array.from({ length: 30 }, (_, i) => 100 - i))[29], 0);
  assert.strictEqual(A.rsi(new Array(30).fill(5))[29], 50);
});
test('Bollinger: harga datar → band menyempit, %B = 0.5', () => {
  const b = A.bollinger(new Array(30).fill(10));
  assert.strictEqual(b.upper[29], 10);
  assert.strictEqual(b.pctB[29], 0.5);
});
test('ATR: range konstan 2 → ATR = 2', () => {
  const n = 40;
  const h = Array.from({ length: n }, () => 12), l = Array.from({ length: n }, () => 10), c = Array.from({ length: n }, () => 11);
  const a = A.atr(h, l, c, 14);
  assert.ok(Number.isNaN(a[13]));
  near(a[39], 2, 1e-12);
});
test('ADX: tren naik mulus → ADX tinggi, DI+ > DI−', () => {
  const n = 80;
  const c = Array.from({ length: n }, (_, i) => 100 + i);
  const h = c.map((x) => x + 1), l = c.map((x) => x - 1);
  const r = A.adx(h, l, c, 14);
  assert.ok(r.adx[n - 1] > 90, `adx=${r.adx[n - 1]}`);
  assert.ok(r.pdi[n - 1] > r.mdi[n - 1]);
});
test('Semua indikator kausal (menambah candle baru tak mengubah nilai lama)', () => {
  const cs = series(400);
  const a = A.buildIndicators(cs);
  const b = A.buildIndicators(cs.slice(0, 300));
  for (const key of ['ema20', 'ema50', 'ema200', 'rsi', 'atr']) {
    for (let i = 0; i < 300; i++) {
      const x = a[key][i], y = b[key][i];
      assert.ok((Number.isNaN(x) && Number.isNaN(y)) || Math.abs(x - y) < 1e-9, `${key}[${i}]`);
    }
  }
  for (let i = 0; i < 300; i++) {
    const x = a.adx.adx[i], y = b.adx.adx[i];
    assert.ok((Number.isNaN(x) && Number.isNaN(y)) || Math.abs(x - y) < 1e-9, `adx[${i}]`);
  }
});

console.log('Skor & analisis');
test('Skor selalu di rentang −100..100 dan bobot berjumlah 1', () => {
  const cs = series(500, 7);
  const ind = A.buildIndicators(cs);
  for (let i = 60; i < 500; i++) {
    const s = A.scoreAt(ind, i);
    assert.ok(s.total >= -100 && s.total <= 100, `skor ${s.total}`);
    near(s.factors.reduce((x, f) => x + f.share, 0), 1, 1e-9);
  }
});
test('Tren naik kuat → bias beli; tren turun kuat → bias jual', () => {
  const up = Array.from({ length: 300 }, (_, i) => {
    const c = 100 * Math.exp(0.004 * i) * (1 + 0.004 * Math.sin(i / 2));
    return { t: i, o: c * 0.998, h: c * 1.004, l: c * 0.995, c, v: 100 + (i % 7) };
  });
  const down = up.map((x, i) => { const c = 400 / Math.exp(0.004 * i) * (1 + 0.004 * Math.sin(i / 2)); return { t: i, o: c * 1.002, h: c * 1.005, l: c * 0.996, c, v: 100 + (i % 7) }; });
  const a = A.analyze(up), b = A.analyze(down);
  assert.ok(a.ok && b.ok);
  assert.ok(a.score.total > 15, `up total=${a.score.total}`);
  assert.ok(b.score.total < -15, `down total=${b.score.total}`);
});
test('Data kurang dari minimum ditolak dengan pesan jelas', () => {
  const r = A.analyze(series(30));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /terlalu sedikit/);
});
test('Rencana beli konsisten: stop < entri < TP1 < TP2, RR 1.5 dan 3', () => {
  let found = 0;
  for (let seed = 1; seed <= 60 && found < 5; seed++) {
    const r = A.analyze(series(400, seed));
    if (!r.ok || !r.plan) continue;
    found++;
    const p = r.plan;
    assert.ok(p.stop < p.entry && p.entry < p.tp1 && p.tp1 < p.tp2);
    near((p.tp1 - p.entry) / (p.entry - p.stop), 1.5, 1e-9);
    near((p.tp2 - p.entry) / (p.entry - p.stop), 3, 1e-9);
    assert.ok(r.level > 0);
  }
  assert.ok(found > 0, 'tidak ada seed yang menghasilkan rencana beli');
});
test('Timeframe lebih tinggi bearish menurunkan level sinyal beli', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const cs = series(400, seed);
    const base = A.analyze(cs);
    if (!base.ok || base.baseLevel < 1) continue;
    const r = A.analyze(cs, { htf: { total: -50 } });
    assert.ok(r.level < base.level || r.level === 0, 'level harus turun');
    return;
  }
  assert.fail('tidak menemukan contoh sinyal beli');
});
test('Support/resistance: support di bawah harga, resistance di atas', () => {
  const cs = series(400, 3);
  const r = A.analyze(cs);
  r.levels.supports.forEach((s) => assert.ok(s.price < r.price));
  r.levels.resistances.forEach((s) => assert.ok(s.price > r.price));
});

console.log('Ukuran posisi');
test('Rugi di stop = tepat risiko yang ditargetkan (termasuk fee)', () => {
  const r = A.positionSize({ capital: 1000, riskPct: 1, entry: 100, stop: 95, feePct: 0.1 });
  near(r.lossAtStop, 10, 1e-9);
  assert.strictEqual(r.capped, false);
  near(r.qty * (100 - 95) + r.qty * (100 + 95) * 0.001, 10, 1e-9);
});
test('Spot tanpa leverage: nilai posisi dibatasi modal', () => {
  const r = A.positionSize({ capital: 1000, riskPct: 5, entry: 100, stop: 99 });
  assert.strictEqual(r.capped, true);
  near(r.value, 1000, 1e-9);
  assert.ok(r.effectiveRiskPct < 5);
});
test('Input tak valid → null', () => {
  assert.strictEqual(A.positionSize({ capital: 0, riskPct: 1, entry: 100, stop: 95 }), null);
  assert.strictEqual(A.positionSize({ capital: 100, riskPct: 1, entry: 95, stop: 100 }), null);
});

console.log('Backtest');
test('Backtest deterministik & hasil konsisten', () => {
  const cs = series(900, 11);
  const a = A.backtest(cs), b = A.backtest(cs);
  assert.deepStrictEqual(a.trades, b.trades);
  assert.ok(a.trades >= 0);
  if (a.trades) {
    near(a.avgR * a.trades, a.totalR, 1e-9);
    assert.ok(a.winRate >= 0 && a.winRate <= 1);
  }
});
test('Backtest tanpa kebocoran masa depan: mengubah candle SETELAH sinyal tak mengubah trade sebelumnya', () => {
  const cs = series(900, 5);
  const full = A.backtest(cs, { start: 210 });
  assert.ok(full.trades > 0, 'butuh minimal satu trade untuk uji ini');
  const cut = full.list[Math.floor(full.list.length / 2)];
  const mutated = cs.map((x, i) => (i > cut.exitIdx ? { ...x, o: x.o * 3, h: x.h * 3, l: x.l * 3, c: x.c * 3 } : x));
  const re = A.backtest(mutated, { start: 210 });
  const before = full.list.filter((t) => t.exitIdx <= cut.exitIdx);
  assert.deepStrictEqual(re.list.slice(0, before.length), before);
});
test('Stop kena dulu bila stop & target tersentuh di candle yang sama (konservatif)', () => {
  // candle naik stabil 300 bar, lalu satu candle ekstrem menyentuh stop dan TP sekaligus
  const base = Array.from({ length: 300 }, (_, i) => { const c = 100 * Math.exp(0.003 * i); return { t: i, o: c * 0.999, h: c * 1.003, l: c * 0.997, c, v: 100 }; });
  const ind = A.buildIndicators(base);
  const sig = A.scoreAt(ind, 299);
  assert.ok(sig && sig.total >= 35, `sinyal beli dibutuhkan, total=${sig && sig.total}`);
  const entry = base[299].c;
  base.push({ t: 300, o: entry, h: entry * 1.5, l: entry * 0.5, c: entry, v: 100 }, { t: 301, o: entry, h: entry, l: entry, c: entry, v: 100 });
  const r = A.backtest(base, { start: 299, ind: A.buildIndicators(base) });
  assert.ok(r.trades >= 1);
  assert.ok(r.list[0].r < -0.9, `r=${r.list[0].r}`);
});

console.log(`\n${passed} tes lulus${process.exitCode ? ' — ADA YANG GAGAL' : ''}`);
