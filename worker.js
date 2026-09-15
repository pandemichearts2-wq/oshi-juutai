const BASE = 'https://holodex.net/api/v2';
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VERSION = 'youtube-search-v20-gas-analysis-media-breakdown';
const MAX_NOTIFY_SUBSCRIBERS = 20;
const NOTIFY_PENDING_TTL_MS = 24 * 60 * 60 * 1000;


function json(data, status = 200, ttl = 0) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': ttl > 0 ? `public, max-age=${ttl}` : 'no-store'
  };
  return new Response(JSON.stringify(data), { status, headers });
}

class HolodexError extends Error {
  constructor(status, path, body = '') {
    super(`Holodex ${status}: ${path}`);
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

async function holodex(path, apiKey, options = {}) {
  const method = options.method || 'GET';
  const headers = {
    'X-APIKEY': apiKey,
    'Accept': 'application/json'
  };
  const init = { method, headers };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const res = await fetch(BASE + path, init);
  const text = await res.text();

  if (!res.ok) {
    throw new HolodexError(res.status, path, text.slice(0, 240));
  }

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Holodex returned invalid JSON: ${path}`);
  }
}

class YouTubeError extends Error {
  constructor(status, body = '') {
    super(`YouTube ${status}`);
    this.status = status;
    this.body = body;
  }
}

function hasJapanese(text = '') {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(String(text));
}

async function youtubeSearchMixed(q, apiKey) {
  const params = new URLSearchParams({
    part: 'snippet',
    maxResults: '25',
    q,
    key: apiKey
  });

  // type を channel に固定しない。
  // YouTube の通常検索と同じように video / channel / playlist をまとめて取り、
  // 検索にヒットした動画や再生リストの「投稿元チャンネル」も候補として拾う。
  if (hasJapanese(q)) params.set('relevanceLanguage', 'ja');

  const res = await fetch('https://www.googleapis.com/youtube/v3/search?' + params.toString(), {
    headers: { 'Accept': 'application/json' }
  });
  const text = await res.text();

  if (!res.ok) throw new YouTubeError(res.status, text.slice(0, 1200));

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('YouTube returned invalid JSON');
  }

  return Array.isArray(data?.items) ? data.items : [];
}

async function youtubeChannelsByIds(ids, apiKey) {
  const unique = [...new Set(ids)].filter(id => CHANNEL_ID.test(id)).slice(0, 50);
  if (!unique.length) return [];

  const params = new URLSearchParams({
    part: 'snippet,statistics',
    id: unique.join(','),
    maxResults: String(unique.length),
    key: apiKey
  });

  const res = await fetch('https://www.googleapis.com/youtube/v3/channels?' + params.toString(), {
    headers: { 'Accept': 'application/json' }
  });
  const text = await res.text();

  if (!res.ok) throw new YouTubeError(res.status, text.slice(0, 1200));

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('YouTube returned invalid JSON');
  }

  return Array.isArray(data?.items) ? data.items : [];
}



async function youtubeHistoryChannelSeeds(ids, apiKey) {
  const unique = [...new Set(ids)].filter(id => CHANNEL_ID.test(id)).slice(0, 20);
  if (!unique.length) return [];

  const params = new URLSearchParams({
    part: 'snippet,contentDetails',
    id: unique.join(','),
    maxResults: String(unique.length),
    key: apiKey
  });
  const res = await fetch('https://www.googleapis.com/youtube/v3/channels?' + params.toString(), {
    headers: { 'Accept': 'application/json' }
  });
  const text = await res.text();
  if (!res.ok) throw new YouTubeError(res.status, text.slice(0, 1200));
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('YouTube returned invalid JSON'); }

  return (Array.isArray(data?.items) ? data.items : []).map(item => {
    const sn = item?.snippet || {};
    const thumbs = sn.thumbnails || {};
    return {
      id: item?.id || '',
      name: sn.title || item?.id || '',
      photo: thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || '',
      uploads: item?.contentDetails?.relatedPlaylists?.uploads || ''
    };
  }).filter(x => CHANNEL_ID.test(x.id) && x.uploads);
}

async function youtubePlaylistItems(playlistId, apiKey, pageToken = '') {
  const params = new URLSearchParams({
    part: 'contentDetails',
    playlistId,
    maxResults: '50',
    key: apiKey
  });
  if (pageToken) params.set('pageToken', pageToken);
  const res = await fetch('https://www.googleapis.com/youtube/v3/playlistItems?' + params.toString(), {
    headers: { 'Accept': 'application/json' }
  });
  const text = await res.text();
  if (!res.ok) throw new YouTubeError(res.status, text.slice(0, 1200));
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('YouTube returned invalid JSON'); }
  return {
    ids: (Array.isArray(data?.items) ? data.items : []).map(x => x?.contentDetails?.videoId || '').filter(Boolean),
    nextPageToken: data?.nextPageToken || ''
  };
}

async function youtubeVideoDetails(ids, apiKey) {
  const unique = [...new Set(ids)].filter(Boolean).slice(0, 50);
  if (!unique.length) return [];
  const params = new URLSearchParams({
    part: 'snippet,liveStreamingDetails,contentDetails,statistics',
    id: unique.join(','),
    maxResults: String(unique.length),
    key: apiKey
  });
  const res = await fetch('https://www.googleapis.com/youtube/v3/videos?' + params.toString(), {
    headers: { 'Accept': 'application/json' }
  });
  const text = await res.text();
  if (!res.ok) throw new YouTubeError(res.status, text.slice(0, 1200));
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('YouTube returned invalid JSON'); }
  return Array.isArray(data?.items) ? data.items : [];
}


function splitIntoChunks(items, size = 50) {
  const arr = Array.isArray(items) ? items : [];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function youtubeFeedVideoIds(channelId) {
  if (!CHANNEL_ID.test(channelId || '')) return [];

  const res = await fetch(
    'https://www.youtube.com/feeds/videos.xml?channel_id=' + encodeURIComponent(channelId),
    {
      headers: {
        'Accept': 'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.1',
        'User-Agent': 'Mozilla/5.0'
      }
    }
  );

  const text = await res.text();
  if (!res.ok) throw new YouTubeError(res.status, text.slice(0, 500));

  const ids = [];
  const seen = new Set();
  const re = /<yt:videoId>([^<]+)<\/yt:videoId>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const id = String(m[1] || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 15) break;
  }
  return ids;
}

async function youtubeVideoDetailsAll(ids, apiKey) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return [];

  const chunks = splitIntoChunks(unique, 50);
  const groups = await mapLimited(chunks, 3, chunk => youtubeVideoDetails(chunk, apiKey));
  return groups.flat();
}

function youtubeLiveRow(item, channelMap = new Map()) {
  const id = item?.id || '';
  const sn = item?.snippet || {};
  const live = item?.liveStreamingDetails || {};
  const channelId = sn.channelId || '';

  // actualStartTime があり、actualEndTime がまだ無いものだけを「現在LIVE」とする。
  if (!id || !CHANNEL_ID.test(channelId) || !live.actualStartTime || live.actualEndTime) return null;

  const c = channelMap.get(channelId) || null;
  const viewers = Number(live.concurrentViewers || 0) || 0;

  return {
    id,
    title: sn.title || '(タイトルなし)',
    desc: sn.description || '',
    description: sn.description || '',
    status: 'live',
    type: 'stream',
    start_scheduled: live.scheduledStartTime || live.actualStartTime,
    start_actual: live.actualStartTime,
    published_at: sn.publishedAt || live.actualStartTime,
    live_viewers: viewers,
    channel_id: channelId,
    channel: {
      id: channelId,
      name: c?.name || sn.channelTitle || channelId,
      english_name: c?.english_name || '',
      photo: c?.photo || '',
      thumbnail: c?.thumbnail || c?.photo || '',
      org: c?.org || '',
      type: 'vtuber',
      lang: c?.lang || sn.defaultLanguage || sn.defaultAudioLanguage || ''
    },
    source: 'youtube-live-fallback'
  };
}

async function youtubeLiveFallback(channelIds, apiKey) {
  const unique = [...new Set(channelIds || [])]
    .filter(id => CHANNEL_ID.test(id || ''))
    .slice(0, 20);
  if (!unique.length || !apiKey) return [];

  // YouTube側の確認は検索APIをチャンネル数分叩かない。
  // 各チャンネルの公式Atomフィードから直近動画IDだけを拾い、
  // videos.list を50件ずつまとめて照会して現在LIVEかを確定する。
  // これなら search.list の大量クォータ消費を避けながら補完できる。
  const feedGroups = await mapLimited(unique, 5, async channelId => {
    try {
      const videoIds = await youtubeFeedVideoIds(channelId);
      return { channelId, videoIds };
    } catch (err) {
      console.warn('YouTube live fallback feed failed', channelId, err?.status || '', err?.message || err);
      return { channelId, videoIds: [] };
    }
  });

  const candidateIds = [...new Set(feedGroups.flatMap(x => x.videoIds || []))];
  if (!candidateIds.length) return [];

  let details = [];
  try {
    details = await youtubeVideoDetailsAll(candidateIds, apiKey);
  } catch (err) {
    console.warn('YouTube live fallback videos.list failed', err?.status || '', err?.message || err);
    return [];
  }

  const targetSet = new Set(unique);
  const liveItems = details.filter(item => {
    const channelId = item?.snippet?.channelId || '';
    const live = item?.liveStreamingDetails || {};
    return targetSet.has(channelId) && !!live.actualStartTime && !live.actualEndTime;
  });
  if (!liveItems.length) return [];

  // LIVEが実際に見つかったチャンネルだけ、YouTubeからアイコン等を補完する。
  const liveChannelIds = [...new Set(
    liveItems
      .map(item => item?.snippet?.channelId || '')
      .filter(id => CHANNEL_ID.test(id))
  )];

  let channelMap = new Map();
  try {
    const channelRows = await youtubeChannelsByIds(liveChannelIds, apiKey);
    channelMap = new Map(
      channelRows
        .map(youtubeChannelFromDetail)
        .filter(Boolean)
        .map(c => [c.id, c])
    );
  } catch (err) {
    console.warn('YouTube live fallback channel enrich failed', err?.status || '', err?.message || err);
  }

  return liveItems
    .map(item => youtubeLiveRow(item, channelMap))
    .filter(Boolean);
}

function historyVideoRow(item, channel) {
  const id = item?.id || '';
  const sn = item?.snippet || {};
  const live = item?.liveStreamingDetails || {};
  if (!id || !live.actualStartTime || !live.actualEndTime) return null;
  return {
    id,
    title: sn.title || '(タイトルなし)',
    desc: sn.description || '',
    description: sn.description || '',
    status: 'past',
    type: 'stream',
    start_actual: live.actualStartTime,
    end_actual: live.actualEndTime,
    published_at: sn.publishedAt || live.actualStartTime,
    channel_id: channel.id,
    channel: {
      id: channel.id,
      name: channel.name || sn.channelTitle || channel.id,
      photo: channel.photo || '',
      thumbnail: channel.photo || '',
      type: 'vtuber'
    }
  };
}

async function youtubeHistoryForChannel(channel, apiKey) {
  const out = new Map();
  let pageToken = '';
  // Shorts/通常動画が多いチャンネルでも10配信を拾いやすいよう最大100投稿を見る。
  for (let page = 0; page < 2 && out.size < 10; page++) {
    const list = await youtubePlaylistItems(channel.uploads, apiKey, pageToken);
    const details = await youtubeVideoDetails(list.ids, apiKey);
    for (const item of details) {
      const row = historyVideoRow(item, channel);
      if (row) out.set(row.id, row);
    }
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }
  return [...out.values()]
    .sort((a, b) => new Date(b.start_actual || b.published_at || 0) - new Date(a.start_actual || a.published_at || 0))
    .slice(0, 10);
}

async function youtubeHistory(ids, apiKey) {
  const channels = await youtubeHistoryChannelSeeds(ids, apiKey);
  const groups = await mapLimited(channels, 3, c => youtubeHistoryForChannel(c, apiKey));
  return groups.flat();
}


async function holodexAnalysisForChannel(channelId, apiKey, fromIso, toIso, maxPages = 40) {
  const out = new Map();
  const pageSize = 50;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      channel_id: channelId,
      status: 'past',
      type: 'stream',
      sort: 'available_at',
      order: 'desc',
      limit: String(pageSize),
      offset: String(page * pageSize),
      from: fromIso,
      to: toIso,
      include: 'live_info'
    });

    const rows = await holodex('/videos?' + params.toString(), apiKey);
    const arr = Array.isArray(rows) ? rows : [];
    for (const v of arr) {
      if (!v?.id) continue;
      out.set(v.id, {
        ...v,
        media_kind: 'stream',
        channel_id: v?.channel?.id || v?.channel_id || channelId,
        channel: v?.channel || { id: channelId, name: channelId, photo: '', type: 'vtuber' }
      });
    }
    if (arr.length < pageSize) break;
  }

  return [...out.values()];
}

function isoDurationSeconds(value) {
  const s = String(value || '');
  const m = s.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

function analysisMediaKind(item) {
  const live = item?.liveStreamingDetails || {};
  if (live.actualStartTime || live.scheduledStartTime) return 'stream';

  const sn = item?.snippet || {};
  const seconds = isoDurationSeconds(item?.contentDetails?.duration || '');
  const publishedMs = new Date(sn.publishedAt || 0).getTime();
  const text = [sn.title || '', sn.description || '', ...(Array.isArray(sn.tags) ? sn.tags : [])].join(' ').toLowerCase();
  const explicitShort = /(?:#\s*shorts?\b|\bshorts?\b|ショート)/iu.test(text);
  const thumbs = sn.thumbnails || {};
  const thumbList = [thumbs.maxres, thumbs.standard, thumbs.high, thumbs.medium, thumbs.default].filter(Boolean);
  const verticalHint = thumbList.some(t => Number(t?.height || 0) >= Number(t?.width || 1));
  const threeMinuteEra = Number.isFinite(publishedMs) && publishedMs >= Date.UTC(2024, 9, 15);

  // YouTube Data APIにはShorts専用フラグや動画アスペクト比がないため推定。
  // 60秒以下はShorts候補として扱い、1〜3分は#Shorts/ショート表記や縦長サムネイルを補助判定にする。
  if (seconds > 0 && seconds <= 60) return 'short';
  if (seconds > 60 && seconds <= 180 && threeMinuteEra && (explicitShort || verticalHint)) return 'short';
  return 'video';
}

function analysisMediaRow(item, channel) {
  const id = item?.id || '';
  const sn = item?.snippet || {};
  const live = item?.liveStreamingDetails || {};
  if (!id) return null;

  const kind = analysisMediaKind(item);
  if (kind === 'stream' && !live.actualStartTime) return null; // 予定枠は実績分析から除外

  const status = kind === 'stream' ? (live.actualEndTime ? 'past' : 'live') : 'published';
  return {
    id,
    title: sn.title || '(タイトルなし)',
    desc: sn.description || '',
    description: sn.description || '',
    status,
    type: kind === 'stream' ? 'stream' : 'video',
    media_kind: kind,
    duration_seconds: isoDurationSeconds(item?.contentDetails?.duration || ''),
    start_actual: kind === 'stream' ? (live.actualStartTime || '') : '',
    end_actual: kind === 'stream' ? (live.actualEndTime || '') : '',
    published_at: sn.publishedAt || live.actualStartTime || '',
    channel_id: channel.id,
    channel: {
      id: channel.id,
      name: channel.name || sn.channelTitle || channel.id,
      photo: channel.photo || '',
      thumbnail: channel.photo || '',
      type: 'vtuber'
    }
  };
}

async function youtubeMediaForChannelRange(channel, apiKey, fromMs, toMs, maxPages = 40) {
  const out = new Map();
  let pageToken = '';

  for (let page = 0; page < maxPages; page++) {
    const list = await youtubePlaylistItems(channel.uploads, apiKey, pageToken);
    const details = await youtubeVideoDetails(list.ids, apiKey);
    let oldestPublished = Infinity;

    for (const item of details) {
      const publishedMs = new Date(item?.snippet?.publishedAt || 0).getTime();
      if (Number.isFinite(publishedMs)) oldestPublished = Math.min(oldestPublished, publishedMs);

      const row = analysisMediaRow(item, channel);
      if (!row) continue;
      const t = new Date(row.media_kind === 'stream' ? (row.start_actual || row.published_at || 0) : (row.published_at || 0)).getTime();
      if (Number.isFinite(t) && t >= fromMs && t <= toMs) out.set(row.id, row);
    }

    pageToken = list.nextPageToken;
    // Uploadsプレイリストは公開日時の新しい順。期間開始より古いページまで来たら終了。
    if (!pageToken || (Number.isFinite(oldestPublished) && oldestPublished < fromMs)) break;
  }

  return [...out.values()];
}

async function analysisHistory(ids, holodexKey, youtubeKey, fromIso, toIso) {
  const requested = [...new Set(ids)].filter(id => CHANNEL_ID.test(id)).slice(0, 20);
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  if (!requested.length) return [];

  // 配信実績はHolodexを優先。1チャンネル呼び出し時は最大40ページまで追う。
  const holodexPageBudget = requested.length === 1
    ? 40
    : Math.max(2, Math.min(10, Math.floor(40 / requested.length)));

  const hdGroups = await mapLimited(requested, Math.min(4, requested.length), async id => {
    try {
      return await holodexAnalysisForChannel(id, holodexKey, fromIso, toIso, holodexPageBudget);
    } catch (err) {
      console.warn('Holodex analysis history failed', id, err?.status || '', err?.message || err);
      return [];
    }
  });

  const out = new Map();
  hdGroups.flat().forEach(v => v?.id && out.set(v.id, v));

  // 通常動画・Shorts集計のため、YouTube uploadsはHolodexの成否に関係なく取得する。
  // 同じ配信IDはマージし、動画/Shortsはmedia_kindを付けた最小限の分析データとして返す。
  if (youtubeKey) {
    try {
      const youtubePageBudget = requested.length === 1
        ? 40
        : Math.max(2, Math.min(10, Math.floor(40 / requested.length)));
      const seeds = await youtubeHistoryChannelSeeds(requested, youtubeKey);
      const ytGroups = await mapLimited(
        seeds,
        Math.min(3, seeds.length || 1),
        c => youtubeMediaForChannelRange(c, youtubeKey, fromMs, toMs, youtubePageBudget)
      );
      ytGroups.flat().forEach(v => {
        if (!v?.id) return;
        const existing = out.get(v.id);
        if (existing && v.media_kind === 'stream') {
          out.set(v.id, { ...existing, ...v, channel: existing.channel || v.channel, media_kind: 'stream' });
        } else if (!existing) {
          out.set(v.id, v);
        }
      });
    } catch (err) {
      console.warn('YouTube media analysis failed', err?.status || '', err?.message || err);
    }
  }

  return [...out.values()].sort((a, b) => {
    const ta = new Date(a.media_kind === 'stream' ? (a.start_actual || a.published_at || 0) : (a.published_at || 0)).getTime();
    const tb = new Date(b.media_kind === 'stream' ? (b.start_actual || b.published_at || 0) : (b.published_at || 0)).getTime();
    return ta - tb;
  });
}

function videoThumb(item) {
  const t = item?.snippet?.thumbnails || {};
  return t.maxres?.url || t.standard?.url || t.high?.url || t.medium?.url || t.default?.url || '';
}

function recommendationRow(item) {
  const id = item?.id || '';
  const sn = item?.snippet || {};
  const live = item?.liveStreamingDetails || {};
  const stats = item?.statistics || {};
  if (!id) return null;
  const isCompletedStream = !!(live.actualStartTime && live.actualEndTime);
  return {
    id,
    title: sn.title || '(タイトルなし)',
    thumb: videoThumb(item),
    view_count: Number(stats.viewCount || 0) || 0,
    published_at: sn.publishedAt || live.actualStartTime || '',
    kind: isCompletedStream ? 'stream' : 'video'
  };
}

async function bestRecentVideoForChannel(channelId, apiKey) {
  const seeds = await youtubeHistoryChannelSeeds([channelId], apiKey);
  const channel = seeds[0];
  if (!channel?.uploads) return null;

  const all = [];
  let pageToken = '';
  for (let page = 0; page < 2; page++) {
    const list = await youtubePlaylistItems(channel.uploads, apiKey, pageToken);
    const details = await youtubeVideoDetails(list.ids, apiKey);
    for (const item of details) {
      const row = recommendationRow(item);
      if (row) all.push(row);
    }
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }

  if (!all.length) return null;
  const streams = all.filter(v => v.kind === 'stream');
  const pool = streams.length ? streams : all;
  return pool.sort((a, b) => b.view_count - a.view_count)[0] || null;
}

function randomPick(items) {
  if (!Array.isArray(items) || !items.length) return null;
  return items[Math.floor(Math.random() * items.length)] || null;
}

async function randomHolodexVtuber(apiKey, excluded = new Set()) {
  // Holodex catalogからランダムなページを引き、登録済みを除外して1人選ぶ。
  // 空ページに当たった場合は範囲を狭めて再試行する。
  const ranges = [6000, 4500, 3000, 1800, 900, 300, 0];
  for (const range of ranges) {
    const offset = range > 0 ? Math.floor(Math.random() * range / 50) * 50 : 0;
    let rows = [];
    try {
      rows = await holodex(`/channels?type=vtuber&limit=50&offset=${offset}&sort=subscriber_count&order=desc`, apiKey);
    } catch (err) {
      console.warn('discover catalog failed', offset, err?.status || '', err?.message || err);
      continue;
    }
    const candidates = (Array.isArray(rows) ? rows : [])
      .filter(c => c && CHANNEL_ID.test(c.id || ''))
      .filter(c => !c.type || c.type === 'vtuber')
      .filter(c => !excluded.has(c.id));
    const picked = randomPick(candidates);
    if (picked) return minimalChannel(picked);
  }
  return null;
}

async function calendarStreamsForChannels(ids, apiKey) {
  const unique = [...new Set(ids)].filter(id => CHANNEL_ID.test(id)).slice(0, 20);
  if (!unique.length) return [];
  const groups = await mapLimited(unique, 4, async id => {
    try {
      const rows = await holodex(
        `/videos?channel_id=${encodeURIComponent(id)}&status=upcoming&max_upcoming_hours=744&limit=50`,
        apiKey
      );
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      console.warn('calendar channel failed', id, err?.status || '', err?.message || err);
      return [];
    }
  });
  const map = new Map();
  for (const group of groups) {
    for (const row of group) if (row?.id) map.set(row.id, row);
  }
  return enrichLiveRows([...map.values()], apiKey);
}

async function discoverVtuber(excludeIds, holodexKey, youtubeKey) {
  const excluded = new Set((excludeIds || []).filter(id => CHANNEL_ID.test(id)));
  const picked = await randomHolodexVtuber(holodexKey, excluded);
  if (!picked) return { channel: null, video: null };

  let channel = picked;
  try {
    const ytRows = await youtubeChannelsByIds([picked.id], youtubeKey);
    const yt = youtubeChannelFromDetail(ytRows[0]);
    if (yt) {
      channel = {
        ...picked,
        ...yt,
        english_name: picked.english_name || yt.english_name || '',
        org: picked.org || yt.org || '',
        holodex_verified: true
      };
    }
  } catch (err) {
    console.warn('discover channel enrich failed', picked.id, err?.status || '', err?.message || err);
  }

  let video = null;
  try {
    video = await bestRecentVideoForChannel(picked.id, youtubeKey);
  } catch (err) {
    console.warn('discover video failed', picked.id, err?.status || '', err?.message || err);
  }

  return { channel, video };
}

function youtubeChannelFromDetail(item) {
  const id = item?.id || '';
  if (!CHANNEL_ID.test(id)) return null;
  const sn = item?.snippet || {};
  const thumbs = sn.thumbnails || {};
  const photo = thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || '';
  const subs = Number(item?.statistics?.subscriberCount || 0) || 0;

  return {
    id,
    name: sn.title || id,
    english_name: '',
    photo,
    thumbnail: photo,
    org: '',
    type: 'vtuber',
    lang: sn.defaultLanguage || sn.defaultAudioLanguage || '',
    subscriber_count: subs,
    description: sn.description || '',
    source: 'youtube',
    holodex_verified: false
  };
}

function scoreYoutubeCandidate(c, q, meta = {}) {
  const needle = normalize(q);
  const name = normalize(c?.name || '');
  const desc = normalize(c?.description || '');
  let score = 0;

  if (name === needle) score += 20000;
  else if (name.startsWith(needle)) score += 9000;
  else if (name.includes(needle)) score += 6000;
  if (desc.includes(needle)) score += 1500;

  // 検索結果に「チャンネルそのもの」が出た場合は強く優先。
  if (meta.directChannel) score += 10000;

  // 同じ投稿元が何件も検索結果に出るほど、本人チャンネルの可能性を上げる。
  score += Math.min(Number(meta.hits || 0), 10) * 1800;

  // 上位に出た検索結果ほど少し優先。
  const firstRank = Number.isFinite(meta.firstRank) ? meta.firstRank : 999;
  score += Math.max(0, 2500 - firstRank * 80);

  const subs = Number(c?.subscriber_count || 0) || 0;
  if (subs > 0) score += Math.min(500, Math.log10(subs + 1) * 70);
  return score;
}

async function searchYouTubeChannels(q, youtubeKey, holodexKey) {
  const rows = await youtubeSearchMixed(q, youtubeKey);
  if (!rows.length) return [];

  const stats = new Map();

  rows.forEach((item, rank) => {
    const kind = item?.id?.kind || '';
    const snippet = item?.snippet || {};

    // チャンネルそのものなら id.channelId。
    // 動画 / 再生リストなら snippet.channelId = 投稿元チャンネル。
    const id = kind === 'youtube#channel'
      ? (item?.id?.channelId || '')
      : (snippet.channelId || '');

    if (!CHANNEL_ID.test(id)) return;

    const thumbs = snippet.thumbnails || {};
    const directPhoto = kind === 'youtube#channel'
      ? (thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || '')
      : '';

    const prev = stats.get(id) || {
      id,
      hits: 0,
      directChannel: false,
      firstRank: rank,
      fallbackName: snippet.channelTitle || snippet.title || id,
      fallbackPhoto: ''
    };

    prev.hits += 1;
    prev.directChannel = prev.directChannel || kind === 'youtube#channel';
    prev.firstRank = Math.min(prev.firstRank, rank);

    // 直接チャンネル結果がある場合は、そのチャンネル名とアイコンを必ず保持する。
    // channels.list 側の取得に失敗しても、検索候補を消さないためのフォールバック。
    if (kind === 'youtube#channel') {
      prev.fallbackName = snippet.title || snippet.channelTitle || prev.fallbackName || id;
      if (directPhoto) prev.fallbackPhoto = directPhoto;
    } else if (!prev.fallbackName) {
      prev.fallbackName = snippet.channelTitle || id;
    }

    stats.set(id, prev);
  });

  const ids = [...stats.keys()];
  if (!ids.length) return [];

  // 詳細取得は補助扱い。ここが0件 / 失敗でも検索結果そのものから候補を返す。
  let detailRows = [];
  try {
    detailRows = await youtubeChannelsByIds(ids, youtubeKey);
  } catch (err) {
    console.warn('YouTube channels.list failed; using search fallback', err?.status || '', err?.message || err);
  }

  const detailMap = new Map(
    detailRows
      .map(youtubeChannelFromDetail)
      .filter(Boolean)
      .map(c => [c.id, c])
  );

  let candidates = ids
    .map(id => {
      const meta = stats.get(id) || {};
      const detailed = detailMap.get(id);
      const fallbackPhoto = meta.fallbackPhoto || '';
      const c = detailed || {
        id,
        name: meta.fallbackName || id,
        english_name: '',
        photo: fallbackPhoto,
        thumbnail: fallbackPhoto,
        org: '',
        type: 'vtuber',
        lang: '',
        subscriber_count: 0,
        description: '',
        source: 'youtube-search-fallback',
        holodex_verified: false
      };
      return { c, meta };
    })
    .sort((a, b) => scoreYoutubeCandidate(b.c, q, b.meta) - scoreYoutubeCandidate(a.c, q, a.meta))
    .slice(0, 10);

  // Holodex は所属・英語名の補完だけ。未登録・取得失敗でも候補は絶対に落とさない。
  if (holodexKey && candidates.length) {
    const enriched = await mapLimited(candidates, 4, async entry => {
      const h = await getChannel(entry.c.id, holodexKey);
      return { ...entry, h };
    });

    candidates = enriched.map(entry => ({
      ...entry,
      c: {
        ...entry.c,
        english_name: entry.h?.english_name || entry.c.english_name || '',
        org: entry.h?.org || entry.c.org || '',
        lang: entry.h?.lang || entry.c.lang || '',
        holodex_verified: !!entry.h
      }
    }));
  }

  return candidates.map(x => x.c).slice(0, 10);
}

async function debugYouTubeSearch(q, apiKey) {
  const params = new URLSearchParams({
    part: 'snippet',
    maxResults: '10',
    q,
    key: apiKey
  });
  if (hasJapanese(q)) params.set('relevanceLanguage', 'ja');

  const debugUrl = new URL('https://www.googleapis.com/youtube/v3/search?' + params.toString());
  const safeUrl = new URL(debugUrl.toString());
  safeUrl.searchParams.set('key', '***hidden***');

  const res = await fetch(debugUrl.toString(), { headers: { 'Accept': 'application/json' } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}

  const items = Array.isArray(data?.items) ? data.items : [];
  return {
    workerVersion: VERSION,
    q,
    requestUrl: safeUrl.toString(),
    status: res.status,
    ok: res.ok,
    regionCode: data?.regionCode || null,
    pageInfo: data?.pageInfo || null,
    itemCount: items.length,
    items: items.slice(0, 10).map((item, rank) => ({
      rank,
      kind: item?.id?.kind || null,
      videoId: item?.id?.videoId || null,
      channelIdFromId: item?.id?.channelId || null,
      playlistId: item?.id?.playlistId || null,
      channelIdFromSnippet: item?.snippet?.channelId || null,
      title: item?.snippet?.title || null,
      channelTitle: item?.snippet?.channelTitle || null
    })),
    error: data?.error ? {
      code: data.error.code || null,
      message: data.error.message || null,
      reasons: Array.isArray(data.error.errors) ? data.error.errors.map(e => e?.reason || null) : []
    } : null,
    rawPrefix: !res.ok && !data ? text.slice(0, 500) : null
  };
}

function youtubeErrorMessage(err) {
  if (!(err instanceof YouTubeError)) {
    return 'YouTube検索に接続できませんでした。少ししてから再試行してください。';
  }

  const body = String(err.body || '');
  if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(body)) {
    return 'YouTube検索の本日の無料検索上限に達しました。時間を置いて再試行してください。';
  }
  if (err.status === 400 || err.status === 401 || err.status === 403) {
    return 'YouTube APIキーが利用できません。CloudflareのYOUTUBE_API_KEYを確認してください。';
  }
  return 'YouTube検索に接続できませんでした。少ししてから再試行してください。';
}

function minimalChannel(c) {
  if (!c) return null;
  return {
    id: c.id || c.channel_id || '',
    name: c.name || c.text || '',
    english_name: c.english_name || '',
    photo: c.photo || c.thumbnail || '',
    thumbnail: c.thumbnail || c.photo || '',
    org: c.org || '',
    type: c.type || 'vtuber',
    lang: c.lang || '',
    subscriber_count: Number(c.subscriber_count || 0) || 0,
    description: c.description || '',
    twitter: c.twitter || ''
  };
}

function kanaFold(s = '') {
  return String(s).replace(/[ァ-ヶ]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

function normalize(s = '') {
  return kanaFold(String(s)
    .normalize('NFKC')
    .toLowerCase())
    .replace(/[\s　._・･ー\-]/g, '');
}

function searchableChannelText(c) {
  return normalize([
    c?.name || '',
    c?.english_name || '',
    c?.twitter || '',
    c?.description || ''
  ].join(' '));
}

function channelScore(c, q, extraHits = 0) {
  const needle = normalize(q);
  const name = normalize(c?.name || '');
  const en = normalize(c?.english_name || '');
  const twitter = normalize(c?.twitter || '');
  const desc = normalize(c?.description || '');
  let score = 0;

  if (name === needle || en === needle || twitter === needle) score += 20000;
  if (name.startsWith(needle) || en.startsWith(needle) || twitter.startsWith(needle)) score += 6000;
  if (name.includes(needle) || en.includes(needle) || twitter.includes(needle)) score += 3500;
  if (desc.includes(needle)) score += 1800;
  if (c?.type === 'vtuber') score += 100;
  if (c?.org) score += 20;

  // 同じ検索語で複数本ヒットするチャンネルほど本人である可能性が高い。
  score += Math.min(Number(extraHits || 0), 20) * 700;

  // 同点時だけ大手公式チャンネルを少し優先する程度の弱い補正。
  const subs = Number(c?.subscriber_count || 0) || 0;
  if (subs > 0) score += Math.min(300, Math.log10(subs + 1) * 45);
  return score;
}

function isMatchingChannel(c, q) {
  const needle = normalize(q);
  return !!needle && searchableChannelText(c).includes(needle);
}

async function getChannel(id, apiKey) {
  if (!CHANNEL_ID.test(id || '')) return null;

  try {
    const c = await holodex('/channels/' + encodeURIComponent(id), apiKey);
    if (!c) return null;
    if (c.type && c.type !== 'vtuber') return null;
    return minimalChannel(c);
  } catch (err) {
    console.warn('getChannel failed', id, err?.status || '', err?.message || err);
    return null;
  }
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}



async function searchAutocomplete(q, apiKey) {
  try {
    const raw = await holodex('/search/autocomplete?q=' + encodeURIComponent(q), apiKey);
    const rows = Array.isArray(raw) ? raw : [];
    const provisional = [];
    const ids = [];

    for (const row of rows) {
      if (typeof row === 'string') {
        if (CHANNEL_ID.test(row)) ids.push(row);
        continue;
      }

      if (!row || typeof row !== 'object') continue;

      const id = [row.value, row.id, row.channel_id].find(
        v => typeof v === 'string' && CHANNEL_ID.test(v)
      );

      if (!id) continue;
      ids.push(id);

      provisional.push(minimalChannel({
        id,
        name: row.text || row.name || '',
        english_name: row.english_name || '',
        type: row.type === 'channel' ? 'vtuber' : row.type || 'vtuber'
      }));
    }

    const uniqueIds = [...new Set(ids)].slice(0, 10);
    if (!uniqueIds.length) return [];

    const fetched = (await mapLimited(uniqueIds, 3, id => getChannel(id, apiKey))).filter(Boolean);
    const map = new Map(fetched.map(c => [c.id, c]));

    for (const p of provisional) {
      if (p?.id && !map.has(p.id)) map.set(p.id, p);
    }

    return [...map.values()]
      .filter(c => c?.id)
      .sort((a, b) => channelScore(b, q) - channelScore(a, q))
      .slice(0, 10);
  } catch (err) {
    console.warn('autocomplete failed', err?.status || '', err?.message || err);
    return [];
  }
}

async function searchVideoIndex(q, apiKey) {
  try {
    // Holodex の videoSearch の conditions は「文字列配列」。
    // v4-v6 では [{ text: q }] にしていたため、日本語名検索が正しく効いていなかった。
    const raw = await holodex('/search/videoSearch', apiKey, {
      method: 'POST',
      body: {
        sort: 'newest',
        target: ['stream'],
        conditions: [q],
        comment: [],
        offset: 0,
        limit: 50,
        paginated: false
      }
    });

    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
    const needle = normalize(q);
    const stats = new Map();

    for (const v of rows) {
      const c = v?.channel;
      if (!c || !CHANNEL_ID.test(c.id || '')) continue;
      if (c.type && c.type !== 'vtuber') continue;

      const min = minimalChannel(c);
      const haystack = normalize([
        v?.title || '',
        v?.description || '',
        c?.name || '',
        c?.english_name || ''
      ].join(' '));
      const textHit = !!needle && haystack.includes(needle);
      if (!textHit) continue;

      const prev = stats.get(min.id) || {
        channel: min,
        hits: 0
      };
      prev.hits += 1;
      stats.set(min.id, prev);
    }

    const ranked = [...stats.values()]
      .sort((a, b) => {
        const as = channelScore(a.channel, q, a.hits);
        const bs = channelScore(b.channel, q, b.hits);
        return bs - as;
      })
      .slice(0, 12);

    const full = await mapLimited(ranked, 4, async item => {
      const c = await getChannel(item.channel.id, apiKey);
      return {
        channel: c || item.channel,
        hits: item.hits
      };
    });

    return full
      .filter(x => x?.channel)
      .sort((a, b) => channelScore(b.channel, q, b.hits) - channelScore(a.channel, q, a.hits))
      .map(x => x.channel)
      .slice(0, 10);
  } catch (err) {
    console.warn('videoSearch failed', err?.status || '', err?.message || err);
    return [];
  }
}

async function searchCatalog(q, apiKey) {
  const map = new Map();

  // 名前だけでなく説明欄・Twitterも見る。日本語名がチャンネル名に入っていないケースを救う。
  // API負荷を抑えるため、人気順の先頭1000チャンネルまでをフォールバック検索する。
  for (let offset = 0; offset < 1000; offset += 50) {
    let page = [];

    try {
      page = await holodex(
        `/channels?type=vtuber&limit=50&offset=${offset}&sort=subscriber_count&order=desc`,
        apiKey
      );
    } catch (err) {
      console.warn('catalog page failed', offset, err?.status || '', err?.message || err);
      break;
    }

    if (!Array.isArray(page) || !page.length) break;

    for (const c of page) {
      if (!c || !CHANNEL_ID.test(c.id || '')) continue;
      if (c.type && c.type !== 'vtuber') continue;
      if (isMatchingChannel(c, q)) map.set(c.id, minimalChannel(c));
    }

    if (map.size >= 10) break;
  }

  return [...map.values()]
    .sort((a, b) => channelScore(b, q) - channelScore(a, q))
    .slice(0, 10);
}

async function searchChannels(q, apiKey) {
  const [autocomplete, byVideo] = await Promise.all([
    searchAutocomplete(q, apiKey),
    searchVideoIndex(q, apiKey)
  ]);

  const merged = new Map();
  for (const c of [...autocomplete, ...byVideo]) {
    if (c?.id && !merged.has(c.id)) merged.set(c.id, c);
  }

  // 通常検索で足りない時だけ、Holodexのチャンネル情報全体を補助検索する。
  // 個人名の固定辞書は使わない。
  if (merged.size < 5) {
    const catalog = await searchCatalog(q, apiKey);
    for (const c of catalog) {
      if (c?.id && !merged.has(c.id)) merged.set(c.id, c);
    }
  }

  return [...merged.values()]
    .sort((a, b) => channelScore(b, q) - channelScore(a, q))
    .slice(0, 10);
}

async function enrichLiveRows(rows, apiKey) {
  const arr = Array.isArray(rows) ? rows : [];
  const ids = [...new Set(
    arr
      .map(v => v?.channel?.id || v?.channel_id)
      .filter(id => CHANNEL_ID.test(id || ''))
  )];

  const fetched = (await mapLimited(ids, 3, id => getChannel(id, apiKey))).filter(Boolean);
  const channelMap = new Map(fetched.map(c => [c.id, c]));

  return arr.map(v => {
    const cid = v?.channel?.id || v?.channel_id || '';
    const c = channelMap.get(cid);
    return c ? { ...v, channel: { ...(v.channel || {}), ...c } } : v;
  });
}


function notifyJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function validNotifyEmail(value) {
  const email = String(value || '').trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validNotifyToken(value) {
  return /^[A-Za-z0-9_-]{20,120}$/.test(String(value || ''));
}

function makeNotifyToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sanitizeNotifyChannels(input) {
  const out = new Map();
  for (const row of Array.isArray(input) ? input : []) {
    const id = String(row?.id || '').trim();
    if (!CHANNEL_ID.test(id)) continue;
    const name = String(row?.name || id).trim().slice(0, 120) || id;
    if (!out.has(id)) out.set(id, { id, name });
    if (out.size >= 20) break;
  }
  return [...out.values()];
}

async function ensureNotifySchema(env) {
  if (!env.NOTIFY_DB) throw new Error('通知用D1データベースが未設定です。');
  await env.NOTIFY_DB.batch([
    env.NOTIFY_DB.prepare(`CREATE TABLE IF NOT EXISTS notify_subscriptions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      verify_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.NOTIFY_DB.prepare(`CREATE TABLE IF NOT EXISTS notify_channels (
      token TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (token, channel_id)
    )`),
    env.NOTIFY_DB.prepare(`CREATE TABLE IF NOT EXISTS notify_sent (
      token TEXT NOT NULL,
      video_id TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (token, video_id)
    )`),
    env.NOTIFY_DB.prepare('CREATE INDEX IF NOT EXISTS idx_notify_channels_channel ON notify_channels(channel_id)'),
    env.NOTIFY_DB.prepare('CREATE INDEX IF NOT EXISTS idx_notify_sent_time ON notify_sent(sent_at)')
  ]);
}

