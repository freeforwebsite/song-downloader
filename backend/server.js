const express = require('express');
const cors = require('cors');
const https = require('https');
const { Readable } = require('stream');
const { Innertube, UniversalCache } = require('youtubei.js');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---- Innertube client pool (multi-client fallback for bot-detection resilience) ----
let ytClients = {};
const CLIENT_TYPES = ['WEB', 'ANDROID', 'IOS', 'TV'];

async function getClient(type) {
  if (ytClients[type]) return ytClients[type];
  const client = await Innertube.create({
    client_type: type,
    cache: new UniversalCache(false),
    generate_session_locally: true,
  });
  ytClients[type] = client;
  return client;
}

async function withFallback(fn) {
  let lastErr;
  for (const type of CLIENT_TYPES) {
    try {
      const yt = await getClient(type);
      return await fn(yt);
    } catch (err) {
      lastErr = err;
      console.warn(`[${type}] failed: ${err.message}`);
    }
  }
  throw lastErr;
}

function pickBestThumbnail(thumbnails = []) {
  if (!thumbnails.length) return null;
  return thumbnails.sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
}

function cleanMetadata(rawTitle, rawChannel) {
  let title = rawTitle || 'Unknown Title';
  let artist = rawChannel || 'Unknown Artist';

  // Strip common suffixes from title first
  title = title.replace(/\s*[\(\[][^)\]]*(official|lyrics?|video|audio|hd|4k|hq|full|version|cover|clip|visualizer|remix)[^)\]]*[\)\]]/gi, '');
  title = title.replace(/\s*\|\s*.*$/gi, ''); // remove anything after a pipe |
  
  // Check if title has a hyphen
  const hyphenIndex = title.indexOf('-');
  const ndashIndex = title.indexOf('–');
  const mdashIndex = title.indexOf('—');
  
  let splitChar = null;
  if (hyphenIndex !== -1) splitChar = '-';
  else if (ndashIndex !== -1) splitChar = '–';
  else if (mdashIndex !== -1) splitChar = '—';

  if (splitChar) {
    const parts = title.split(splitChar);
    if (parts.length >= 2) {
      artist = parts[0].trim();
      title = parts.slice(1).join(splitChar).trim();
    }
  }

  // Clean artist name (remove "Official", "VEVO", "- Topic", "Music" suffixes)
  artist = artist.replace(/\s*-\s*Topic$/i, '');
  artist = artist.replace(/\s*(VEVO|Official|Music)\s*$/i, '');
  artist = artist.trim();
  title = title.trim();

  // If title is empty after cleaning, fallback
  if (!title) title = rawTitle;
  if (!artist) artist = rawChannel;

  return { title, artist };
}

// ---- Tiny in-memory TTL cache to keep repeat searches/lookups fast ----
class TTLCache {
  constructor(ttlMs) { this.ttlMs = ttlMs; this.store = new Map(); }
  get(key) {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) { this.store.delete(key); return undefined; }
    return hit.value;
  }
  set(key, value) {
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}
const searchCache = new TTLCache(5 * 60 * 1000);   // 5 min
const suggestCache = new TTLCache(10 * 60 * 1000); // 10 min

// ---- Search endpoint: returns title, channel, duration, cover art ----
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing search query' });

  const cached = searchCache.get(query);
  if (cached) return res.json({ videos: cached, cached: true });

  try {
    const results = await withFallback(async (yt) => yt.search(query, { type: 'video' }));

    const videos = (results.videos || [])
      .filter(v => v.id)
      .slice(0, 1) // Return only the single best match
      .map(v => {
        const rawTitle = v.title?.text || v.title || 'Unknown title';
        const rawChannel = v.author?.name || 'Unknown artist';
        const { title, artist } = cleanMetadata(rawTitle, rawChannel);
        return {
          videoId: v.id,
          title,
          artist,
          durationText: v.duration?.text || null,
          durationSeconds: v.duration?.seconds || null,
          thumbnail: pickBestThumbnail(v.thumbnails),
        };
      });

    searchCache.set(query, videos);
    res.json({ videos, cached: false });
  } catch (err) {
    console.error('Search error:', err);
    res.status(404).json({ error: "Couldn't find anything for that search. Try different words." });
  }
});

// ---- Autocomplete endpoint ----
app.get('/api/suggest', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ suggestions: [] });

  const cached = suggestCache.get(query);
  if (cached) return res.json({ suggestions: cached });

  try {
    const suggestions = await withFallback(async (yt) => yt.getSearchSuggestions(query));
    const list = (suggestions || []).slice(0, 8);
    suggestCache.set(query, list);
    res.json({ suggestions: list });
  } catch (err) {
    // Autocomplete is non-critical — fail quietly with an empty list
    res.json({ suggestions: [] });
  }
});

