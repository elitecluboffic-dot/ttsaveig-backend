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

   3) [DICABUT — lihat poin 9] Sempat ditambahkan endpoint /api/proxy
      supaya URL video asli dari server sumber (mis. dl.tiktokio.com)
      tidak terlihat langsung oleh browser user.

   4) [DICABUT — lihat poin 9] /api/proxy sempat diperbaiki supaya fetch
      ke sumber cuma sekali per targetUrl dan disimpan di Cache API,
      karena token sekali-pakai bentrok dengan banyak request Range dari
      tag <video>.

   5) [DICABUT — lihat poin 9] Fix thumbnail/gambar 404 di /api/proxy
      dengan menambahkan dukungan method HEAD dan error handler global.

   6) PINTEREST — MENGGANTIKAN X/TWITTER:
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
        tidak dipakai. (Catatan: whitelist ini sendiri sudah tidak
        relevan lagi setelah poin 9, karena Worker tidak lagi memproxy
        media apa pun.)

   7) FIX "Pin Pinterest tidak ditemukan" PADAHAL PIN-NYA ADA:
      - Dikonfirmasi lewat dokumentasi resmi btch-downloader bahwa nama
        fungsi/endpoint untuk Pinterest memang persis 'pinterest' (sudah
        jadi kandidat pertama di PINTEREST_ENDPOINT_CANDIDATES, jadi
        bukan itu masalahnya).
      - Root cause paling mungkin: normalizePinterest() sebelumnya
        cuma cari field di level teratas object, padahal beberapa
        respons backend membungkus payload asli di dalam container
        seperti { data: {...} }, { result: {...} }, atau { pin: {...} }.
      - Solusi: ditambahkan unwrapContainer() yang membongkar satu
        lapis pembungkus itu sebelum parsing field lain. Juga
        ditambahkan penanganan kalau raw (atau item di dalam array)
        ternyata cuma berupa STRING URL polos, dan daftar nama field
        URL/thumbnail/title/author diperluas (contentUrl, direct_url,
        download, image_url, dst.) supaya lebih toleran terhadap
        variasi penamaan.
      - CATATAN PENTING: kalau setelah update ini link Pinterest masih
        gagal (404 "tidak ditemukan"), kemungkinan bentuk respons
        backend memang di luar semua pola yang sudah ditangani di
        atas. Jalankan `wrangler tail` sambil coba link yang gagal,
        lalu lihat baris log '[/api/download] gagal parse respons
        Pinterest:' — isi JSON di baris itu adalah bentuk respons
        ASLI dari backend, dan itulah yang dibutuhkan untuk
        menyesuaikan normalizePinterest() secara presisi.

   8) CLOUDFLARE TURNSTILE (CAPTCHA) SEBELUM /api/download:
      - Ditambahkan verifikasi Cloudflare Turnstile supaya endpoint
        /api/download tidak bisa dipanggil otomatis oleh bot/script
        tanpa menyelesaikan captcha dulu di sisi frontend.
      - Frontend (index.html + script.js) mengirim token Turnstile
        hasil widget lewat field `turnstileToken` di body JSON.
      - Backend (endpoint ini) SELALU verifikasi token itu ke endpoint
        resmi Cloudflare `siteverify` sebelum lanjut memproses link
        apa pun -> kalau token kosong/invalid/kedaluwarsa, request
        ditolak dengan 400/403 tanpa pernah menyentuh ttdl/igdl/pindl.
      - Secret key Turnstile TIDAK di-hardcode di kode -> harus diisi
        lewat Worker secret bernama TURNSTILE_SECRET_KEY (lihat env
        binding di wrangler, cara set-nya lewat:
        `wrangler secret put TURNSTILE_SECRET_KEY`). Site key (public)
        ada di sisi frontend, diisi di config.js sebagai
        `window.TURNSTILE_SITE_KEY`.
      - Kalau env TURNSTILE_SECRET_KEY belum di-set sama sekali di
        Worker (mis. lupa setup), endpoint akan otomatis menolak semua
        request download dengan pesan error yang jelas ("captcha belum
        dikonfigurasi di server"), BUKAN diam-diam meloloskan request
        tanpa verifikasi -> ini sengaja supaya tidak ada mode "gagal
        terbuka" yang bikin proteksi captcha bocor tanpa disadari.

   9) HAPUS TOTAL /api/proxy (update ini, atas permintaan langsung):
      - Root cause error "Worker exceeded resource limits" (Cloudflare
        error 1102) adalah handleProxy() yang menarik SELURUH isi video
        ke memory Worker lewat `upstream.arrayBuffer()` sebelum
        dikirim ke browser. Untuk video yang agak besar, ini gampang
        melewati limit CPU time / memory instance Worker (apalagi di
        plan gratis), jadi Worker mati di tengah proses -> Cloudflare
        balikin halaman error 1102, atau kadang malah nyangkut jadi
        exception yang ke-catch di app.onError() -> muncul sebagai
        pesan generik "Terjadi kesalahan tak terduga di server."
      - Karena /api/download SUDAH mengembalikan downloadUrl/audioUrl
        ASLI dari sumber (dl.tiktokio.com dkk) di response JSON-nya,
        proxy sebenarnya bukan satu-satunya jalan -> frontend bisa
        langsung memakai URL itu untuk <video src>, <audio src>, atau
        link <a download>, tanpa lewat Worker ini sama sekali.
      - Konsekuensi yang perlu diketahui: URL asli sumber (berikut
        token sekali-pakainya) sekarang terlihat oleh browser user,
        dan playback/download sepenuhnya bergantung pada server sumber
        (dl.tiktokio.com dkk) merespons request Range dengan benar.
        Kalau nanti ternyata source itu suka nolak request langsung
        dari browser (mis. karena cek header Origin/Referer), proxy
        perlu dihidupkan lagi tapi dengan streaming (ReadableStream)
        alih-alih buffer penuh ke memory, supaya tidak kena limit lagi.
      - Semua kode terkait (handleProxy, isAllowedMediaUrl,
        ALLOWED_MEDIA_HOSTS, route /api/proxy & /api/proxy/, handler
        HEAD-nya) dihapus dari file ini.

   10) TOMBOL "UNDUH" MALAH MEMBUKA FILE DI TAB BARU, BUKAN DOWNLOAD
       (update ini):
      - Setelah poin 9, link download di frontend menunjuk LANGSUNG ke
        URL sumber (mis. i.pinimg.com/...). Atribut HTML `download` di
        tag <a> HANYA berlaku untuk URL SAME-ORIGIN -> begitu URL-nya
        cross-origin (beda domain dari situs Reelgrab), browser
        mengabaikan atribut `download` itu dan cuma menavigasi
        (membuka) file-nya di tab, bukan memicu dialog "Save As".
        Ini murni perilaku standar browser, bukan bug di parsing/media.
      - Solusi: ditambahkan endpoint /api/download-file yang men-STREAM
        (bukan buffer penuh ke memory seperti /api/proxy versi lama di
        poin 3-5) isi file dari sumber ke browser, dengan header
        `Content-Disposition: attachment` -> ini memaksa browser
        mendownload file apa pun originnya, TANPA perlu menampung
        seluruh isi file di memory Worker (upstream.body diteruskan
        langsung sebagai ReadableStream), jadi tidak mengulang masalah
        resource limit 1102 dari proxy lama.
      - Endpoint ini HANYA dipakai untuk tombol unduh (klik eksplisit
        oleh user), BUKAN untuk elemen <video>/<img> preview di kartu
        hasil maupun mockup hp -> supaya trafik Worker tetap minim dan
        cuma dipakai saat benar-benar dibutuhkan.
      - Whitelist host (ALLOWED_MEDIA_HOSTS) dan validasi
        isAllowedMediaUrl() dihidupkan lagi khusus untuk endpoint ini,
        supaya Worker tidak menjadi open proxy yang bisa dipakai
        mendownload file dari domain sembarangan.
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

