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

   5) FIX THUMBNAIL/GAMBAR KE-404 DI /api/proxy:
      - Root cause: /api/proxy tidak menerima method HEAD, dan tidak
        ada error handler global -> exception yang lolos try/catch
        bisa muncul sebagai 404/500 polos tanpa pesan jelas.
      - Solusi: /api/proxy sekarang menerima GET *dan* HEAD, ditambah
        app.onError() global, dan whitelist CDN diperluas untuk
        menutup lebih banyak variasi subdomain thumbnail.

   6) PINTEREST — MENGGANTIKAN X/TWITTER (update ini):
      - Dukungan X/Twitter dicabut sepenuhnya dan digantikan dengan
        Pinterest, karena backend pihak ketiga jauh lebih stabil untuk
        Pinterest dan kebutuhan user lebih sering ke arah situ.
      - pindl() mencoba BEBERAPA nama endpoint di backend pihak
        ketiga secara berurutan ('pinterest', 'pindl', 'pin'), karena
        nama fungsi resmi btch-downloader untuk Pinterest kadang beda
        antara versi lib dan versi backend HTTP-nya. Berhenti di
        percobaan pertama yang sukses (HTTP 200 & bukan JSON kosong).
      - normalizePinterest() dibuat tahan banting: mendukung bentuk
        respons sebagai object langsung, array of items, ATAU object
        berisi daftar "media"/"images"/"videos" dengan banyak kualitas
        berbeda (dipilih resolusi/bitrate tertinggi otomatis). Juga
        mendukung struktur bersarang umum di scraper Pinterest seperti
        { video: { url } }, { images: { orig: { url } } }, atau
        { url: { hd, sd } }. Pinterest sering hanya berupa gambar
        (pin foto biasa) -> kalau tidak ada video sama sekali, otomatis
        fallback ke gambar resolusi tertinggi sebagai downloadUrl.
      - Kalau SEMUA percobaan endpoint gagal atau hasil parsing tetap
        kosong, pesan error ke user dibuat lebih spesifik (beda dari
        pesan generik "video tidak ditemukan") supaya jelas bahwa
        Pinterest kemungkinan sedang tidak didukung backend pihak
        ketiga, bukan link-nya yang salah.
      - Ditambahkan log raw response (dipotong biar gak kepanjangan)
        di console.error saat parsing gagal, supaya gampang di-debug
        lewat `wrangler tail` kalau ada laporan link Pinterest yang
        gagal.
      - Whitelist host media diperbarui: *.pinimg.com (CDN gambar &
        video Pinterest) ditambahkan, *.twimg.com dicabut karena sudah
        tidak dipakai.
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
    throw new Error(`HTTP ${res.status}: request ke backend gagal (endpoint: ${endpoint})`);
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

// Pinterest: nama endpoint resmi di backend pihak ketiga belum
// terverifikasi 100% dan bisa beda antar versi -> coba beberapa
// kandidat nama secara berurutan, pakai yang pertama berhasil.
const PINTEREST_ENDPOINT_CANDIDATES = ['pinterest', 'pindl', 'pin'];

function isEmptyResult(raw) {
  if (raw == null) return true;
  if (Array.isArray(raw)) return raw.length === 0;
  if (typeof raw === 'object') return Object.keys(raw).length === 0;
  if (typeof raw === 'string') return raw.trim().length === 0;
  return false;
}

async function pindl(url) {
  const errors = [];

  for (const endpoint of PINTEREST_ENDPOINT_CANDIDATES) {
    try {
      const raw = await btchGet(endpoint, url);
      if (!isEmptyResult(raw)) {
        return raw;
      }
      errors.push(`${endpoint}: respons kosong`);
    } catch (err) {
      errors.push(`${endpoint}: ${err.message}`);
    }
  }

  // Semua kandidat endpoint gagal -> lempar error gabungan supaya
  // ketahuan di log endpoint mana saja yang sudah dicoba.
  throw new Error(`Semua endpoint Pinterest gagal -> ${errors.join(' | ')}`);
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
    if (platform === 'pinterest') {
      return (
        /(^|\.)pinterest\.com$/.test(host) ||
        /(^|\.)pinterest\.[a-z.]+$/.test(host) || // domain regional, mis. pinterest.co.uk, pinterest.de
        /(^|\.)pin\.it$/.test(host)
      );
    }
    return false;
  } catch {
    return false;
  }
}

function pickFirst(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return null;
}

