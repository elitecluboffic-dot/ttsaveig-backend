import { httpServerHandler } from 'cloudflare:node';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ttdl, igdl } from 'btch-downloader';

/* =========================================================
   TTSAVEIG BACKEND — versi Cloudflare Workers
   Project terpisah dari frontend (frontend ada di Worker lain,
   folder ttsaveig/, di telehub.web.id/ttsaveig).

   Beda dari versi Node.js/Railway biasa:
   - Tidak pakai app.listen(PORT) + dotenv seperti server biasa.
     Di Workers, port di app.listen() cuma dipakai secara internal
     oleh httpServerHandler, tidak benar-benar "membuka port" ke
     luar seperti di VPS.
   - Environment variable (ALLOWED_ORIGIN) diatur lewat "vars" di
     wrangler.jsonc / `wrangler secret put`, BUKAN file .env — dan
     otomatis muncul di process.env berkat nodejs_compat.
   - WAJIB compatibility_date 2025-08-15 atau lebih baru, dan
     compatibility_flags: ["nodejs_compat"] di wrangler.jsonc.
========================================================= */

const app = express();

const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error('Origin tidak diizinkan oleh CORS'));
    },
  })
);

// PENTING: sengaja TIDAK pakai express.json() bawaan.
// express.json() -> body-parser -> raw-body -> iconv-lite, dan iconv-lite
// memakai modul node:stream dengan cara yang belum didukung penuh oleh
// polyfill nodejs_compat di Cloudflare Workers (error saat deploy:
// "require_streams(...) is not a function"). Middleware manual di bawah
// ini melakukan hal yang sama (baca body, parse JSON) tanpa dependency
// yang bermasalah tersebut.
function parseJsonBody(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
    return next();
  }
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    if (!raw) {
      req.body = {};
      return next();
    }
    try {
      req.body = JSON.parse(raw);
      next();
    } catch {
      res.status(400).json({ success: false, message: 'Body request bukan JSON yang valid.' });
    }
  });
  req.on('error', () => {
    res.status(400).json({ success: false, message: 'Gagal membaca body request.' });
  });
}

app.use(parseJsonBody);

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak request, coba lagi sebentar lagi.' },
});
app.use(globalLimiter);

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak permintaan unduh, coba lagi sebentar lagi.' },
});

app.get('/health', (req, res) => res.status(200).send('OK'));

function isValidPlatformUrl(url, platform) {
  try {
    const { hostname } = new URL(url);
    const host = hostname.replace(/^www\./, '');
    if (platform === 'tiktok') {
      return (
        /(^|\.)tiktok\.com$/.test(host) ||
        /(^|\.)vt\.tiktok\.com$/.test(host) ||
        /(^|\.)vm\.tiktok\.com$/.test(host)
      );
    }
    if (platform === 'instagram') {
      return /(^|\.)instagram\.com$/.test(host);
    }
    return false;
  } catch {
    return false;
  }
}

function pickFirst(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key]) return obj[key];
  }
  return null;
}

function normalizeTikTok(raw, wantAudioOnly) {
  const item = Array.isArray(raw) ? raw[0] : raw;
  if (!item) return null;

  const noWatermarkUrl = pickFirst(item, ['video', 'play', 'nowm', 'no_watermark', 'hd', 'video_hd']);
  const audioUrl = pickFirst(item, ['audio', 'music', 'mp3']);
  const thumbnail = pickFirst(item, ['thumbnail', 'cover', 'image']);
  const title = pickFirst(item, ['title', 'desc', 'caption']);
  const author = pickFirst(item, ['author', 'username', 'nickname']);

  const downloadUrl = Array.isArray(noWatermarkUrl) ? noWatermarkUrl[0] : noWatermarkUrl;
  const resolvedAudioUrl = Array.isArray(audioUrl) ? audioUrl[0] : audioUrl;

  if (!downloadUrl && !resolvedAudioUrl) return null;

  return {
    title: title || 'Video TikTok',
    author: author || '',
    thumbnail: Array.isArray(thumbnail) ? thumbnail[0] : thumbnail || '',
    downloadUrl: wantAudioOnly ? null : downloadUrl || null,
    audioUrl: resolvedAudioUrl || null,
  };
}

function normalizeInstagram(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const item = list.find((i) => pickFirst(i, ['url', 'video', 'download_url', 'play']));
  if (!item) return null;

  const downloadUrl = pickFirst(item, ['url', 'video', 'download_url', 'play']);
  const thumbnail = pickFirst(item, ['thumbnail', 'cover', 'image']);
  const title = pickFirst(item, ['title', 'caption', 'desc']);
  const author = pickFirst(item, ['author', 'username']);

  return {
    title: title || 'Video/Foto Instagram',
    author: author || '',
    thumbnail: Array.isArray(thumbnail) ? thumbnail[0] : thumbnail || '',
    downloadUrl: Array.isArray(downloadUrl) ? downloadUrl[0] : downloadUrl,
    audioUrl: null,
  };
}

app.post('/api/download', downloadLimiter, async (req, res) => {
  const { url, platform, quality, removeWatermark } = req.body || {};

  if (!url || !platform) {
    return res.status(400).json({ success: false, message: 'url dan platform wajib diisi.' });
  }
  if (platform !== 'tiktok' && platform !== 'instagram') {
    return res.status(400).json({ success: false, message: 'platform harus "tiktok" atau "instagram".' });
  }
  if (!isValidPlatformUrl(url, platform)) {
    return res.status(400).json({
      success: false,
      message: `Link ini bukan link ${platform === 'tiktok' ? 'TikTok' : 'Instagram'} yang valid.`,
    });
  }

  const wantAudioOnly = quality === 'audio';

  try {
    let normalized = null;

    if (platform === 'tiktok') {
      const raw = await ttdl(url);
      normalized = normalizeTikTok(raw, wantAudioOnly);
    } else {
      const raw = await igdl(url);
      normalized = normalizeInstagram(raw);
    }

    if (!normalized || (!normalized.downloadUrl && !normalized.audioUrl)) {
      return res.status(404).json({
        success: false,
        message: 'Video tidak ditemukan. Pastikan link publik (bukan akun privat) dan masih tersedia.',
      });
    }

    res.json({
      success: true,
      data: {
        ...normalized,
        removeWatermark: !!removeWatermark,
      },
    });
  } catch (err) {
    console.error('[/api/download] error:', err);
    res.status(500).json({
      success: false,
      message: 'Gagal memproses link ini sekarang. Coba lagi beberapa saat lagi.',
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan.' });
});

// Port di sini murni internal (dipakai httpServerHandler untuk
// menyambungkan request Workers ke instance Express-nya) — BUKAN
// port publik yang perlu kamu buka/atur di mana pun.
app.listen(8080);

export default httpServerHandler({ port: 8080 });