// ---------- Verifikasi Cloudflare Turnstile (CAPTCHA) ----------
const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Hasil: { ok: true } kalau token valid, atau { ok: false, reason, status }
// kalau ditolak -> dipakai handler /api/download buat mutusin status HTTP
// & pesan yang paling pas dikirim balik ke frontend.
async function verifyTurnstileToken(c, token) {
  const secretKey = c.env.TURNSTILE_SECRET_KEY;

  // Sengaja TIDAK "gagal terbuka": kalau secret belum di-set di Worker
  // (lupa configure), semua request download ditolak dengan pesan jelas,
  // bukan diam-diam meloloskan tanpa verifikasi captcha sama sekali.
  if (!secretKey) {
    console.error(
      '[turnstile] TURNSTILE_SECRET_KEY belum di-set di environment Worker.'
    );
    return {
      ok: false,
      status: 500,
      reason: 'Verifikasi captcha belum dikonfigurasi di server. Hubungi admin.',
    };
  }

  if (!token || typeof token !== 'string' || !token.trim()) {
    return {
      ok: false,
      status: 400,
      reason: 'Captcha belum diselesaikan. Selesaikan verifikasi terlebih dahulu.',
    };
  }

  const remoteIp =
    c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || undefined;

  const form = new URLSearchParams();
  form.set('secret', secretKey);
  form.set('response', token);
  if (remoteIp) form.set('remoteip', remoteIp);

  let result;
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    result = await res.json();
  } catch (err) {
    console.error('[turnstile] gagal menghubungi siteverify:', err);
    return {
      ok: false,
      status: 502,
      reason: 'Gagal memverifikasi captcha sekarang. Coba lagi beberapa saat lagi.',
    };
  }

  if (!result || result.success !== true) {
    const errorCodes = (result && result['error-codes']) || [];
    console.warn('[turnstile] verifikasi ditolak:', errorCodes);

    // 'timeout-or-duplicate' artinya token sudah pernah dipakai atau
    // kedaluwarsa -> pesan khusus supaya user tahu harus ulang captcha,
    // bukan sekadar "salah".
    const isExpiredOrReused = errorCodes.includes('timeout-or-duplicate');
    return {
      ok: false,
      status: 403,
      reason: isExpiredOrReused
        ? 'Captcha sudah kedaluwarsa atau sudah dipakai. Selesaikan captcha lagi.'
        : 'Verifikasi captcha gagal. Selesaikan captcha lagi lalu coba ulang.',
    };
  }

  return { ok: true };
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