async function cleanupExpiredNotifyPending(env) {
  const cutoff = new Date(Date.now() - NOTIFY_PENDING_TTL_MS).toISOString();
  const rows = await env.NOTIFY_DB.prepare(
    'SELECT token FROM notify_subscriptions WHERE verified = 0 AND created_at < ?'
  ).bind(cutoff).all();
  const tokens = (rows.results || []).map(r => String(r.token || '')).filter(validNotifyToken);
  if (!tokens.length) return;
  const statements = [];
  for (const token of tokens) {
    statements.push(env.NOTIFY_DB.prepare('DELETE FROM notify_sent WHERE token = ?').bind(token));
    statements.push(env.NOTIFY_DB.prepare('DELETE FROM notify_channels WHERE token = ?').bind(token));
    statements.push(env.NOTIFY_DB.prepare('DELETE FROM notify_subscriptions WHERE token = ?').bind(token));
  }
  for (let i = 0; i < statements.length; i += 30) {
    await env.NOTIFY_DB.batch(statements.slice(i, i + 30));
  }
}

async function notifyCapacityData(env, token = '') {
  await cleanupExpiredNotifyPending(env);
  const countRow = await env.NOTIFY_DB.prepare('SELECT COUNT(*) AS count FROM notify_subscriptions').first();
  const used = Math.max(0, Number(countRow?.count || 0));
  let currentRegistered = false;
  if (validNotifyToken(token)) {
    const row = await env.NOTIFY_DB.prepare('SELECT 1 AS ok FROM notify_subscriptions WHERE token = ?').bind(token).first();
    currentRegistered = !!row?.ok;
  }
  const remaining = Math.max(0, MAX_NOTIFY_SUBSCRIBERS - used);
  return { max: MAX_NOTIFY_SUBSCRIBERS, used, remaining, full: remaining <= 0, currentRegistered };
}

