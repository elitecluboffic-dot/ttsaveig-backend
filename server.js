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

   11) PROTEKSI /api/download-file SUPAYA TIDAK BISA DIPANGGIL DARI LUAR
       SITUS (dulu, sekarang DIGANTI — lihat poin 12):
      - /api/download-file sebelumnya bisa dipanggil dari mana saja
        selama URL targetnya lolos whitelist host -> siapa pun yang tahu
        pola URL-nya bisa numpang bandwidth situs ini tanpa lewat form
        atau captcha Turnstile sama sekali.
      - Solusi (LAMA): isRequestFromOwnSite() mencocokkan header Origin
        (atau fallback ke Referer kalau Origin kosong) terhadap daftar
        ALLOWED_ORIGIN yang sama dipakai middleware CORS di atas.
      - MASALAH YANG TERBUKTI DI LAPANGAN: tombol "Unduh Gambar" di
        frontend sering gagal dengan pesan "Permintaan hanya diizinkan
        dari situs Reelgrab" PADAHAL user memang klik dari situs asli.
        Penyebabnya, Origin/Referer TIDAK SELALU dikirim browser untuk
        navigasi biasa:
          * <a rel="noreferrer"> (atau "noopener noreferrer") membuat
            Referer tidak dikirim sama sekali.
          * Meta tag <meta name="referrer" content="no-referrer"> atau
            header Referrer-Policy: no-referrer di halaman frontend.
          * Origin memang secara umum TIDAK dikirim browser untuk
            navigasi GET biasa (cuma untuk fetch/XHR/POST cross-site),
            jadi selalu jatuh ke pengecekan Referer.
          * Ekstensi privasi / mode browser tertentu bisa strip Referer.
      - KESIMPULAN: Origin/Referer bukan proteksi yang bisa diandalkan
        untuk kasus ini, walau secara teori tidak bisa dipalsukan oleh
        JS halaman lain. Diganti dengan signed token, lihat poin 12.

   12) GANTI PROTEKSI /api/download-file DARI Origin/Referer MENJADI
       SIGNED TOKEN (HMAC-SHA256) — update ini:
      - /api/download sekarang membuat token sekali-pakai (mengikat
        target URL + waktu kedaluwarsa) untuk setiap downloadUrl /
        audioUrl yang dikembalikan, ditandatangani pakai HMAC-SHA256
        dengan secret Worker (env DOWNLOAD_TOKEN_SECRET, lewat
        Web Crypto API `crypto.subtle` bawaan Workers runtime).
      - Response /api/download sekarang juga menyertakan
        `downloadFileUrl` (dan `audioDownloadFileUrl` kalau ada audio)
        yaitu URL absolut ke /api/download-file yang SUDAH berisi query
        `token=...` -> frontend TINGGAL PAKAI LANGSUNG url ini di
        tombol "Unduh", tidak perlu bikin/rakit URL sendiri lagi.
      - /api/download-file sekarang WAJIB membawa `token` yang valid
        (belum kedaluwarsa, tanda tangan cocok, dan terikat persis ke
        `url` yang diminta) -> ini tidak bergantung sama sekali pada
        header Origin/Referer, jadi tidak lagi rusak oleh
        rel="noreferrer", Referrer-Policy, ekstensi privasi, dsb.
      - Token berlaku singkat (default 5 menit, lihat
        DOWNLOAD_TOKEN_TTL_MS) supaya tidak bisa dipakai ulang lama-lama
        atau disebar sebagai link publik permanen.
      - BACKWARD COMPATIBILITY: kalau env DOWNLOAD_TOKEN_SECRET BELUM
        di-set di Worker, /api/download-file otomatis fallback ke
        pengecekan Origin/Referer lama (isRequestFromOwnSite) supaya
        tidak langsung mati total kalau lupa setup -> tapi ini TIDAK
        direkomendasikan untuk produksi. Wajib jalankan:
        `wrangler secret put DOWNLOAD_TOKEN_SECRET`
        (isi bebas, string acak yang panjang & rahasia) supaya proteksi
        yang lebih kuat ini benar-benar aktif.
      - WAJIB DI FRONTEND: tombol "Unduh Gambar"/"Unduh Video" harus
        pakai `data.downloadFileUrl` (atau `data.audioDownloadFileUrl`
        untuk audio) dari response /api/download, BUKAN lagi menyusun
        sendiri "/api/download-file?url=...&filename=..." manual dari
        downloadUrl mentah -> karena tanpa token yang benar, request
        akan selalu ditolak 403 sekarang.
      - Elemen <video>/<img> untuk PREVIEW tetap pakai downloadUrl /
        audioUrl mentah seperti biasa (tidak butuh token, tidak lewat
        Worker ini), konsisten dengan catatan di poin 10.

   13) INSTAGRAM: DETEKSI VIDEO VS GAMBAR (update ini):
      - Sebelum ini, normalizeInstagram() TIDAK PERNAH mengisi field
        `isVideo` sama sekali (beda dari normalizePinterest() yang
        sudah punya deteksi ini sejak awal). Akibatnya `data.isVideo`
        selalu `undefined` untuk Instagram, dan di frontend
        `data.isVideo === false` selalu bernilai false -> postingan
        Instagram yang sebenarnya berupa FOTO (bukan Reels/video)
        tetap diperlakukan sebagai video:
          * Mockup HP mencoba merender <video> dari file gambar (ada
            fallback ke <img> di frontend kalau <video> gagal load,
            jadi tidak crash, tapi sempat "flicker" gak perlu).
          * File yang didownload lewat /api/download-file selalu diberi
            nama berekstensi ".mp4" (lihat buildDownloadFileUrl di
            bawah: `normalized.isVideo === false ? '.jpg' : '.mp4'`),
            padahal isinya bisa jadi file gambar (.jpg/.png/.webp) ->
            hasil unduhan foto Instagram jadi punya ekstensi yang salah.
      - Solusi: normalizeInstagram() sekarang mendeteksi isVideo lewat
        3 lapis, urut dari yang paling akurat ke paling umum:
          1. Field eksplisit dari backend pihak ketiga kalau ada
             (`type`/`media_type`/`is_video`/`isVideo`) -> beberapa
             versi/fork btch-downloader menyertakan ini.
          2. Kalau tidak ada field eksplisit, dicek dari EKSTENSI file
             di URL downloadUrl-nya (.mp4/.mov/.webm/.m4v -> video;
             .jpg/.jpeg/.png/.webp/.gif -> gambar).
          3. Kalau ekstensi juga tidak kelihatan (URL CDN Instagram
             sering berupa signed URL tanpa ekstensi jelas di path-nya),
             DEFAULT ke video -> ini sengaja disamakan dengan perilaku
             SEBELUM perbaikan ini, supaya kasus Reels/video (paling
             umum dipakai) tidak berubah perilakunya sama sekali kalau
             deteksi gagal, dan cuma memperbaiki kasus foto yang tadinya
             pasti salah.
      - Efeknya cuma di layer parsing/data (normalizeInstagram &
        judul default "Gambar Instagram" vs "Video Instagram") -> tidak
        menyentuh logic /api/download-file, buildDownloadFileUrl, atau
        endpoint lain sama sekali, jadi tidak ada risiko bentrok dengan
        alur TikTok/Pinterest yang sudah berjalan.

   14) TRACKING JUMLAH KLIK TOMBOL "AMBIL VIDEO/GAMBAR" PER PLATFORM
       (update ini):
      - Kebutuhan: mau tahu berapa orang yang sudah nyoba tombol
        "Ambil Video/Gambar" (Instagram), "Ambil Video" (TikTok), dan
        "Ambil Gambar" (Pinterest) di frontend -> per platform.
      - Dicatat di SISI SERVER, tepat di dalam /api/download, BUKAN
        lewat event terpisah dari frontend -> karena setiap klik
        tombol itu memang selalu memicu POST ke /api/download dengan
        field `platform` yang sudah tervalidasi. Ini lebih akurat
        daripada tracking di frontend (tidak bisa "lupa" ke-fire, dan
        tidak gampang dipalsukan lewat DevTools/extension).
      - Titik pencatatan: SETELAH Turnstile + validasi url/platform
        lolos, TAPI SEBELUM memanggil backend pihak ketiga
        (ttdl/igdl/pindl) -> jadi yang terhitung adalah percobaan yang
        sudah pasti captcha-nya valid & link-nya format platform yang
        benar, tidak peduli link-nya nanti berhasil diproses atau
        tidak (video privat, backend pihak ketiga lagi down, dst tetap
        dihitung sebagai "orang yang nyoba").
      - Storage: pakai Cloudflare D1 (SQLite di edge, binding `DB` di
        wrangler.toml) -> bukan KV, karena KV dibatasi ~1000 write/hari
        di free tier yang gampang habis untuk tracking klik, sedangkan
        D1 jauh lebih longgar (100rb write/hari di free tier) dan bisa
        query agregat (GROUP BY, COUNT DISTINCT) langsung lewat SQL.
      - Pencatatan (trackClickEvent) dijalankan lewat
        `c.executionCtx.waitUntil(...)` -> supaya proses INSERT ke D1
        tidak memperlambat response ke user sama sekali (user tidak
        perlu menunggu tracking selesai dulu baru dapat hasil download).
      - Kalau binding DB belum di-set di Worker (lupa setup), tracking
        otomatis dilewati dengan console.warn (BUKAN bikin seluruh
        /api/download gagal) -> supaya fitur intinya (download) tidak
        pernah terganggu gara-gara fitur tracking yang notabene cuma
        pelengkap.
      - Endpoint baru GET /api/stats: mengembalikan rekap total klik,
        breakdown per platform, perkiraan pengguna unik (COUNT DISTINCT
        IP), dan tren harian -> dipakai oleh /dashboard.
      - Endpoint baru GET /dashboard: halaman HTML sederhana (inline,
        tidak perlu Workers Sites/Assets) yang menampilkan angka-angka
        di atas plus grafik tren harian. Bisa dikunci pakai query
        `?key=...` yang dicocokkan ke secret Worker DASHBOARD_ACCESS_KEY
        (opsional) -> kalau secret itu belum di-set, dashboard tetap
        bisa diakses siapa saja yang tahu URL-nya (cukup aman untuk data
        sekadar hitungan klik, tapi tetap disarankan di-set untuk
        produksi supaya tidak sembarang orang bisa lihat traffic).
      - Setup yang WAJIB dilakukan supaya fitur ini aktif:
        1. `wrangler d1 create ttsaveig-tracking` -> catat database_id
           yang muncul.
        2. Tambahkan binding di wrangler.toml:
           [[d1_databases]]
           binding = "DB"
           database_name = "ttsaveig-tracking"
           database_id = "<database_id dari langkah 1>"
        3. Jalankan schema.sql (file terpisah, lihat folder project)
           lewat: `wrangler d1 execute ttsaveig-tracking --file=./schema.sql`
           (tambahkan --remote kalau mau langsung ke database production,
           bukan cuma lokal).
        4. (Opsional) `wrangler secret put DASHBOARD_ACCESS_KEY` untuk
           mengunci /dashboard dan /api/stats dengan sebuah kunci akses.
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