// Ambil string TEKS biasa (mis. nama author/username) dari sebuah nilai
// yang bisa berupa string langsung, array, atau object bersarang seperti
// { username, full_name } / { name } — supaya tidak pernah kebocoran
// jadi "[object Object]" di tampilan kalau backend mengembalikan object
// alih-alih string polos.
function unwrapTextValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = unwrapTextValue(v);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    return (
      unwrapTextValue(value.username) ||
      unwrapTextValue(value.full_name) ||
      unwrapTextValue(value.fullName) ||
      unwrapTextValue(value.name) ||
      unwrapTextValue(value.nickname) ||
      unwrapTextValue(value.display_name) ||
      unwrapTextValue(value.displayName) ||
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

// Beberapa backend membungkus payload asli di dalam key container
// seperti { success, data: {...} }, { status, result: {...} }, atau
// { pin: {...} }. Bongkar satu lapis pembungkus ini kalau ada, supaya
// pencarian field di bawah tidak meleset karena field-nya sebenarnya
// bersarang satu level lebih dalam.
function unwrapContainer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const container = pickFirst(raw, ['data', 'result', 'results', 'pin', 'payload']);
  if (container && (typeof container === 'object' || typeof container === 'string')) {
    return container;
  }
  return raw;
}

// Parser fleksibel untuk Pinterest — dirancang untuk menangani banyak
// kemungkinan bentuk respons dari backend pihak ketiga, karena bentuk
// pastinya belum terdokumentasi resmi. Lihat catatan (6) di header.
// Pinterest bisa berupa VIDEO (pin video/idea pin) atau cuma GAMBAR
// (pin foto biasa) -> keduanya ditangani di sini.
function normalizePinterest(rawInput) {
  if (!rawInput) return null;

  // Kasus paling sederhana: backend langsung balikin string URL media.
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (!trimmed) return null;
    return {
      title: 'Media Pinterest',
      author: '',
      thumbnail: '',
      downloadUrl: trimmed,
      audioUrl: null,
      isVideo: /\.mp4(\?|$)/i.test(trimmed),
    };
  }

  const raw = unwrapContainer(rawInput);

  // Kalau raw berupa array, ambil item pertama yang kelihatan valid.
  const item = Array.isArray(raw)
    ? raw.find((i) => {
        if (typeof i === 'string') return i.trim().length > 0;
        return pickFirst(i, [
          'url',
          'video',
          'download_url',
          'media',
          'variants',
          'videos',
          'images',
          'image',
        ]);
      })
    : raw;
  if (!item) return null;

  // Item di dalam array bisa jadi juga cuma string URL polos.
  if (typeof item === 'string') {
    return {
      title: 'Media Pinterest',
      author: '',
      thumbnail: '',
      downloadUrl: item,
      audioUrl: null,
      isVideo: /\.mp4(\?|$)/i.test(item),
    };
  }

  let downloadUrl = null;
  let isVideo = false;

  // Kemungkinan 1: field video/url langsung berupa string, array, atau
  // object bersarang seperti { hd, sd }. Daftar nama field diperluas
  // karena beberapa versi backend memakai penamaan yang berbeda-beda
  // (contentUrl, direct_url, high_quality, download, src, dst.).
  const directUrl = unwrapUrlValue(
    pickFirst(item, [
      'url',
      'video',
      'download_url',
      'downloadUrl',
      'direct_url',
      'directUrl',
      'download',
      'contentUrl',
      'content_url',
      'src',
      'high_quality',
      'highQuality',
      'hd',
      'sd',
    ])
  );
  if (directUrl) {
    downloadUrl = directUrl;
    isVideo =
      /\.mp4(\?|$)/i.test(directUrl) ||
      !!pickFirst(item, ['video', 'video_list', 'videos']);
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
    unwrapUrlValue(
      pickFirst(item, ['thumbnail', 'thumb', 'cover', 'preview', 'poster', 'image_url', 'imageUrl'])
    ) || (!isVideo ? downloadUrl : '');
  const title = unwrapTextValue(
    pickFirst(item, [
      'title',
      'grid_title',
      'gridTitle',
      'text',
      'caption',
      'desc',
      'description',
    ])
  );
  const author = unwrapTextValue(
    pickFirst(item, ['author', 'username', 'user', 'pinner', 'creator'])
  );

  return {
    title: title || (isVideo ? 'Video Pinterest' : 'Gambar Pinterest'),
    author: author || '',
    thumbnail: thumbnail || '',
    downloadUrl,
    audioUrl: null,
    isVideo,
  };
}