async function notifyCapacity(request, env) {
  await ensureNotifySchema(env);
  let body = null;
  try { body = await request.json(); } catch {}
  const token = String(body?.token || '');
  return notifyJson(await notifyCapacityData(env, token));
}

async function seedExistingUpcomingForToken(env, token, channelIds) {
  const ids = [...new Set(channelIds || [])].filter(id => CHANNEL_ID.test(id)).slice(0, 20);
  if (!ids.length || !env.HOLODEX_API_KEY) return;
  try {
    const rows = await calendarStreamsForChannels(ids, env.HOLODEX_API_KEY);
    const now = new Date().toISOString();
    const statements = (Array.isArray(rows) ? rows : [])
      .filter(v => v?.id)
      .map(v => env.NOTIFY_DB.prepare(
        'INSERT OR IGNORE INTO notify_sent (token, video_id, sent_at) VALUES (?, ?, ?)'
      ).bind(token, String(v.id), now));
    if (statements.length) await env.NOTIFY_DB.batch(statements);
  } catch (err) {
    console.warn('notify baseline seed failed', err?.message || err);
  }
}

async function upsertNotifySubscription(request, env) {
  await ensureNotifySchema(env);
  await cleanupExpiredNotifyPending(env);
  let body = null;
  try { body = await request.json(); } catch {}
  body = body || {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!validNotifyEmail(email)) return notifyJson({ error: 'メールアドレスの形式を確認してください。' }, 400);
  const channels = sanitizeNotifyChannels(body.channels);
  let token = validNotifyToken(body.token) ? String(body.token) : '';
  let existing = null;
  if (token) existing = await env.NOTIFY_DB.prepare('SELECT token, email, verified, verify_key, created_at FROM notify_subscriptions WHERE token = ?').bind(token).first();

  const duplicate = await env.NOTIFY_DB.prepare(
    'SELECT token FROM notify_subscriptions WHERE lower(email) = lower(?) AND token <> ? LIMIT 1'
  ).bind(email, existing?.token || token || '').first();
  if (duplicate?.token) {
    const capacity = await notifyCapacityData(env, token);
    return notifyJson({ ...capacity, error: 'このメールアドレスはすでに登録されています。登録した端末から設定を変更してください。' }, 409);
  }

  if (!existing) {
    const capacity = await notifyCapacityData(env, '');
    if (capacity.full) {
      return notifyJson({ ...capacity, error: `メール通知は現在${MAX_NOTIFY_SUBSCRIBERS}人の受付上限に達しています。` }, 409);
    }
    token = makeNotifyToken();
  }

  const oldRows = existing
    ? await env.NOTIFY_DB.prepare('SELECT channel_id, added_at FROM notify_channels WHERE token = ?').bind(token).all()
    : { results: [] };
  const oldAdded = new Map((oldRows.results || []).map(r => [r.channel_id, r.added_at]));
  const now = new Date().toISOString();
  const createdAt = existing?.created_at || now;
  const emailChanged = !existing || String(existing.email || '') !== email;
  const verified = emailChanged ? 0 : Number(existing?.verified || 0);
  const verifyKey = emailChanged ? makeNotifyToken() : (existing?.verify_key || null);
  const addedChannelIds = channels.filter(c => !oldAdded.has(c.id)).map(c => c.id);

  const statements = [
    env.NOTIFY_DB.prepare(`INSERT INTO notify_subscriptions (token, email, verified, verify_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET email = excluded.email, verified = excluded.verified, verify_key = excluded.verify_key, updated_at = excluded.updated_at`)
      .bind(token, email, verified, verifyKey, createdAt, now),
    env.NOTIFY_DB.prepare('DELETE FROM notify_channels WHERE token = ?').bind(token)
  ];
  for (const c of channels) {
    statements.push(env.NOTIFY_DB.prepare(
      'INSERT INTO notify_channels (token, channel_id, channel_name, added_at) VALUES (?, ?, ?, ?)'
    ).bind(token, c.id, c.name, oldAdded.get(c.id) || now));
  }
  await env.NOTIFY_DB.batch(statements);
  await seedExistingUpcomingForToken(env, token, addedChannelIds);
  let confirmationSent = false;
  if (!verified) {
    await sendVerificationEmail(env, email, token, verifyKey, new URL(request.url).origin);
    confirmationSent = true;
  }
  const capacity = await notifyCapacityData(env, token);
  return notifyJson({ ok: true, token, email, verified: !!verified, confirmationSent, channelCount: channels.length, capacity });
}

