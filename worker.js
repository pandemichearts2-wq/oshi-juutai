const BASE = 'https://holodex.net/api/v2';
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VERSION = 'search-fix-v5-jp-alias';

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
    lang: c.lang || ''
  };
}

function normalize(s = '') {
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　._・･ー\-]/g, '');
}

function channelScore(c, q) {
  const needle = normalize(q);
  const name = normalize(c?.name || '');
  const en = normalize(c?.english_name || '');
  let score = 0;

  if (name === needle || en === needle) score += 10000;
  if (name.startsWith(needle) || en.startsWith(needle)) score += 3000;
  if (name.includes(needle) || en.includes(needle)) score += 1500;
  if (c?.type === 'vtuber') score += 100;
  if (c?.org) score += 10;
  return score;
}

function isMatchingChannel(c, q) {
  const needle = normalize(q);
  if (!needle) return false;
  const name = normalize(c?.name || '');
  const en = normalize(c?.english_name || '');
  return name.includes(needle) || en.includes(needle);
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
    const raw = await holodex('/search/videoSearch', apiKey, {
      method: 'POST',
      body: {
        sort: 'newest',
        target: ['stream'],
        conditions: [{ text: q }],
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
      if (!c) continue;
      if (!CHANNEL_ID.test(c.id || '')) continue;
      if (c.type && c.type !== 'vtuber') continue;

      const min = minimalChannel(c);
      const title = normalize(v?.title || v?.name || '');
      const channelMatch = isMatchingChannel(min, q);
      const titleMatch = !!needle && title.includes(needle);

      // Holodexでは日本語のタレント名とYouTubeチャンネル名が一致しない場合がある。
      // 例: 「星街すいせい」で検索しても、チャンネル名が
      // "Hoshimachi Suisei" / "Suisei Channel" 系だと名前一致だけでは落ちる。
      // そのため、動画タイトルに検索語が含まれる本人チャンネルも候補に残す。
      if (!channelMatch && !titleMatch) continue;

      const prev = stats.get(min.id) || { channel: min, titleHits: 0, channelMatch: false };
      prev.titleHits += titleMatch ? 1 : 0;
      prev.channelMatch = prev.channelMatch || channelMatch;
      stats.set(min.id, prev);
    }

    const ranked = [...stats.values()]
      .sort((a, b) => {
        const aScore = channelScore(a.channel, q) + a.titleHits * 1200 + (a.channelMatch ? 3000 : 0);
        const bScore = channelScore(b.channel, q) + b.titleHits * 1200 + (b.channelMatch ? 3000 : 0);
        return bScore - aScore;
      })
      .slice(0, 10);

    const full = await mapLimited(ranked, 3, async item => {
      const c = await getChannel(item.channel.id, apiKey);
      return c || item.channel;
    });

    return full.filter(Boolean);
  } catch (err) {
    console.warn('videoSearch failed', err?.status || '', err?.message || err);
    return [];
  }
}

async function searchCatalog(q, apiKey) {
  const map = new Map();

  for (let offset = 0; offset < 400; offset += 50) {
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
      if (!c) continue;
      if (!CHANNEL_ID.test(c.id || '')) continue;
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
    if (c?.id) merged.set(c.id, c);
  }

  // 候補が少ないときだけチャンネル一覧も補助検索する。
  if (merged.size < 3) {
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
  if (!env.HOLODEX_API_KEY) {
    return json({
      error: 'サーバーのHolodex APIキーが未設定です。',
      workerVersion: VERSION
    }, 503);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';

  try {
    if (action === 'search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 60);

      if (!q) {
        return json({
          error: '検索語が空です。',
          workerVersion: VERSION
        }, 400);
      }

      const payload = await searchChannels(q, env.HOLODEX_API_KEY);
      return json(payload, 200, 0);
    }

    if (action === 'health') {
      let upstreamOk = false;
      let upstreamStatus = null;

      try {
        await holodex('/channels/UC5CwaMl1eIgY8h02uZw7u8A', env.HOLODEX_API_KEY);
        upstreamOk = true;
      } catch (err) {
        upstreamStatus = err?.status || null;
      }

      return json({
        ok: true,
        workerVersion: VERSION,
        holodexKeyConfigured: true,
        upstreamOk,
        upstreamStatus
      });
    }

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

    if (ttl > 0) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

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