// ---------- Whitelist host media (khusus /api/download-file) ----------
// Dipakai supaya Worker tidak jadi open proxy yang bisa dipaksa
// mendownload file dari domain sembarangan -- hanya host CDN sumber
// yang memang dipakai backend (ttdl/igdl/pindl) yang diizinkan.
const ALLOWED_MEDIA_HOSTS = [
  // TikTok - video CDN
  /(^|\.)tiktokcdn\.com$/,
  /(^|\.)tiktokcdn-us\.com$/,
  /(^|\.)tiktokcdn-eu\.com$/,
  /(^|\.)tiktokv\.com$/,
  /(^|\.)tiktokv-eu\.com$/,
  /(^|\.)dl\.tiktokio\.com$/,
  // Instagram / Facebook CDN
  /(^|\.)cdninstagram\.com$/,
  /(^|\.)fbcdn\.net$/,
  // Pinterest - gambar & video sama-sama di *.pinimg.com
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

// Bikin nama file aman dipakai di header Content-Disposition (hilangkan
// karakter yang bisa merusak header seperti newline & kutip, batasi
// panjang supaya tidak berlebihan).
function sanitizeFilename(name) {
  const fallback = 'reelgrab-download';
  if (!name || typeof name !== 'string') return fallback;
  const cleaned = name
    .replace(/[\r\n"]/g, '')
    .replace(/[\\/:*?<>|]/g, '_')
    .trim()
    .slice(0, 100);
  return cleaned || fallback;
}

// ---------- Endpoint download streaming (memaksa "Save As") ----------
// Berbeda dari /api/proxy versi lama (poin 3-5, sudah dihapus di poin 9):
// endpoint ini TIDAK membuffer seluruh isi file ke memory Worker.
// upstream.body (ReadableStream) diteruskan langsung ke browser, jadi
// resource yang dipakai Worker tetap minim walau filenya besar -> tidak
// mengulang error 1102 (resource limit) dari proxy lama.
app.get('/api/download-file', async (c) => {
  const targetUrl = c.req.query('url');
  const filename = sanitizeFilename(c.req.query('filename'));

  if (!targetUrl) {
    return c.json({ success: false, message: 'Parameter url wajib diisi.' }, 400);
  }
  if (!isAllowedMediaUrl(targetUrl)) {
    console.warn('[/api/download-file] host ditolak whitelist:', targetUrl);
    return c.json({ success: false, message: 'Sumber media tidak diizinkan.' }, 403);
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ttsaveig-backend)' },
    });
  } catch (err) {
    console.error('[/api/download-file] fetch error:', targetUrl, err);
    return c.json({ success: false, message: 'Gagal mengambil media dari sumber.' }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    console.error('[/api/download-file] upstream non-OK:', upstream.status, targetUrl);
    return c.json(
      { success: false, message: `Sumber media merespons status ${upstream.status}.` },
      502
    );
  }

  const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
  const contentLength = upstream.headers.get('content-length');

  const headers = {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${filename}"`,
    'access-control-allow-origin': '*',
  };
  if (contentLength) headers['content-length'] = contentLength;

  // upstream.body diteruskan APA ADANYA (streaming) -> Worker tidak
  // pernah menampung seluruh file di memory sekaligus.
  return new Response(upstream.body, { status: 200, headers });
});

// ---------- Endpoint utama ----------
app.post('/api/download', downloadLimiter, async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: 'Body request bukan JSON yang valid.' }, 400);
  }

  const { url, platform, quality, removeWatermark, turnstileToken } = body || {};

  // ---------- Verifikasi captcha Turnstile SELALU paling awal ----------
  // Dicek sebelum validasi url/platform apa pun, supaya request tanpa
  // captcha valid tidak pernah sampai memicu pemanggilan backend
  // pihak ketiga (ttdl/igdl/pindl) sama sekali.
  const turnstileCheck = await verifyTurnstileToken(c, turnstileToken);
  if (!turnstileCheck.ok) {
    return c.json({ success: false, message: turnstileCheck.reason }, turnstileCheck.status);
  }

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

    // downloadUrl / audioUrl di sini adalah URL ASLI dari sumber
    // (dl.tiktokio.com, cdninstagram.com, i.pinimg.com, dst.) -> tidak
    // lagi dibungkus lewat /api/proxy (lihat catatan poin 9 di header).
    // Frontend tinggal pakai langsung untuk <video src>, <audio src>,
    // atau <a download href>.
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
// Log method + path persis, supaya kalau ada request ke path yang
// sudah tidak ada lagi (mis. /api/proxy yang sudah dihapus), tinggal
// cek `wrangler tail` dan lihat baris ini untuk tahu path apa yang
// sebenarnya diminta.
app.notFound((c) => {
  console.warn('[404 not found]', c.req.method, c.req.path, c.req.url);
  return c.json({ success: false, message: 'Endpoint tidak ditemukan.' }, 404);
});

export default app;
