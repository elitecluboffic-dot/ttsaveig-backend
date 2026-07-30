import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ttdl, igdl } from 'btch-downloader';

/* =========================================================
   TTSAVEIG BACKEND — versi Cloudflare Workers (Hono)
   Project terpisah dari frontend (frontend ada di Worker lain,
   folder ttsaveig/, di telehub.web.id/ttsaveig).

   Kenapa pindah dari Express ke Hono:
   - Express (lib/express.js) melakukan require('body-parser') di
     level teratas modul, walaupun kita tidak pernah memanggil
     express.json(). body-parser -> raw-body -> iconv-lite, dan
     iconv-lite memanggil require_streams(...) dari polyfill
     node:stream milik nodejs_compat, yang belum didukung penuh oleh
     Cloudflare Workers (error saat deploy: "require_streams(...) is
     not a function"). Middleware manual pun tidak menolong karena
     masalahnya ada di import express itu sendiri, bukan di
     middleware-nya.
   - Hono dibangun khusus untuk runtime Workers/edge, tidak menyentuh
     node:stream, iconv-lite, atau body-parser sama sekali. Tidak
     perlu httpServerHandler / cloudflare:node / app.listen() lagi —
     Hono langsung export default { fetch }.

   Environment variable (ALLOWED_ORIGIN) tetap diatur lewat "vars" di
   wrangler.jsonc / `wrangler secret put`, dan diakses lewat c.env,
   BUKAN process.env (di Hono, env per-request lewat context, lebih
   idiomatis untuk Workers dibanding process.env ala Node).
========================================================= */

const app = new Hono();

// ---------- CORS ----------
// origin di-resolve per-request supaya bisa baca c.env.ALLOWED_ORIGIN
app.use('*', async (c, next) => {
  const allowedOrigins = (c.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const corsMiddleware = cors({
    origin: (origin) => {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return origin || '*';
      }
      return null; // ditolak
    },
  });

  return corsMiddleware(c, next);
});

// ---------- Rate limiter sederhana (in-memory, per-isolate) ----------
// Catatan: Workers bisa jalan di banyak isolate paralel, jadi ini
// bukan rate limit yang 100% akurat secara global seperti versi
// express-rate-limit di server Node biasa. Untuk rate limit yang
// benar-benar akurat lintas edge, idealnya pakai Cloudflare KV /
// Durable Objects / Cloudflare Rate Limiting binding. Versi di bawah
// ini cukup untuk proteksi dasar per-isolate.
function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map(); // key -> { count, resetAt }

  return async (c, next) => {
    const ip =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-forwarded-for') ||
      'unknown';
    const now = Date.now();
    const entry = hits.get(ip);

    if (!entry || now > entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      return c.json(message, 429);
    }

    entry.count += 1;
    return next();
  };
}

const globalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: 'Terlalu banyak request, coba lagi sebentar lagi.' },
});
app.use('*', globalLimiter);

const downloadLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, message: 'Terlalu banyak permintaan unduh, coba lagi sebentar lagi.' },
});

// ---------- Health check ----------
app.get('/health', (c) => c.text('OK', 200));

// ---------- Helper functions (persis logika lama) ----------
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

// ---------- Endpoint utama ----------
app.post('/api/download', downloadLimiter, async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: 'Body request bukan JSON yang valid.' }, 400);
  }

  const { url, platform, quality, removeWatermark } = body || {};

  if (!url || !platform) {
    return c.json({ success: false, message: 'url dan platform wajib diisi.' }, 400);
  }
  if (platform !== 'tiktok' && platform !== 'instagram') {
    return c.json({ success: false, message: 'platform harus "tiktok" atau "instagram".' }, 400);
  }
  if (!isValidPlatformUrl(url, platform)) {
    return c.json(
      {
        success: false,
        message: `Link ini bukan link ${platform === 'tiktok' ? 'TikTok' : 'Instagram'} yang valid.`,
      },
      400
    );
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
      return c.json(
        {
          success: false,
          message: 'Video tidak ditemukan. Pastikan link publik (bukan akun privat) dan masih tersedia.',
        },
        404
      );
    }

    return c.json({
      success: true,
      data: {
        ...normalized,
        removeWatermark: !!removeWatermark,
      },
    });
  } catch (err) {
    console.error('[/api/download] error:', err);
    return c.json(
      {
        success: false,
        message: 'Gagal memproses link ini sekarang. Coba lagi beberapa saat lagi.',
      },
      500
    );
  }
});

// ---------- 404 handler ----------
app.notFound((c) => c.json({ success: false, message: 'Endpoint tidak ditemukan.' }, 404));

export default app;
