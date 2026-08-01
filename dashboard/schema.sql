-- schema.sql
-- Skema database D1 untuk tracking klik tombol "Ambil Video/Gambar".
--
-- Cara jalankan (dari folder project backend, sejajar dengan wrangler.toml):
--   Lokal (buat testing lewat `wrangler dev`):
--     wrangler d1 execute ttsaveig-tracking --local --file=./schema.sql
--
--   Production (database asli yang dipakai Worker yang sudah deploy):
--     wrangler d1 execute ttsaveig-tracking --remote --file=./schema.sql
--
-- (Ganti "ttsaveig-tracking" kalau nama database D1 kamu beda.)

CREATE TABLE IF NOT EXISTS click_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,               -- 'tiktok' | 'instagram' | 'pinterest'
  ip TEXT,                              -- dari header cf-connecting-ip
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index biar query GROUP BY platform dan filter tanggal tetap cepat
-- walau datanya sudah banyak.
CREATE INDEX IF NOT EXISTS idx_click_events_platform ON click_events (platform);
CREATE INDEX IF NOT EXISTS idx_click_events_created_at ON click_events (created_at);