// ---------- Tracking klik per platform (D1) — lihat poin 14 ----------
// Dicatat lewat waitUntil() supaya tidak menunda response /api/download
// sedikit pun. Kalau binding DB belum ada, cuma warning di log — tidak
// pernah menggagalkan proses download itu sendiri.
async function trackClickEvent(c, platform) {
  if (!c.env.DB) {
    console.warn('[tracking] binding D1 "DB" belum di-set -> klik tidak dicatat.');
    return;
  }
  const ip =
    c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';

  try {
    await c.env.DB.prepare(
      'INSERT INTO click_events (platform, ip) VALUES (?1, ?2)'
    )
      .bind(platform, ip)
      .run();
  } catch (err) {
    console.error('[tracking] gagal menyimpan click event:', err);
  }
}

// Cek kunci akses opsional untuk /dashboard & /api/stats. Kalau secret
// DASHBOARD_ACCESS_KEY belum di-set di Worker, endpoint tetap terbuka
// (cukup aman untuk sekadar data hitungan klik, tapi disarankan di-set
// untuk produksi lewat: wrangler secret put DASHBOARD_ACCESS_KEY).
function isDashboardAuthorized(c) {
  const requiredKey = c.env.DASHBOARD_ACCESS_KEY;
  if (!requiredKey) return true;
  const providedKey = c.req.query('key') || c.req.header('x-dashboard-key');
  return providedKey === requiredKey;
}

