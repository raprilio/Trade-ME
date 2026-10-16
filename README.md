# Trade-ME

Aplikasi analisis teknikal crypto yang sederhana: **SOL, BTC, ETH**, dan koin apa pun yang punya pair `/USDT` di Binance/OKX.
Tanpa server, tanpa API key, tanpa instalasi — semua perhitungan berjalan di browser.

## Menjalankan

Buka `index.html` di browser, atau:

```bash
python3 -m http.server 8000   # lalu buka http://localhost:8000
```

Butuh koneksi internet (data harga publik: Binance → cadangan Binance API → OKX).
Kalau Binance diblokir di jaringan/negaramu, aplikasi otomatis pindah ke OKX.

## Yang ditampilkan

| Bagian | Isi |
|---|---|
| Verdict | `BELI` · `CONDONG BELI` · `TUNGGU` · `CONDONG JUAL` · `JUAL / HINDARI`, skor −100…+100, keyakinan |
| Saran | Teks yang menyesuaikan kondisi: jenuh beli/jual, sideways vs trending, volatilitas, squeeze, volume sepi, resistance dekat, timeframe lebih tinggi |
| Rencana (spot) | Entri (market atau limit saat pullback), stop-loss (di bawah support atau 1.5×ATR), target 1.5R & 3R |
| Ukuran posisi | Dari modal & % risiko; menghitung fee 0.1% per sisi; dibatasi sebesar modal (tanpa leverage) |
| Grafik | Candle, EMA20/50, support/resistance, entri/stop/target |
| Backtest | Aturan yang sama diuji di ±1000 candle terakhir koin & timeframe yang dipilih |

## Cara skor dihitung

Enam faktor, bobot dasar: tren EMA 30, MACD 20, RSI 20, Bollinger 10, tekanan volume 10, ADX/DI 10.
Bobot disesuaikan rezim pasar (ADX ≥ 25 trending → sinyal tren dinaikkan; ADX < 20 sideways → sinyal pembalikan dinaikkan).
Level diturunkan bila: RSI ≥ 75 / harga ≥ 3×ATR di atas EMA20 (jangan kejar), timeframe lebih tinggi berlawanan, atau resistance terlalu dekat (< 1R).
Semua bobot dan skor per faktor ditampilkan di halaman — tidak ada kotak hitam.

## Soal akurasi

- **Perhitungan** indikator dicocokkan dengan TA-Lib (EMA, RSI, ATR, Bollinger identik hingga ~1e-13; MACD & ADX beda hanya di warm-up awal karena konvensi seed, menyusut hingga <1e-8). RSI juga dicek terhadap contoh klasik StockCharts.
- Sinyal hanya memakai **candle yang sudah tutup** (harga live dipakai hanya untuk entri/tampilan).
- Backtest tidak mengintip masa depan (ada tesnya), masuk di open candle berikutnya, fee dihitung, dan bila stop & target kena di candle yang sama → stop dianggap kena lebih dulu.
- **Ramalan harga tidak akurat oleh siapa pun**, termasuk aplikasi ini. Di data nyata (SOL/BTC, 15m–1d), aturan inti ini kira-kira impas sampai negatif setelah fee. Itu sebabnya halaman menampilkan hasil backtest di samping saran, dan menurunkan keyakinan bila backtest negatif.

## Tes

```bash
node test/analysis.test.js
```

## Bukan nasihat keuangan
Alat bantu analisis berbasis aturan, bukan prediksi. Gunakan stop-loss dan hanya uang yang siap hilang.