// Ambil string URL dari sebuah nilai yang bisa berupa: string biasa,
// array of string, atau object bersarang seperti { hd, sd } / { url }.
function unwrapUrlValue(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = unwrapUrlValue(v);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    return (
      unwrapUrlValue(value.hd) ||
      unwrapUrlValue(value.sd) ||
      unwrapUrlValue(value.orig) ||
      unwrapUrlValue(value.original) ||
      unwrapUrlValue(value.url) ||
      unwrapUrlValue(value.link) ||
      null
    );
  }
  return null;
}

function normalizeTikTok(raw, wantAudioOnly) {
  if (!raw) return null;

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

// Skor kualitas kandidat varian media Pinterest (video/gambar), dipakai
// untuk milih varian resolusi/bitrate tertinggi kalau ada beberapa.
function variantQualityScore(variant) {
  if (!variant || typeof variant !== 'object') return 0;
  const bitrate = Number(variant.bitrate) || 0;
  const quality = Number(variant.quality) || 0;
  const height = Number(variant.height) || 0;
  const width = Number(variant.width) || 0;
  // Bitrate paling representatif buat video, fallback ke quality atau
  // resolusi (height x width) kalau bitrate tidak ada -> ini juga
  // cocok dipakai buat bandingin ukuran gambar Pinterest (orig vs 236x dst).
  return bitrate || quality * 1000 || height * width || 0;
}

// Cari daftar varian video/gambar Pinterest di berbagai kemungkinan
// struktur response (video_list, images multi-resolusi, dst).
function extractPinterestVariants(item) {
  const candidates = pickFirst(item, [
    'variants',
    'media',
    'medias',
    'videos',
    'video_list',
    'video_versions',
    'formats',
  ]);
  if (Array.isArray(candidates) && candidates.length) return candidates;

  // Kadang video ada di dalam item.video.variants atau item.media.videos
  const nestedVideo = item && (item.video || item.media);
  if (nestedVideo && typeof nestedVideo === 'object') {
    const nested = pickFirst(nestedVideo, ['variants', 'videos', 'formats', 'video_list']);
    if (Array.isArray(nested) && nested.length) return nested;
  }

  return [];
}

// Cari daftar varian GAMBAR Pinterest kalau pin-nya berupa foto biasa
// (bukan video). Banyak scraper Pinterest mengembalikan objek "images"
// berisi beberapa resolusi, mis. { orig, "736x", "236x" }.
function extractPinterestImages(item) {
  const imagesObj = pickFirst(item, ['images', 'image']);
  if (!imagesObj) return [];

  if (typeof imagesObj === 'string') return [{ url: imagesObj }];

  if (typeof imagesObj === 'object' && !Array.isArray(imagesObj)) {
    // Object berisi beberapa key resolusi -> ubah jadi array supaya
    // bisa diskor & disortir sama seperti varian video.
    return Object.entries(imagesObj).map(([key, val]) => {
      const url = unwrapUrlValue(val);
      const dims = /(\d+)x(\d+)?/.exec(key) || [];
      return {
        url,
        width: val && val.width ? Number(val.width) : dims[1] ? Number(dims[1]) : 0,
        height: val && val.height ? Number(val.height) : dims[2] ? Number(dims[2]) : 0,
        // "orig" dianggap resolusi tertinggi
        quality: key === 'orig' || key === 'original' ? 99999 : 0,
      };
    });
  }

  if (Array.isArray(imagesObj)) return imagesObj;

  return [];
}

// Parser fleksibel untuk Pinterest — dirancang untuk menangani banyak
// kemungkinan bentuk respons dari backend pihak ketiga, karena bentuk
// pastinya belum terdokumentasi resmi. Lihat catatan (6) di header.
// Pinterest bisa berupa VIDEO (pin video/idea pin) atau cuma GAMBAR
// (pin foto biasa) -> keduanya ditangani di sini.
function normalizePinterest(raw) {
  if (!raw) return null;

  // Kalau raw berupa array, ambil item pertama yang kelihatan valid.
  const item = Array.isArray(raw)
    ? raw.find((i) =>
        pickFirst(i, [
          'url',
          'video',
          'download_url',
          'media',
          'variants',
          'videos',
          'images',
          'image',
        ])
      )
    : raw;
  if (!item) return null;

  let downloadUrl = null;
  let isVideo = false;

  // Kemungkinan 1: field video/url langsung berupa string, array, atau
  // object bersarang seperti { hd, sd }.
  const directUrl = unwrapUrlValue(
    pickFirst(item, ['url', 'video', 'download_url', 'hd', 'sd'])
  );
  if (directUrl) {
    downloadUrl = directUrl;
    isVideo = /\.mp4(\?|$)/i.test(directUrl) || !!pickFirst(item, ['video', 'video_list']);
  }

  // Kemungkinan 2: ada daftar varian video kualitas berbeda -> pilih terbaik.
  if (!downloadUrl) {
    const variants = extractPinterestVariants(item);
    if (variants.length) {
      const mp4Variants = variants.filter((v) => {
        const type = (v && (v.content_type || v.type || v.mimeType)) || '';
        return !type || /mp4/i.test(type);
      });
      const pool = mp4Variants.length ? mp4Variants : variants;

      const sorted = [...pool].sort(
        (a, b) => variantQualityScore(b) - variantQualityScore(a)
      );
      downloadUrl = unwrapUrlValue(
        pickFirst(sorted[0] || {}, ['url', 'video', 'download_url', 'src'])
      );
      if (downloadUrl) isVideo = true;
    }
  }

  // Kemungkinan 3: pin tanpa video sama sekali -> fallback ke gambar
  // resolusi tertinggi yang tersedia.
  if (!downloadUrl) {
    const images = extractPinterestImages(item);
    if (images.length) {
      const sorted = [...images].sort(
        (a, b) => variantQualityScore(b) - variantQualityScore(a)
      );
      downloadUrl = unwrapUrlValue(pickFirst(sorted[0] || {}, ['url', 'src']));
      isVideo = false;
    }
  }

  if (!downloadUrl) return null;

  const thumbnail =
    unwrapUrlValue(pickFirst(item, ['thumbnail', 'cover', 'preview', 'poster'])) ||
    (!isVideo ? downloadUrl : '');
  const title = pickFirst(item, ['title', 'grid_title', 'text', 'caption', 'desc']);
  const author = pickFirst(item, ['author', 'username', 'user', 'pinner']);

  return {
    title: title || (isVideo ? 'Video Pinterest' : 'Gambar Pinterest'),
    author: author || '',
    thumbnail: thumbnail || '',
    downloadUrl,
    audioUrl: null,
    isVideo,
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
  if (!['tiktok', 'instagram', 'pinterest'].includes(platform)) {
    return c.json(
      { success: false, message: 'platform harus "tiktok", "instagram", atau "pinterest".' },
      400
    );
  }
  if (!isValidPlatformUrl(url, platform)) {
    const platformLabel =
      platform === 'tiktok' ? 'TikTok' : platform === 'instagram' ? 'Instagram' : 'Pinterest';
    return c.json(
      { success: false, message: `Link ini bukan link ${platformLabel} yang valid.` },
      400
    );
  }

  const wantAudioOnly = quality === 'audio';

  try {
    let normalized = null;

    if (platform === 'tiktok') {
      const raw = await ttdl(url);
      normalized = normalizeTikTok(raw, wantAudioOnly);
    } else if (platform === 'instagram') {
      const raw = await igdl(url);
      normalized = normalizeInstagram(raw);
    } else {
      const raw = await pindl(url);
      normalized = normalizePinterest(raw);

      if (!normalized) {
        // Log raw response (dipotong) supaya gampang di-debug lewat
        // `wrangler tail` kalau ada laporan link Pinterest yang gagal parse.
        const rawPreview = JSON.stringify(raw).slice(0, 500);
        console.error('[/api/download] gagal parse respons Pinterest:', rawPreview);
      }
    }

    if (!normalized || (!normalized.downloadUrl && !normalized.audioUrl)) {
      const message =
        platform === 'pinterest'
          ? 'Pin Pinterest tidak ditemukan atau formatnya belum didukung. Pastikan link publik dan pin masih tersedia.'
          : 'Video tidak ditemukan. Pastikan link publik (bukan akun privat) dan masih tersedia.';
      return c.json({ success: false, message }, 404);
    }

    return c.json({
      success: true,
      data: {
        ...normalized,
        removeWatermark: !!removeWatermark,
      },
    });
  } catch (err) {
    console.error(`[/api/download] error (platform=${platform}):`, err);
    return c.json(
      {
        success: false,
        message: 'Gagal memproses link ini sekarang. Coba lagi beberapa saat lagi.',
      },
      500
    );
  }
});

// ---------- Whitelist host video & thumbnail sumber ----------
// (biar Worker ini gak jadi open proxy, tapi cukup lebar buat nutup
// semua variasi subdomain CDN yang biasa dipakai buat THUMBNAIL,
// bukan cuma video-nya saja.)
const ALLOWED_MEDIA_HOSTS = [
  // TikTok - video CDN
  /(^|\.)tiktokcdn\.com$/,
  /(^|\.)tiktokcdn-us\.com$/,
  /(^|\.)tiktokcdn-eu\.com$/,
  /(^|\.)tiktokv\.com$/,
  /(^|\.)tiktokv-eu\.com$/,
  /(^|\.)dl\.tiktokio\.com$/,
  // TikTok - thumbnail/cover CDN (sering beda subdomain dari video)
  /(^|\.)ibyteimg\.com$/,
  /(^|\.)ibytedtos\.com$/,
  /(^|\.)muscdn\.com$/,
  /(^|\.)byteimg\.com$/,
  // Instagram / Facebook CDN (thumbnail & video sama-sama di sini)
  /(^|\.)cdninstagram\.com$/,
  /(^|\.)fbcdn\.net$/,
  // Pinterest - gambar & video sama-sama di *.pinimg.com (mis. i.pinimg.com,
  // v1.pinimg.com, v.pinimg.com, s.pinimg.com)
  /(^|\.)pinimg\.com$/,
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

// ---------- Handler proxy media (dipakai untuk GET & HEAD) ----------
async function handleProxy(c) {
  const targetUrl = c.req.query('url');

  if (!targetUrl) {
    return c.json({ success: false, message: 'Parameter url wajib diisi.' }, 400);
  }
  if (!isAllowedMediaUrl(targetUrl)) {
    console.warn('[/api/proxy] host ditolak whitelist:', targetUrl);
    return c.json({ success: false, message: 'Sumber media tidak diizinkan.' }, 403);
  }

  const cache = caches.default;
  const cacheKey = new Request(
    `https://cache-key.internal/proxy?u=${encodeURIComponent(targetUrl)}`
  );

  let fullResponse = await cache.match(cacheKey);

  if (!fullResponse) {
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ttsaveig-backend)' },
      });
    } catch (err) {
      console.error('[/api/proxy] fetch error:', targetUrl, err);
      return c.json({ success: false, message: 'Gagal mengambil media dari sumber.' }, 502);
    }

    if (!upstream.ok) {
      console.error('[/api/proxy] upstream non-OK:', upstream.status, targetUrl);
      return c.json(
        { success: false, message: `Sumber media merespons status ${upstream.status}.` },
        502
      );
    }

    const buffer = await upstream.arrayBuffer();
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    fullResponse = new Response(buffer, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(buffer.byteLength),
        'accept-ranges': 'bytes',
        'cache-control': 'public, max-age=120',
      },
    });

    c.executionCtx.waitUntil(cache.put(cacheKey, fullResponse.clone()));
  }

  const totalBuffer = await fullResponse.clone().arrayBuffer();
  const total = totalBuffer.byteLength;
  const contentType = fullResponse.headers.get('content-type') || 'application/octet-stream';
  const isImage = contentType.startsWith('image/');
  const rangeHeader = c.req.header('range');

  const baseHeaders = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'content-disposition': isImage
      ? 'inline; filename="reelgrab-thumbnail"'
      : 'inline; filename="reelgrab-video.mp4"',
  };

  // Untuk request HEAD, cukup kembalikan header saja tanpa body.
  if (c.req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: { ...baseHeaders, 'content-length': String(total) },
    });
  }

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
}