// Endpoint statistik: total klik, breakdown per platform, perkiraan
// pengguna unik (COUNT DISTINCT ip), dan tren harian.
app.get('/api/stats', async (c) => {
  if (!isDashboardAuthorized(c)) {
    return c.json({ success: false, message: 'Akses ditolak. Kunci akses salah/tidak ada.' }, 403);
  }
  if (!c.env.DB) {
    return c.json(
      { success: false, message: 'Tracking belum dikonfigurasi (binding D1 "DB" kosong).' },
      500
    );
  }

  try {
    const totalsResult = await c.env.DB.prepare(
      `SELECT platform, COUNT(*) as count, COUNT(DISTINCT ip) as unique_ip
       FROM click_events
       GROUP BY platform`
    ).all();

    const totals = { tiktok: 0, instagram: 0, pinterest: 0 };
    const uniqueVisitorsApprox = { tiktok: 0, instagram: 0, pinterest: 0 };
    let totalClicks = 0;

    for (const row of totalsResult.results || []) {
      if (totals[row.platform] !== undefined) {
        totals[row.platform] = row.count;
        uniqueVisitorsApprox[row.platform] = row.unique_ip;
        totalClicks += row.count;
      }
    }

    const dailyResult = await c.env.DB.prepare(
      `SELECT substr(created_at, 1, 10) as day, platform, COUNT(*) as count
       FROM click_events
       GROUP BY day, platform
       ORDER BY day ASC`
    ).all();

    const byDay = {};
    for (const row of dailyResult.results || []) {
      byDay[row.day] = byDay[row.day] || { tiktok: 0, instagram: 0, pinterest: 0 };
      if (byDay[row.day][row.platform] !== undefined) {
        byDay[row.day][row.platform] = row.count;
      }
    }
    const dailySeries = Object.keys(byDay)
      .sort()
      .map((day) => ({ day, ...byDay[day] }));

    return c.json({ success: true, totalClicks, totals, uniqueVisitorsApprox, dailySeries });
  } catch (err) {
    console.error('[/api/stats] error:', err);
    return c.json({ success: false, message: 'Gagal mengambil statistik dari database.' }, 500);
  }
});

