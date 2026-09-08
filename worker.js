const BASE = 'https://holodex.net/api/v2';
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

function json(data, status = 200, ttl = 0) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': ttl > 0 ? `public, max-age=${ttl}` : 'no-store'
  };
  return new Response(JSON.stringify(data), { status, headers });
}

async function holodexGet(path, apiKey) {
  const res = await fetch(BASE + path, {
    headers: {
      'X-APIKEY': apiKey,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Holodex GET ${res.status}: ${path} ${text.slice(0, 160)}`);
  }
  return res.json();
}

function minimalChannel(c) {
  if (!c) return null;
  return {
    id: c.id || '',
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
  if (name === needle || en === needle) score += 10000;
  if (name.startsWith(needle) || en.startsWith(needle)) score += 3000;
  if (name.includes(needle) || en.includes(needle)) score += 1500;
  if (c?.type === 'vtuber') score += 100;
  if (c?.org) score += 10;
  return score;
}

function isMatchingChannel(c, q) {
  const n = normalize(q);
  if (!n) return false;
  return normalize(c?.name || '').includes(n) || normalize(c?.english_name || '').includes(n);
}

async function getChannel(id, apiKey) {
  if (!CHANNEL_ID.test(id || '')) return null;
  try {
    const c = await holodexGet('/channels/' + encodeURIComponent(id), apiKey);
    if (!c || (c.type && c.type !== 'vtuber')) return null;
    return minimalChannel(c);
  } catch {
    return null;
  }
}

async function searchAutocomplete(q, apiKey) {
  try {
    // Holodex の実際のAutocompleteは配列 [{type,value,text}, ...] を返す。
    const raw = await holodexGet('/search/autocomplete?q=' + encodeURIComponent(q), apiKey);
    const rows = Array.isArray(raw) ? raw : [];

    const ids = [...new Set(rows.map(row => {
      if (typeof row === 'string') return CHANNEL_ID.test(row) ? row : '';
      const candidates = [row?.value, row?.id, row?.channel_id];
      return candidates.find(v => typeof v === 'string' && CHANNEL_ID.test(v)) || '';
    }).filter(Boolean))].slice(0, 12);

    if (!ids.length) return [];

    const channels = (await Promise.all(ids.map(id => getChannel(id, apiKey)))).filter(Boolean);
    return channels
      .sort((a, b) => channelScore(b, q) - channelScore(a, q))
      .slice(0, 10);
  } catch (err) {
    console.warn('autocomplete failed', err);
    return [];
  }
}

async function searchCatalog(q, apiKey) {
  // Autocompleteが一時的に空になる場合の保険。
  // 人気順のVTuberを最大500件だけ調べるので、主要VTuberはここでも拾える。
  const offsets = Array.from({ length: 10 }, (_, i) => i * 50);
  const pages = await Promise.all(offsets.map(async offset => {
    try {
      return await holodexGet(
        `/channels?type=vtuber&limit=50&offset=${offset}&sort=subscriber_count&order=desc`,
        apiKey
      );
    } catch {
      return [];
    }
  }));

  const map = new Map();
  for (const c of pages.flat()) {
    if (!c || !CHANNEL_ID.test(c.id || '') || (c.type && c.type !== 'vtuber')) continue;
    if (isMatchingChannel(c, q)) map.set(c.id, minimalChannel(c));
  }
  return [...map.values()]
    .sort((a, b) => channelScore(b, q) - channelScore(a, q))
    .slice(0, 10);
}

async function searchChannels(q, apiKey) {
  const primary = await searchAutocomplete(q, apiKey);
  if (primary.length) return primary;
  return searchCatalog(q, apiKey);
}

async function enrichLiveRows(rows, apiKey) {
  const arr = Array.isArray(rows) ? rows : [];
  const ids = [...new Set(arr.map(v => v?.channel?.id || v?.channel_id).filter(id => CHANNEL_ID.test(id || '')))];
  const channelMap = new Map();

  await Promise.all(ids.map(async id => {
    const c = await getChannel(id, apiKey);
    if (c) channelMap.set(id, c);
  }));

  return arr.map(v => {
    const cid = v?.channel?.id || v?.channel_id || '';
    const c = channelMap.get(cid);
    return c ? { ...v, channel: { ...(v.channel || {}), ...c } } : v;
  });
}

async function handleHolodex(request, env, ctx) {
  if (!env.HOLODEX_API_KEY) {
    return json({ error: 'サーバーのHolodex APIキーが未設定です。' }, 503);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';

  try {
    // 検索だけはキャッシュしない。修正前の空結果が残る事故を防ぐ。
    if (action === 'search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
      if (!q) return json({ error: '検索語が空です。' }, 400);
      const payload = await searchChannels(q, env.HOLODEX_API_KEY);
      return json(payload, 200, 0);
    }

    if (action === 'health') {
      return json({ ok: true, holodexKeyConfigured: true, workerVersion: 'search-fix-v3' });
    }

    const cache = caches.default;
    // Worker更新前のキャッシュと衝突しないようにバージョンをキーへ入れる。
    const cacheUrl = new URL(url.toString());
    cacheUrl.searchParams.set('_worker', 'v3');
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    let payload;
    let ttl = 0;

    if (action === 'channel') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!CHANNEL_ID.test(id)) return json({ error: 'YouTubeチャンネルIDの形式が正しくありません。' }, 400);
      const c = await getChannel(id, env.HOLODEX_API_KEY);
      if (!c) return json({ error: 'VTuberチャンネルを取得できませんでした。' }, 404);
      payload = c;
      ttl = 86400;
    } else if (action === 'live') {
      const ids = [...new Set((url.searchParams.get('ids') || '')
        .split(',')
        .map(s => s.trim())
        .filter(id => CHANNEL_ID.test(id)))].slice(0, 20);

      if (!ids.length) return json([], 200, 60);

      const data = await holodexGet(
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
      if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
      return handleHolodex(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  }
};
