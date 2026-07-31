import { Hono } from 'hono';
import { cors } from 'hono/cors';

/* =========================================================
   TTSAVEIG BACKEND — versi Cloudflare Workers (Hono)
   Project terpisah dari frontend (frontend ada di Worker lain,
   folder ttsaveig/, di telehub.web.id/ttsaveig).

   RIWAYAT PERBAIKAN:
   1) Awalnya pakai Express -> gagal deploy karena Express selalu
      menarik body-parser -> raw-body -> iconv-lite di level modul,
      dan iconv-lite memanggil require_streams(...) yang belum
      didukung penuh oleh polyfill nodejs_compat Cloudflare.
      -> Solusi: pindah ke Hono, yang memang dibuat untuk runtime
      Workers/edge dan tidak menyentuh node:stream sama sekali.

   2) Setelah pindah ke Hono, muncul error baru: "Dynamic require of
      axios is not supported". Ini datang dari package btch-downloader
      (dan dependency internalnya, btch-http), yang pakai axios dengan
      pola require() yang tidak bisa dibundel esbuild untuk Workers.
      -> Solusi: HAPUS btch-downloader sepenuhnya. Setelah ditelusuri,
      ternyata btch-downloader cuma pembungkus tipis di atas backend
      HTTP publik di https://backend1.tioo.eu.org — versi browser dari
      library ini bahkan cuma pakai fetch() biasa, tanpa axios sama
      sekali. Jadi endpoint itu kita panggil langsung di bawah ini,
      tanpa dependency pihak ketiga yang bermasalah.

   3) Ditambahkan endpoint /api/proxy supaya URL video asli dari
      server sumber (mis. dl.tiktokio.com) tidak terlihat langsung
      oleh browser user. Semua byte video sekarang melewati Worker
      ini dulu sebelum sampai ke browser.

   4) /api/proxy diperbaiki: link sumber (mis. dl.tiktokio.com) pakai
      token sekali-pakai, sedangkan tag <video> di browser mengirim
      beberapa request Range terpisah -> tiap request lama memicu
      fetch BARU ke sumber -> request kedua dst gagal (404) karena
      token sudah "dipakai". Sekarang: fetch ke sumber HANYA SEKALI
      (tanpa meneruskan Range ke upstream), hasilnya disimpan di
      Cloudflare Cache API per targetUrl, lalu semua request Range
      dari browser dilayani dari cache tsb.

   Catatan: backend1.tioo.eu.org adalah layanan pihak ketiga yang tidak
   dioperasikan oleh kita. Kalau suatu saat mereka mengubah format
   respons atau endpoint-nya, fungsi ttdl()/igdl() di bawah ini perlu
   disesuaikan lagi.
========================================================= */

const app = new Hono();

// ---------- CORS ----------
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
      return null;
    },
  });

  return corsMiddleware(c, next);
});

// ---------- Rate limiter sederhana (in-memory, per-isolate) ----------
// Catatan: bukan rate limit yang 100% akurat secara global di Workers
// (isolate bisa paralel), tapi cukup untuk proteksi dasar.
function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();

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

// ---------- Klien backend (pengganti btch-downloader) ----------
// Persis pola yang dipakai versi browser resmi btch-downloader:
// GET https://backend1.tioo.eu.org/{endpoint}?url={url}
const BTCH_BASE_URL = 'https://backend1.tioo.eu.org';

async function btchGet(endpoint, url) {
  const target = `${BTCH_BASE_URL}/${endpoint}?url=${encodeURIComponent(url)}`;
  const res = await fetch(target, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ttsaveig-backend)' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: request ke backend gagal`);
  }
  try {
    return await res.json();
  } catch {
    return await res.text();
  }
}

// Bentuk respons mentah TikTok: { title, title_audio, thumbnail, video: [...], audio: [...] }
async function ttdl(url) {
  return btchGet('ttdl', url);
}

// Bentuk respons mentah Instagram: array [{ thumbnail, url }, ...]
async function igdl(url) {
  return btchGet('igdl', url);
}