// Halaman dashboard sederhana — inline HTML (tidak butuh Workers
// Sites/Assets), memanggil /api/stats via fetch relatif (same-origin,
// jadi tidak kena isu CORS).
app.get('/dashboard', (c) => {
  if (!isDashboardAuthorized(c)) {
    return c.text('Akses ditolak. Tambahkan ?key=<kunci akses yang benar> di URL.', 403);
  }

  const dashboardKeyQuery = c.req.query('key')
    ? `?key=${encodeURIComponent(c.req.query('key'))}`
    : '';

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8" />
<title>Reelgrab — Dashboard Tracking</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0b0d12; --card: #151822; --text: #f2f3f5; --muted: #9aa0ac;
    --border: #262a35;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text); padding: 32px 24px 64px;
  }
  h1 { font-size: 24px; margin-bottom: 4px; }
  .sub { color: var(--muted); margin-bottom: 32px; font-size: 14px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 32px; max-width: 1000px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px; }
  .card .label { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
  .card .value { font-size: 32px; font-weight: 700; }
  .card .sub-value { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
  .chart-wrap { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 24px; max-width: 1000px; }
  .refresh { background: transparent; border: 1px solid var(--border); color: var(--text); padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; margin-bottom: 24px; }
  .refresh:hover { border-color: #444; }
  .loading { color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
  <h1>📊 Dashboard Tracking Reelgrab</h1>
  <div class="sub">Jumlah orang yang klik tombol "Ambil Video/Gambar" per platform</div>

  <button class="refresh" onclick="loadStats()">↻ Refresh data</button>

  <div id="loading" class="loading">Memuat data...</div>
  <div class="cards" id="cards" style="display:none;"></div>
  <div class="chart-wrap" id="chartWrap" style="display:none;">
    <canvas id="dailyChart" height="90"></canvas>
  </div>

  <script>
    const STATS_URL = '/api/stats${dashboardKeyQuery}';
    const PLATFORM_META = {
      tiktok: { label: 'TikTok', color: '#25f4ee' },
      instagram: { label: 'Instagram', color: '#e1306c' },
      pinterest: { label: 'Pinterest', color: '#e60023' }
    };
    let chartInstance = null;

    async function loadStats() {
      document.getElementById('loading').style.display = 'block';
      try {
        const res = await fetch(STATS_URL);
        const data = await res.json();
        if (!data.success) throw new Error(data.message || 'Gagal mengambil data');
        renderCards(data);
        renderChart(data.dailySeries);
      } catch (err) {
        document.getElementById('loading').textContent = 'Gagal memuat data: ' + err.message;
        return;
      }
      document.getElementById('loading').style.display = 'none';
      document.getElementById('cards').style.display = 'grid';
      document.getElementById('chartWrap').style.display = 'block';
    }

    function renderCards(data) {
      const cardsEl = document.getElementById('cards');
      cardsEl.innerHTML = \`
        <div class="card">
          <div class="label">Total Klik (semua platform)</div>
          <div class="value">\${data.totalClicks}</div>
        </div>
      \`;
      for (const key of Object.keys(PLATFORM_META)) {
        const meta = PLATFORM_META[key];
        const count = data.totals[key] || 0;
        const unique = data.uniqueVisitorsApprox[key] || 0;
        cardsEl.innerHTML += \`
          <div class="card">
            <div class="label"><span class="dot" style="background:\${meta.color}"></span>\${meta.label}</div>
            <div class="value">\${count}</div>
            <div class="sub-value">≈ \${unique} pengguna unik (berdasarkan IP)</div>
          </div>
        \`;
      }
    }

    function renderChart(dailySeries) {
      const ctx = document.getElementById('dailyChart').getContext('2d');
      const labels = dailySeries.map((d) => d.day);
      const datasets = Object.keys(PLATFORM_META).map((key) => ({
        label: PLATFORM_META[key].label,
        data: dailySeries.map((d) => d[key] || 0),
        borderColor: PLATFORM_META[key].color,
        backgroundColor: PLATFORM_META[key].color + '33',
        tension: 0.3,
        fill: true
      }));
      if (chartInstance) chartInstance.destroy();
      chartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          plugins: {
            legend: { labels: { color: '#f2f3f5' } },
            title: { display: true, text: 'Klik per hari per platform', color: '#f2f3f5' }
          },
          scales: {
            x: { ticks: { color: '#9aa0ac' }, grid: { color: '#262a35' } },
            y: { ticks: { color: '#9aa0ac' }, grid: { color: '#262a35' }, beginAtZero: true }
          }
        }
      });
    }

    loadStats();
  </script>
</body>
</html>`;

  return c.html(html);
});

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

// Deteksi VIDEO vs GAMBAR untuk satu item Instagram. Dipakai oleh
// normalizeInstagram() -> lihat catatan poin 13 di header file ini
// untuk latar belakang lengkap kenapa ini dibutuhkan.
//
// Urutan pengecekan (dari paling akurat ke paling umum):
//   1. Field eksplisit dari backend pihak ketiga kalau ada.
//   2. Ekstensi file di URL downloadUrl-nya.
//   3. Default ke video kalau dua cara di atas tidak kasih jawaban
//      pasti (paling umum: link CDN Instagram tanpa ekstensi jelas).
function detectInstagramIsVideo(item, downloadUrl) {
  const explicitType = pickFirst(item, ['type', 'media_type', 'mediaType']);
  const explicitIsVideo = pickFirst(item, ['is_video', 'isVideo']);

  if (explicitIsVideo !== null) {
    // Bisa berupa boolean asli (true/false) atau string ("true"/"false").
    return explicitIsVideo === true || explicitIsVideo === 'true';
  }

  if (explicitType) {
    return /video|reel/i.test(String(explicitType));
  }

  const url = downloadUrl || '';
  if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(url)) return true;
  if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)) return false;

  // Tidak ada petunjuk sama sekali -> default video, sama seperti
  // perilaku sebelum perbaikan poin 13 (supaya kasus Reels/video yang
  // paling umum tidak berubah kalau deteksi ini gagal menebak).
  return true;
}

function normalizeInstagram(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const item = list.find((i) => pickFirst(i, ['url', 'video', 'download_url', 'play']));
  if (!item) return null;

  const downloadUrlRaw = pickFirst(item, ['url', 'video', 'download_url', 'play']);
  const downloadUrl = Array.isArray(downloadUrlRaw) ? downloadUrlRaw[0] : downloadUrlRaw;
  const thumbnail = pickFirst(item, ['thumbnail', 'cover', 'image']);
  const title = pickFirst(item, ['title', 'caption', 'desc']);
  const author = pickFirst(item, ['author', 'username']);

  const isVideo = detectInstagramIsVideo(item, downloadUrl);

  return {
    title: title || (isVideo ? 'Video Instagram' : 'Gambar Instagram'),
    author: author || '',
    thumbnail: Array.isArray(thumbnail) ? thumbnail[0] : thumbnail || '',
    downloadUrl,
    audioUrl: null,
    isVideo,
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

// ---------- Validasi Origin/Referer (FALLBACK LAMA, lihat poin 12) ----------
// Dipakai HANYA kalau DOWNLOAD_TOKEN_SECRET belum di-set di Worker.
// CATATAN JUJUR soal batasan proteksi ini: header Origin/Referer memang
// bisa TIDAK TERKIRIM SAMA SEKALI untuk request yang sah dari browser
// (rel="noreferrer", Referrer-Policy: no-referrer, navigasi GET biasa
// yang tidak selalu membawa Origin, ekstensi privasi, dst) -> makanya ini
// cuma fallback, bukan proteksi utama lagi.
function isRequestFromOwnSite(c) {
  const allowedOrigins = (c.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0) {
    console.warn(
      '[/api/download-file] ALLOWED_ORIGIN belum di-set -> validasi Origin/Referer dilewati.'
    );
    return true;
  }

  const origin = c.req.header('origin');
  const referer = c.req.header('referer');

  if (origin) {
    return allowedOrigins.includes(origin);
  }
  if (referer) {
    return allowedOrigins.some((o) => referer.startsWith(o));
  }
  return false;
}

// ---------- Signed download token (HMAC-SHA256) — lihat poin 12 ----------
// Menggantikan ketergantungan ke Origin/Referer yang tidak reliable.
// Token mengikat { url, exp } dan ditandatangani pakai secret Worker,
// jadi /api/download-file bisa memverifikasi bahwa request ini memang
// hasil keluaran /api/download (yang sudah lewat Turnstile + rate limit),
// bukan sekadar dicek dari header yang bisa hilang begitu saja.
const DOWNLOAD_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 menit, cukup buat klik "Unduh"

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToBytes(str) {
  let normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacSignBase64Url(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return base64UrlEncode(new Uint8Array(sigBuffer));
}

// Bikin token untuk satu target URL media. Dipanggil dari /api/download
// setelah normalisasi berhasil, sebelum response dikirim ke frontend.
async function createDownloadToken(secret, targetUrl) {
  const payloadJson = JSON.stringify({ url: targetUrl, exp: Date.now() + DOWNLOAD_TOKEN_TTL_MS });
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payloadJson));
  const signature = await hmacSignBase64Url(secret, payloadB64);
  return `${payloadB64}.${signature}`;
}

// Verifikasi token dari /api/download-file. Return { ok: true } atau
// { ok: false, reason } dengan pesan yang jelas buat user/log.
async function verifyDownloadToken(secret, token, targetUrl) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, reason: 'Token unduhan tidak ada atau formatnya salah.' };
  }

  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) {
    return { ok: false, reason: 'Token unduhan tidak lengkap.' };
  }

  const expectedSignature = await hmacSignBase64Url(secret, payloadB64);

  // Perbandingan waktu-konstan sederhana supaya tidak bocor info lewat
  // timing (tidak sepenting di konteks ini, tapi murah untuk dilakukan).
  if (expectedSignature.length !== signature.length) {
    return { ok: false, reason: 'Token unduhan tidak valid.' };
  }
  let diff = 0;
  for (let i = 0; i < expectedSignature.length; i++) {
    diff |= expectedSignature.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  if (diff !== 0) {
    return { ok: false, reason: 'Token unduhan tidak valid.' };
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeToBytes(payloadB64)));
  } catch {
    return { ok: false, reason: 'Token unduhan rusak.' };
  }

  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) {
    return { ok: false, reason: 'Token unduhan sudah kedaluwarsa. Ambil ulang link download.' };
  }

  if (payload.url !== targetUrl) {
    return { ok: false, reason: 'Token unduhan tidak cocok dengan URL yang diminta.' };
  }

  return { ok: true };
}