// ---- Metadata endpoint: full info for a specific video ----
app.get('/api/info/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const info = await withFallback(async (yt) => yt.getBasicInfo(videoId));
    const basic = info.basic_info;
    const { title, artist } = cleanMetadata(basic.title, basic.author);

    res.json({
      videoId,
      title,
      artist,
      durationSeconds: basic.duration,
      thumbnail: pickBestThumbnail(basic.thumbnail),
      viewCount: basic.view_count,
    });
  } catch (err) {
    console.error('Info error:', err);
    res.status(404).json({ error: 'Could not load details for this song.' });
  }
});

const ALLOWED_BITRATES = [128, 192, 320];

async function getCobaltDownloadUrl(videoUrl, isAudioOnly, bitrate = 128) {
  const instances = [
    'https://api.cobalt.liubquanti.click/',
    'https://cobalt.k6.cz/',
    'https://api.cobalt.tools/'
  ];

  for (const instance of instances) {
    try {
      const parsed = new URL(instance);
      const payload = JSON.stringify({
        url: videoUrl,
        downloadMode: isAudioOnly ? 'audio' : 'auto',
        videoQuality: '1080',
        audioFormat: 'mp3',
        audioBitrate: String(bitrate)
      });

      const response = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: parsed.hostname,
          port: 443,
          path: parsed.pathname || '/',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode, body }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      if (response.statusCode === 200 || response.statusCode === 201) {
        const data = JSON.parse(response.body);
        if (data.url) return data.url;
      }
    } catch (e) {
      console.warn(`[Cobalt] Instance ${instance} failed:`, e.message);
    }
  }
  return null;
}

async function streamAudio({ videoId, bitrate, inline, res }) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Try Cobalt first for instant speed and zero server overhead
  try {
    const cobaltUrl = await getCobaltDownloadUrl(videoUrl, true, bitrate);
    if (cobaltUrl) {
      console.log(`[streamAudio] Cobalt redirect success! Redirecting to: ${cobaltUrl}`);
      return res.redirect(cobaltUrl);
    }
  } catch (cobaltErr) {
    console.warn('[streamAudio] Cobalt failed, trying youtubei.js + ffmpeg fallback:', cobaltErr.message);
  }

  // Fallback to youtubei.js + local ffmpeg
  try {
    const { info, webStream } = await withFallback(async (yt) => {
      const info = await yt.getInfo(videoId);
      const webStream = await info.download({ type: 'audio', quality: 'best' });
      return { info, webStream };
    });

    const title = (info.basic_info.title || 'audio').replace(/[^\w\s-]/g, '').trim();
    const artist = info.basic_info.author || 'Unknown';

    res.setHeader('Content-Type', 'audio/mpeg');
    if (!inline) {
      res.setHeader('Content-Disposition', `attachment; filename="${title} - ${bitrate}kbps.mp3"`);
    }

    const stream = Readable.fromWeb(webStream);

    ffmpeg(stream)
      .audioBitrate(bitrate)
      .format('mp3')
      .outputOptions([
        '-metadata', `title=${title}`,
        '-metadata', `artist=${artist}`,
      ])
      .on('error', (err) => {
        console.error('ffmpeg error:', err.message);
        if (!res.headersSent) res.status(500).end('Conversion failed');
      })
      .pipe(res, { end: true });
  } catch (err) {
    console.error('[streamAudio] All methods failed:', err.message);
    throw err;
  }
}

// ---- Download endpoint: streams audio-only, converted to mp3 at chosen quality ----
app.get('/api/download/:videoId', async (req, res) => {
  const { videoId } = req.params;
  const bitrate = ALLOWED_BITRATES.includes(Number(req.query.quality))
    ? Number(req.query.quality)
    : 192;

  try {
    await streamAudio({ videoId, bitrate, inline: false, res });
  } catch (err) {
    console.error('Download error:', err);
    if (!res.headersSent) res.status(404).json({ error: "Couldn't fetch that song right now. Try again in a moment." });
  }
});

// ---- Preview endpoint: inline stream for in-browser playback before downloading ----
app.get('/api/preview/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    await streamAudio({ videoId, bitrate: 128, inline: true, res });
  } catch (err) {
    console.error('Preview error:', err);
    if (!res.headersSent) res.status(404).json({ error: 'Preview unavailable for this song.' });
  }
});

app.listen(PORT, () => {
  console.log(`yt-song-downloader backend running on port ${PORT}`);
});