// Didaftarkan untuk GET dan HEAD, dan juga tanpa/dengan trailing slash,
// supaya request thumbnail dari <img> (yang kadang browser kirim
// sebagai HEAD dulu) tidak jatuh ke notFound -> 404.
app.get('/api/proxy', handleProxy);
app.get('/api/proxy/', handleProxy);
app.on('HEAD', ['/api/proxy', '/api/proxy/'], handleProxy);

// ---------- Error handler global ----------
// Supaya exception yang tidak sengaja lolos dari try/catch manapun
// tidak pernah muncul sebagai halaman error polos Cloudflare atau
// status yang membingungkan (mis. 404 padahal sebenarnya route match
// tapi ada bug di tengah proses) — semua tetap balik JSON konsisten.
app.onError((err, c) => {
  console.error('[unhandled error]', c.req.method, c.req.path, err);
  return c.json(
    { success: false, message: 'Terjadi kesalahan tak terduga di server.' },
    500
  );
});

// ---------- 404 handler ----------
// Log method + path persis, supaya kalau masih ada 404 yang aneh
// (mis. thumbnail keblokir lagi), tinggal cek `wrangler tail` dan
// lihat baris ini untuk tahu path apa yang sebenarnya diminta.
app.notFound((c) => {
  console.warn('[404 not found]', c.req.method, c.req.path, c.req.url);
  return c.json({ success: false, message: 'Endpoint tidak ditemukan.' }, 404);
});

export default app;
