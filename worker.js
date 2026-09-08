const BASE = 'https://holodex.net/api/v2';
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

function json(data, status = 200, ttl = 0) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  };
  headers['Cache-Control'] = ttl > 0 ? `public, max-age=${ttl}` : 'no-store';
  return new Response(JSON.stringify(data), { status, headers });
}

async function holodexGet(path, apiKey) {
  const res = await fetch(BASE + path, {
    headers: {
      'X-APIKEY': apiKey,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`Holodex GET ${res.status}: ${path}`);
  return res.json();
}

async function holodexPost(path, body, apiKey) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'X-APIKEY': apiKey,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Holodex POST ${res.status}: ${path}`);
  return res.json();
}

function minimalChannel(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name || '',
    english_name: c.english_name || '',
    photo: c.photo || c.thumbnail || '',
    thumbnail: c.thumbnail || c.photo || '',
    org: c.org || '',
    type: c.type || '',
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
  if (name === needle || en === needle) score += 1000;
  if (name.startsWith(needle) || en.startsWith(needle)) score += 500;
  if (name.includes(needle) || en.includes(needle)) score += 300;
  if (c?.type === 'vtuber') score += 50;
  if (c?.org) score += 5;
  return score;
}

async function searchFromAutocomplete(q, apiKey) {
  try {
    const ac = await holodexGet('/search/autocomplete?q=' + encodeURIComponent(q), apiKey);
    const rows = Array.isArray(ac)
      ? ac
      : Array.isArray(ac?.contents)
        ? ac.contents
        : Array.isArray(ac?.items)
          ? ac.items
          : [];

    const ids = [...new Set(rows
      .map(x => {
        if (typeof x === 'string') return x;
        return x?.value || x?.id || x?.channel_id || '';
      })
      .filter(v => typeof v === 'string' && CHANNEL_ID.test(v)))].slice(0, 10);

    if (!ids.length) return [];

    const info = (await Promise.all(ids.map(async id => {
      try {
        return await holodexGet('/channels/' + encodeURIComponent(id), apiKey);
      } catch {
        return null;
      }
    })))
      .filter(c => c && (!c.type || c.type === 'vtuber'))
      .map(minimalChannel);

    return info;
  } catch (err) {
    console.warn('Holodex autocomplete unavailable; using documented search fallback.', err);
    return [];
  }
}

async function searchFromVideos(q, apiKey) {
  const body = {
    sort: 'newest',
    target: ['stream'],
    conditions: [{ text: q }],
    topic: [],
    vch: [],
    org: [],
    comment: [],
    paginated: true,
    offset: 0,
    limit: 40
  };

  const result = await holodexPost('/search/videoSearch', body, apiKey);
  const rows = Array.isArray(result)
    ? result
    : Array.isArray(result?.items)
      ? result.items
      : [];

  const channels = new Map();
  for (const video of rows) {
    const c = video?.channel;
    if (!c || !CHANNEL_ID.test(c.id || '') || (c.type && c.type !== 'vtuber')) continue;
    if (!channels.has(c.id)) channels.set(c.id, minimalChannel(c));
  }

  return [...channels.values()]
    .sort((a, b) => channelScore(b, q) - channelScore(a, q))
    .slice(0, 10);
}

async function searchChannels(q, apiKey) {
  const primary = await searchFromAutocomplete(q, apiKey);
  if (primary.length) {
    return primary
      .sort((a, b) => channelScore(b, q) - channelScore(a, q))
      .slice(0, 10);
  }
  return searchFromVideos(q, apiKey);
}

async function handleHolodex(request, env, ctx) {
  if (!env.HOLODEX_API_KEY) {
    return json({ error: 'サーバーのHolodex APIキーが未設定です。運営者側の設定が必要です。' }, 503);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    let payload;
    let ttl = 0;

    if (action === 'search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
      if (!q) return json({ error: '検索語が空です。' }, 400);

      payload = await searchChannels(q, env.HOLODEX_API_KEY);
      ttl = 1800;
    } else if (action === 'channel') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!CHANNEL_ID.test(id)) return json({ error: 'YouTubeチャンネルIDの形式が正しくありません。' }, 400);

      const c = await holodexGet('/channels/' + encodeURIComponent(id), env.HOLODEX_API_KEY);
      if (c && c.type && c.type !== 'vtuber') return json({ error: 'VTuberチャンネルではありません。' }, 400);

      payload = minimalChannel(c);
      ttl = 86400;
    } else if (action === 'live') {
      const ids = [...new Set((url.searchParams.get('ids') || '')
        .split(',')
        .map(s => s.trim())
        .filter(id => CHANNEL_ID.test(id)))].slice(0, 20);

      if (!ids.length) return json([], 200, 60);

      // Holodex公式が固定チャンネル群のLIVE/Upcoming取得に推奨している軽量エンドポイント。
      const data = await holodexGet(
        '/users/live?channels=' + encodeURIComponent(ids.join(',')),
        env.HOLODEX_API_KEY
      );
      payload = Array.isArray(data) ? data : [];
      ttl = 90;
    } else if (action === 'health') {
      payload = { ok: true, holodexKeyConfigured: true };
      ttl = 0;
    } else {
      return json({ error: '不明なAPI操作です。' }, 400);
    }

    const response = json(payload, 200, ttl);
    if (ttl > 0) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    console.error(err);
    return json({
      error: '配信情報サービスへの接続に失敗しました。少ししてから再試行してください。'
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