// ---------- Endpoint download streaming (memaksa "Save As") ----------
// Berbeda dari /api/proxy versi lama (poin 3-5, sudah dihapus di poin 9):
// endpoint ini TIDAK membuffer seluruh isi file ke memory Worker.
// upstream.body (ReadableStream) diteruskan langsung ke browser, jadi
// resource yang dipakai Worker tetap minim walau filenya besar -> tidak
// mengulang error 1102 (resource limit) dari proxy lama.
//
// Proteksi utama sekarang: signed token (lihat poin 12) lewat query
// `token`. Kalau DOWNLOAD_TOKEN_SECRET belum di-set di Worker, fallback
// ke cek Origin/Referer lama (isRequestFromOwnSite) supaya endpoint
// tidak langsung mati total, tapi ini TIDAK direkomendasikan produksi.
app.get('/api/download-file', downloadLimiter, async (c) => {
  const targetUrl = c.req.query('url');
  const filename = sanitizeFilename(c.req.query('filename'));
  const token = c.req.query('token');
  const tokenSecret = c.env.DOWNLOAD_TOKEN_SECRET;

  if (!targetUrl) {
    return c.json({ success: false, message: 'Parameter url wajib diisi.' }, 400);
  }

  if (tokenSecret) {
    const tokenCheck = await verifyDownloadToken(tokenSecret, token, targetUrl);
    if (!tokenCheck.ok) {
      console.warn('[/api/download-file] token ditolak:', tokenCheck.reason, targetUrl);
      return c.json({ success: false, message: tokenCheck.reason }, 403);
    }
  } else {
    console.warn(
      '[/api/download-file] DOWNLOAD_TOKEN_SECRET belum di-set -> fallback ke cek Origin/Referer (tidak direkomendasikan).'
    );
    if (!isRequestFromOwnSite(c)) {
      console.warn(
        '[/api/download-file] ditolak, Origin/Referer tidak dikenali:',
        c.req.header('origin'),
        c.req.header('referer')
      );
      return c.json(
        { success: false, message: 'Permintaan hanya diizinkan dari situs Reelgrab.' },
        403
      );
    }
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

  // ---------- Catat klik (lihat poin 14) ----------
  // Sampai titik ini: captcha valid, url & platform format-nya benar ->
  // dihitung sebagai "orang yang nyoba" tombol Ambil Video/Gambar,
  // terlepas dari hasil akhirnya nanti sukses atau gagal diproses.
  // Dijalankan via waitUntil supaya tidak menunda response sedikit pun.
  c.executionCtx.waitUntil(trackClickEvent(c, platform));

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

    // ---------- Bikin signed download URL (lihat poin 12) ----------
    // downloadUrl / audioUrl tetap dikirim mentah seperti biasa (dipakai
    // untuk <video src>/<img src> preview, tidak lewat Worker ini).
    // downloadFileUrl / audioDownloadFileUrl BARU: URL absolut siap-pakai
    // ke /api/download-file, sudah termasuk token yang valid -> ini yang
    // WAJIB dipakai frontend untuk href tombol "Unduh".
    const tokenSecret = c.env.DOWNLOAD_TOKEN_SECRET;
    const workerOrigin = new URL(c.req.url).origin;
    const baseTitle = normalized.title || 'reelgrab-download';

    async function buildDownloadFileUrl(mediaUrl, extHint) {
      if (!mediaUrl) return null;
      const params = new URLSearchParams();
      params.set('url', mediaUrl);
      params.set('filename', `${sanitizeFilename(baseTitle)}${extHint}`);
      if (tokenSecret) {
        const token = await createDownloadToken(tokenSecret, mediaUrl);
        params.set('token', token);
      } else {
        console.warn(
          '[/api/download] DOWNLOAD_TOKEN_SECRET belum di-set -> downloadFileUrl dibuat tanpa token (fallback Origin/Referer lama akan dipakai).'
        );
      }
      return `${workerOrigin}/api/download-file?${params.toString()}`;
    }

    // Ekstensi file unduhan sekarang konsisten untuk TikTok, Instagram,
    // MAUPUN Pinterest: pakai .jpg kalau normalized.isVideo eksplisit
    // false (gambar), selain itu .mp4 (video). Sebelum perbaikan poin
    // 13, Instagram selalu jatuh ke .mp4 karena isVideo-nya undefined
    // -> sekarang normalizeInstagram() sudah mengisi isVideo dengan
    // benar, jadi baris ini otomatis ikut benar tanpa perlu diubah.
    const downloadFileUrl = await buildDownloadFileUrl(
      normalized.downloadUrl,
      normalized.isVideo === false ? '.jpg' : '.mp4'
    );
    const audioDownloadFileUrl = await buildDownloadFileUrl(normalized.audioUrl, '.mp3');

    // downloadUrl / audioUrl di sini adalah URL ASLI dari sumber
    // (dl.tiktokio.com, cdninstagram.com, i.pinimg.com, dst.) -> tidak
    // lagi dibungkus lewat /api/proxy (lihat catatan poin 9 di header).
    // Frontend pakai downloadUrl/audioUrl untuk preview, dan
    // downloadFileUrl/audioDownloadFileUrl untuk tombol "Unduh".
    return c.json({
      success: true,
      data: {
        ...normalized,
        downloadFileUrl,
        audioDownloadFileUrl,
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