async function deleteNotifySubscription(request, env) {
  await ensureNotifySchema(env);
  let body = null;
  try { body = await request.json(); } catch {}
  const token = String(body?.token || '');
  if (!validNotifyToken(token)) return notifyJson({ ok: true });
  await env.NOTIFY_DB.batch([
    env.NOTIFY_DB.prepare('DELETE FROM notify_sent WHERE token = ?').bind(token),
    env.NOTIFY_DB.prepare('DELETE FROM notify_channels WHERE token = ?').bind(token),
    env.NOTIFY_DB.prepare('DELETE FROM notify_subscriptions WHERE token = ?').bind(token)
  ]);
  const capacity = await notifyCapacityData(env, '');
  return notifyJson({ ok: true, capacity });
}

async function handleNotify(request, env) {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/api/notify/confirm' && request.method === 'GET') return await confirmNotifySubscription(request, env);
    if (request.method !== 'POST') return notifyJson({ error: 'Method Not Allowed' }, 405);
    if (url.pathname === '/api/notify/capacity') return await notifyCapacity(request, env);
    if (url.pathname === '/api/notify/register') return await upsertNotifySubscription(request, env);
    if (url.pathname === '/api/notify/delete') return await deleteNotifySubscription(request, env);
    return notifyJson({ error: '不明な通知APIです。' }, 404);
  } catch (err) {
    console.error('notify api failed', err);
    return notifyJson({ error: err?.message || '通知設定を保存できませんでした。' }, 500);
  }
}