// ---------- Helper functions ----------
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
  if (!raw) return null;

  // raw.video dan raw.audio adalah array URL (sesuai bentuk asli backend)
  const videoArr = Array.isArray(raw.video) ? raw.video : raw.video ? [raw.video] : [];
  const audioArr = Array.isArray(raw.audio) ? raw.audio : raw.audio ? [raw.audio] : [];

  const downloadUrl = videoArr[0] || null;
  const resolvedAudioUrl = audioArr[0] || null;

  if (!downloadUrl && !resolvedAudioUrl) return null;

  return {
    title: raw.title || 'Video TikTok',
    author: raw.author || '',
    thumbnail: raw.thumbnail || '',
    downloadUrl: wantAudioOnly ? null : downloadUrl,
    audioUrl: resolvedAudioUrl,
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

// ---------- Whitelist host video sumber (proteksi biar Worker ini gak jadi open proxy) ----------
const ALLOWED_MEDIA_HOSTS = [
  // TikTok
  /(^|\.)tiktokcdn\.com$/,
  /(^|\.)tiktokcdn-us\.com$/,
  /(^|\.)tiktokv\.com$/,
  /(^|\.)dl\.tiktokio\.com$/,
  // Instagram
  /(^|\.)cdninstagram\.com$/,
  /(^|\.)fbcdn\.net$/,
  // backend pihak ketiga yang dipakai
  /(^|\.)tioo\.eu\.org$/,
];

function isAllowedMediaUrl(rawUrl) {
  try {
    const { hostname, protocol } = new URL(rawUrl);
    if (protocol !== 'https:') return false;
    return ALLOWED_MEDIA_HOSTS.some((re) => re.test(hostname));
  } catch {
    return false;
  }
}

// ---------- Endpoint proxy media (versi diperbaiki) ----------
// Masalah sebelumnya: link sumber (mis. dl.tiktokio.com) pakai token
// sekali-pakai. Tag <video> di browser kirim beberapa request Range
// terpisah, dan tiap request itu men-trigger fetch BARU ke sumber ->
// request kedua dst gagal (404) karena token sudah "dipakai".
//
// Perbaikan: fetch ke sumber HANYA SEKALI, simpan hasilnya di Cloudflare
// Cache API (per targetUrl, bukan per Range), lalu semua request Range
// dari browser dilayani dari cache tsb, bukan fetch ulang ke sumber.
app.get('/api/proxy', async (c) => {
  const targetUrl = c.req.query('url');

  if (!targetUrl) {
    return c.json({ success: false, message: 'Parameter url wajib diisi.' }, 400);
  }
  if (!isAllowedMediaUrl(targetUrl)) {
    return c.json({ success: false, message: 'Sumber media tidak diizinkan.' }, 403);
  }

  const cache = caches.default;
  // Cache key sengaja diambil dari targetUrl saja (tanpa Range),
  // supaya semua request Range untuk video yang sama dianggap 1 entri cache.
  const cacheKey = new Request(
    `https://cache-key.internal/proxy?u=${encodeURIComponent(targetUrl)}`
  );

  let fullResponse = await cache.match(cacheKey);

  if (!fullResponse) {
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ttsaveig-backend)' },
        // sengaja TIDAK mengirim Range di sini -> selalu minta file utuh
      });
    } catch (err) {
      console.error('[/api/proxy] fetch error:', err);
      return c.json({ success: false, message: 'Gagal mengambil media dari sumber.' }, 502);
    }

    if (!upstream.ok) {
      return c.json(
        { success: false, message: `Sumber media merespons status ${upstream.status}.` },
        502
      );
    }

    const buffer = await upstream.arrayBuffer();
    const contentType = upstream.headers.get('content-type') || 'video/mp4';

    fullResponse = new Response(buffer, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(buffer.byteLength),
        'accept-ranges': 'bytes',
        // cache di edge selama 2 menit, cukup untuk satu sesi nonton preview
        'cache-control': 'public, max-age=120',
      },
    });

    c.executionCtx.waitUntil(cache.put(cacheKey, fullResponse.clone()));
  }

  const totalBuffer = await fullResponse.clone().arrayBuffer();
  const total = totalBuffer.byteLength;
  const contentType = fullResponse.headers.get('content-type') || 'video/mp4';
  const rangeHeader = c.req.header('range');

  const baseHeaders = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'content-disposition': 'inline; filename="reelgrab-video.mp4"',
  };

  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    let start = match && match[1] ? parseInt(match[1], 10) : 0;
    let end = match && match[2] ? parseInt(match[2], 10) : total - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;

    const chunk = totalBuffer.slice(start, end + 1);

    return new Response(chunk, {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': String(chunk.byteLength),
      },
    });
  }

  return new Response(totalBuffer, {
    status: 200,
    headers: {
      ...baseHeaders,
      'content-length': String(total),
    },
  });
});

// ---------- 404 handler ----------
app.notFound((c) => c.json({ success: false, message: 'Endpoint tidak ditemukan.' }, 404));

export default app;
