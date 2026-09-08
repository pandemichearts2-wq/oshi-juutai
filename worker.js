const BASE = 'https://holodex.net/api/v2';
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VERSION = 'youtube-search-v9-mixed';


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

    // チャンネル検索結果なら id.channelId。
    // 動画・再生リストなら snippet.channelId = その投稿元チャンネル。
    const id = kind === 'youtube#channel'
      ? (item?.id?.channelId || '')
      : (snippet.channelId || '');

    if (!CHANNEL_ID.test(id)) return;

    const prev = stats.get(id) || {
      id,
      hits: 0,
      directChannel: false,
      firstRank: rank
    };

    prev.hits += 1;
    prev.directChannel = prev.directChannel || kind === 'youtube#channel';
    prev.firstRank = Math.min(prev.firstRank, rank);
    stats.set(id, prev);
  });

  const ids = [...stats.keys()];
  if (!ids.length) return [];

  const detailRows = await youtubeChannelsByIds(ids, youtubeKey);
  let candidates = detailRows
    .map(youtubeChannelFromDetail)
    .filter(Boolean)
    .map(c => ({ c, meta: stats.get(c.id) || {} }))
    .sort((a, b) => scoreYoutubeCandidate(b.c, q, b.meta) - scoreYoutubeCandidate(a.c, q, a.meta))
    .slice(0, 10);

  // Holodexに登録済みなら所属・英語名だけ補う。
  // YouTubeの検索順位・名前・画像は維持し、Holodex未登録でも候補から落とさない。
  if (holodexKey && candidates.length) {
    const enriched = await mapLimited(candidates, 4, async entry => {
      const h = await getChannel(entry.c.id, holodexKey);
      return { ...entry, h };
    });

    candidates = enriched.map(entry => ({
      ...entry,
      c: {
        ...entry.c,
        english_name: entry.h?.english_name || '',
        org: entry.h?.org || '',
        lang: entry.h?.lang || entry.c.lang || '',
        holodex_verified: !!entry.h
      }
    }));
  }

  return candidates.map(x => x.c).slice(0, 10);
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

async function handleHolodex(request, env, ctx) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';

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
    } else if (action === 'live') {
      const ids = [...new Set(
        (url.searchParams.get('ids') || '')
          .split(',')
          .map(s => s.trim())
          .filter(id => CHANNEL_ID.test(id))
      )].slice(0, 20);

      if (!ids.length) return json([], 200, 60);

      const data = await holodex(
        '/users/live?channels=' + encodeURIComponent(ids.join(',')),
        env.HOLODEX_API_KEY
      );

      payload = await enrichLiveRows(data, env.HOLODEX_API_KEY);
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

    if (url.pathname === '/api/holodex') {
      if (request.method !== 'GET') {
        return json({ error: 'Method Not Allowed' }, 405);
      }

      return handleHolodex(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  }
};
　