function chunksOf(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function sendGasMail(env, to, subject, body) {
  if (!env.GAS_NOTIFY_URL || !env.GAS_NOTIFY_SECRET) {
    throw new Error('メール送信用のGAS_NOTIFY_URL / GAS_NOTIFY_SECRETが未設定です。');
  }
  const res = await fetch(String(env.GAS_NOTIFY_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    redirect: 'follow',
    body: JSON.stringify({
      secret: String(env.GAS_NOTIFY_SECRET),
      to: String(to || ''),
      subject: String(subject || ''),
      body: String(body || '')
    })
  });
  let detail = '';
  try { detail = await res.text(); } catch {}
  if (!res.ok) {
    throw new Error(`Apps Scriptメール送信に失敗しました (${res.status}): ${detail.slice(0, 300)}`);
  }
  if (detail) {
    try {
      const payload = JSON.parse(detail);
      if (!payload?.ok) throw new Error(payload?.error || 'Apps Script側でメール送信に失敗しました。');
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Apps Scriptから不正な応答が返りました: ${detail.slice(0, 300)}`);
      }
      throw err;
    }
  }
}

async function sendVerificationEmail(env, to, token, verifyKey, origin) {
  const confirmUrl = `${origin}/api/notify/confirm?token=${encodeURIComponent(token)}&key=${encodeURIComponent(verifyKey)}`;
  const subject = '【Vdule】配信予定メール通知の確認';
  const body = `Vduleの配信予定メール通知を有効にします。\n\n以下のリンクを開いて登録を完了してください。\n${confirmUrl}`;
  await sendGasMail(env, to, subject, body);
}

async function confirmNotifySubscription(request, env) {
  await ensureNotifySchema(env);
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const key = url.searchParams.get('key') || '';
  if (!validNotifyToken(token) || !validNotifyToken(key)) {
    return Response.redirect(new URL('/?notify=invalid', url).toString(), 302);
  }
  const row = await env.NOTIFY_DB.prepare(
    'SELECT token FROM notify_subscriptions WHERE token = ? AND verify_key = ?'
  ).bind(token, key).first();
  if (!row?.token) return Response.redirect(new URL('/?notify=invalid', url).toString(), 302);
  await env.NOTIFY_DB.prepare(
    'UPDATE notify_subscriptions SET verified = 1, verify_key = NULL, updated_at = ? WHERE token = ?'
  ).bind(new Date().toISOString(), token).run();
  return Response.redirect(new URL('/?notify=confirmed', url).toString(), 302);
}

async function sendNotifyEmail(env, to, channelName, videoId) {
  const link = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const body = `---------------------------------------------\n${channelName}\nの配信予定が入りました📢\n\n↓↓通知をＯＮにしに行く↓↓\n${link}\n---------------------------------------------`;
  const subject = `【Vdule】${channelName}の配信予定が入りました`;
  await sendGasMail(env, to, subject, body);
}

async function runNotificationCron(env) {
  if (!env.NOTIFY_DB || !env.HOLODEX_API_KEY) return;
  await ensureNotifySchema(env);
  if (!env.GAS_NOTIFY_URL || !env.GAS_NOTIFY_SECRET) {
    console.warn('notification cron skipped: GAS mail provider not configured');
    return;
  }

  const channelRows = await env.NOTIFY_DB.prepare('SELECT DISTINCT channel_id FROM notify_channels').all();
  const channelIds = (channelRows.results || []).map(r => r.channel_id).filter(id => CHANNEL_ID.test(id));
  if (!channelIds.length) return;

  const streamMap = new Map();
  for (const group of chunksOf(channelIds, 20)) {
    try {
      const rows = await calendarStreamsForChannels(group, env.HOLODEX_API_KEY);
      for (const row of Array.isArray(rows) ? rows : []) if (row?.id) streamMap.set(row.id, row);
    } catch (err) {
      console.warn('notification calendar check failed', err?.message || err);
    }
  }

  const byChannel = new Map();
  for (const row of streamMap.values()) {
    const cid = row?.channel?.id || row?.channel_id || '';
    if (!CHANNEL_ID.test(cid)) continue;
    if (!byChannel.has(cid)) byChannel.set(cid, []);
    byChannel.get(cid).push(row);
  }

  for (const [channelId, rows] of byChannel) {
    const subs = await env.NOTIFY_DB.prepare(`SELECT s.token, s.email, c.channel_name, c.added_at
      FROM notify_channels c
      JOIN notify_subscriptions s ON s.token = c.token
      WHERE c.channel_id = ? AND s.verified = 1`).bind(channelId).all();
    for (const sub of subs.results || []) {
      for (const row of rows) {
        const videoId = String(row?.id || '');
        if (!videoId) continue;
        const exists = await env.NOTIFY_DB.prepare(
          'SELECT 1 AS ok FROM notify_sent WHERE token = ? AND video_id = ?'
        ).bind(sub.token, videoId).first();
        if (exists?.ok) continue;

        const published = new Date(row?.published_at || 0).getTime();
        const added = new Date(sub.added_at || 0).getTime();
        if (Number.isFinite(published) && Number.isFinite(added) && published > 0 && published <= added) {
          await env.NOTIFY_DB.prepare(
            'INSERT OR IGNORE INTO notify_sent (token, video_id, sent_at) VALUES (?, ?, ?)'
          ).bind(sub.token, videoId, new Date().toISOString()).run();
          continue;
        }

        try {
          await sendNotifyEmail(env, sub.email, sub.channel_name || row?.channel?.name || '登録中のVTuber', videoId);
          await env.NOTIFY_DB.prepare(
            'INSERT OR IGNORE INTO notify_sent (token, video_id, sent_at) VALUES (?, ?, ?)'
          ).bind(sub.token, videoId, new Date().toISOString()).run();
        } catch (err) {
          console.error('notification send failed', sub.email, videoId, err?.message || err);
        }
      }
    }
  }

  const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  await env.NOTIFY_DB.prepare('DELETE FROM notify_sent WHERE sent_at < ?').bind(cutoff).run();
}

async function handleHolodex(request, env, ctx) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';


  if (action === 'debugyoutube') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    if (!q) return json({ error: '検索語が空です。', workerVersion: VERSION }, 400);
    if (!env.YOUTUBE_API_KEY) {
      return json({ error: 'サーバーのYouTube APIキーが未設定です。', workerVersion: VERSION }, 503);
    }
    try {
      const result = await debugYouTubeSearch(q, env.YOUTUBE_API_KEY);
      return json(result, 200, 0);
    } catch (err) {
      return json({
        workerVersion: VERSION,
        q,
        debugFailed: true,
        name: err?.name || null,
        message: err?.message || String(err)
      }, 500, 0);
    }
  }

  // 推し追加の名前検索はYouTube公式APIを使う。
  if (action === 'search') {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    if (!q) {
      return json({ error: '検索語が空です。', workerVersion: VERSION }, 400);
    }
    if (!env.YOUTUBE_API_KEY) {
      return json({
        error: 'サーバーのYouTube APIキーが未設定です。',
        workerVersion: VERSION
      }, 503);
    }

    const cache = caches.default;
    const cacheUrl = new URL(url.toString());
    cacheUrl.searchParams.set('_worker', VERSION);
    cacheUrl.searchParams.set('_source', 'youtube');
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    try {
      const payload = await searchYouTubeChannels(q, env.YOUTUBE_API_KEY, env.HOLODEX_API_KEY || '');
      // 検索候補は6時間キャッシュして無料検索枠を節約。
      const response = json(payload, 200, 21600);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      console.error('YouTube search failed', err);
      return json({
        error: youtubeErrorMessage(err),
        workerVersion: VERSION,
        upstreamStatus: err instanceof YouTubeError ? err.status : null
      }, 502);
    }
  }



  if (action === 'analysis') {
    const ids = [...new Set(
      (url.searchParams.get('ids') || '')
        .split(',')
        .map(s => s.trim())
        .filter(id => CHANNEL_ID.test(id))
    )].slice(0, 20);

    if (!ids.length) return json([], 200, 900);
    if (!env.HOLODEX_API_KEY) {
      return json({
        error: 'サーバーのHolodex APIキーが未設定です。',
        workerVersion: VERSION
      }, 503);
    }

    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), 0, 1);
    const rawFrom = url.searchParams.get('from') || defaultFrom.toISOString();
    const rawTo = url.searchParams.get('to') || now.toISOString();
    const fromDate = new Date(rawFrom);
    const toDate = new Date(rawTo);

    if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime()) || fromDate > toDate) {
      return json({ error: '分析期間が正しくありません。' }, 400);
    }
    if (toDate.getTime() - fromDate.getTime() > 370 * 24 * 60 * 60 * 1000) {
      return json({ error: '分析期間は最大370日です。' }, 400);
    }

    const fromIso = fromDate.toISOString();
    const toIso = toDate.toISOString();
    const cache = caches.default;
    const cacheUrl = new URL(url.toString());
    cacheUrl.searchParams.set('_worker', VERSION);
    cacheUrl.searchParams.set('_source', 'analysis-history');
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    try {
      const payload = await analysisHistory(ids, env.HOLODEX_API_KEY, env.YOUTUBE_API_KEY || '', fromIso, toIso);
      const response = json(payload, 200, 1800);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      console.error('Analysis history failed', err);
      return json({
        error: 'データ分析用の配信履歴を取得できませんでした。',
        workerVersion: VERSION
      }, 502);
    }
  }


  if (action === 'history') {
    const ids = [...new Set(
      (url.searchParams.get('ids') || '')
        .split(',')
        .map(s => s.trim())
        .filter(id => CHANNEL_ID.test(id))
    )].slice(0, 20);

    if (!ids.length) return json([], 200, 300);
    if (!env.YOUTUBE_API_KEY) {
      return json({
        error: 'サーバーのYouTube APIキーが未設定です。',
        workerVersion: VERSION
      }, 503);
    }

    const cache = caches.default;
    const cacheUrl = new URL(url.toString());
    cacheUrl.searchParams.set('_worker', VERSION);
    cacheUrl.searchParams.set('_source', 'youtube-history');
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    try {
      const payload = await youtubeHistory(ids, env.YOUTUBE_API_KEY);
      const response = json(payload, 200, 600);
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      console.error('YouTube history failed', err);
      return json({
        error: youtubeErrorMessage(err),
        workerVersion: VERSION,
        upstreamStatus: err instanceof YouTubeError ? err.status : null
      }, 502);
    }
  }

  if (action === 'discover') {
    const excludeIds = [...new Set(
      (url.searchParams.get('exclude') || '')
        .split(',')
        .map(s => s.trim())
        .filter(id => CHANNEL_ID.test(id))
    )].slice(0, 60);

    if (!env.HOLODEX_API_KEY || !env.YOUTUBE_API_KEY) {
      return json({
        error: '新規開拓にはHolodex APIキーとYouTube APIキーの両方が必要です。',
        workerVersion: VERSION
      }, 503);
    }

    try {
      const payload = await discoverVtuber(excludeIds, env.HOLODEX_API_KEY, env.YOUTUBE_API_KEY);
      if (!payload?.channel) {
        return json({ error: '未登録のVTuber候補を見つけられませんでした。', workerVersion: VERSION }, 404);
      }
      return json(payload, 200, 0);
    } catch (err) {
      console.error('discover failed', err);
      return json({
        error: '新しいVTuberの取得に失敗しました。少ししてからもう一度試してください。',
        workerVersion: VERSION,
        upstreamStatus: err?.status || null
      }, 502);
    }
  }

  if (action === 'health') {
    let holodexUpstreamOk = false;
    let holodexUpstreamStatus = null;

    if (env.HOLODEX_API_KEY) {
      try {
        await holodex('/channels/UC5CwaMl1eIgY8h02uZw7u8A', env.HOLODEX_API_KEY);
        holodexUpstreamOk = true;
      } catch (err) {
        holodexUpstreamStatus = err?.status || null;
      }
    }

    return json({
      ok: true,
      workerVersion: VERSION,
      youtubeKeyConfigured: !!env.YOUTUBE_API_KEY,
      holodexKeyConfigured: !!env.HOLODEX_API_KEY,
      holodexUpstreamOk,
      holodexUpstreamStatus
    });
  }

  // LIVE・チャンネルID直接登録はこれまで通りHolodex。
  if (!env.HOLODEX_API_KEY) {
    return json({
      error: 'サーバーのHolodex APIキーが未設定です。',
      workerVersion: VERSION
    }, 503);
  }

  try {
    const cache = caches.default;
    const cacheUrl = new URL(url.toString());
    cacheUrl.searchParams.set('_worker', VERSION);
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    let payload;
    let ttl = 0;

    if (action === 'channel') {
      const id = (url.searchParams.get('id') || '').trim();

      if (!CHANNEL_ID.test(id)) {
        return json({ error: 'YouTubeチャンネルIDの形式が正しくありません。' }, 400);
      }

      const c = await getChannel(id, env.HOLODEX_API_KEY);
      if (!c) {
        return json({ error: 'VTuberチャンネルを取得できませんでした。' }, 404);
      }

      payload = c;
      ttl = 86400;
    } else if (action === 'calendar') {
      const ids = [...new Set(
        (url.searchParams.get('ids') || '')
          .split(',')
          .map(s => s.trim())
          .filter(id => CHANNEL_ID.test(id))
      )].slice(0, 20);

      if (!ids.length) return json([], 200, 300);
      payload = await calendarStreamsForChannels(ids, env.HOLODEX_API_KEY);
      ttl = 300;
    } else if (action === 'live') {
      const ids = [...new Set(
        (url.searchParams.get('ids') || '')
          .split(',')
          .map(s => s.trim())
          .filter(id => CHANNEL_ID.test(id))
      )].slice(0, 20);

      if (!ids.length) return json([], 200, 60);

      // 1) まずHolodexを優先して、登録中の推しのLIVE / Upcomingを取得。
      const data = await holodex(
        '/users/live?channels=' + encodeURIComponent(ids.join(',')),
        env.HOLODEX_API_KEY
      );

      const holodexRows = Array.isArray(data) ? data : [];
      const holodexLiveChannelIds = new Set(
        holodexRows
          .filter(v => v?.status === 'live')
          .map(v => v?.channel?.id || v?.channel_id || '')
          .filter(id => CHANNEL_ID.test(id))
      );

      // 2) Holodexで「現在LIVE」が見つからなかった登録チャンネルだけYouTube側を確認。
      const youtubeCheckIds = ids.filter(id => !holodexLiveChannelIds.has(id));
      let youtubeFallbackRows = [];

      if (youtubeCheckIds.length && env.YOUTUBE_API_KEY) {
        try {
          youtubeFallbackRows = await youtubeLiveFallback(youtubeCheckIds, env.YOUTUBE_API_KEY);
        } catch (err) {
          // YouTube補完が失敗してもHolodexの結果はそのまま返す。
          console.warn('YouTube live fallback failed', err?.status || '', err?.message || err);
          youtubeFallbackRows = [];
        }
      }

      // 3) YouTubeでLIVE確認できた配信を追加。動画IDが重なったらYouTube側のLIVE判定を優先。
      const merged = new Map();
      for (const row of holodexRows) if (row?.id) merged.set(row.id, row);
      for (const row of youtubeFallbackRows) if (row?.id) merged.set(row.id, row);

      payload = await enrichLiveRows([...merged.values()], env.HOLODEX_API_KEY);
      ttl = 90;
    } else {
      return json({ error: '不明なAPI操作です。' }, 400);
    }

    const response = json(payload, 200, ttl);
    if (ttl > 0) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    console.error('handleHolodex failed', err);

    const status = err instanceof HolodexError ? err.status : null;
    const message = status === 401 || status === 403
      ? 'Holodex APIキーが拒否されました。CloudflareのRuntime Secretを確認してください。'
      : '配信情報サービスへの接続に失敗しました。少ししてから再試行してください。';

    return json({
      error: message,
      workerVersion: VERSION,
      upstreamStatus: status
    }, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/notify/')) {
      return handleNotify(request, env);
    }

    if (url.pathname === '/api/holodex') {
      if (request.method !== 'GET') {
        return json({ error: 'Method Not Allowed' }, 405);
      }

      return handleHolodex(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runNotificationCron(env));
  }
};
　
