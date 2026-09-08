const BASE = 'https://holodex.net/api/v2';
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

function json(data, status = 200, ttl = 0) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  };
  if (ttl > 0) headers['Cache-Control'] = `public, max-age=${ttl}`;
  else headers['Cache-Control'] = 'no-store';
  return new Response(JSON.stringify(data), { status, headers });
}

async function holodex(path, apiKey) {
  const res = await fetch(BASE + path, {
    headers: {
      'X-APIKEY': apiKey,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`Holodex ${res.status}`);
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

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.HOLODEX_API_KEY) {
    return json({ error: 'サーバーのHolodex APIキーが未設定です。運営者側の設定が必要です。' }, 503);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  try {
    let payload;
    let ttl = 0;

    if (action === 'search') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
      if (!q) return json({ error: '検索語が空です。' }, 400);
      const ac = await holodex('/search/autocomplete?q=' + encodeURIComponent(q), env.HOLODEX_API_KEY);
      const ids = [...new Set((Array.isArray(ac) ? ac : [])
        .map(x => x && x.value)
        .filter(v => typeof v === 'string' && CHANNEL_ID.test(v)))].slice(0, 8);
      const info = (await Promise.all(ids.map(async id => {
        try { return await holodex('/channels/' + encodeURIComponent(id), env.HOLODEX_API_KEY); }
        catch { return null; }
      }))).filter(c => c && c.type === 'vtuber').map(minimalChannel);
      payload = info;
      ttl = 3600;
    } else if (action === 'channel') {
      const id = (url.searchParams.get('id') || '').trim();
      if (!CHANNEL_ID.test(id)) return json({ error: 'YouTubeチャンネルIDの形式が正しくありません。' }, 400);
      const c = await holodex('/channels/' + encodeURIComponent(id), env.HOLODEX_API_KEY);
      if (c && c.type && c.type !== 'vtuber') return json({ error: 'VTuberチャンネルではありません。' }, 400);
      payload = minimalChannel(c);
      ttl = 86400;
    } else if (action === 'live') {
      const ids = [...new Set((url.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(id => CHANNEL_ID.test(id)))].slice(0, 20);
      if (!ids.length) return json([], 200, 60);
      const chunks = await Promise.all(ids.map(async id => {
        try {
          const data = await holodex('/live?channel_id=' + encodeURIComponent(id) + '&max_upcoming_hours=168&limit=50', env.HOLODEX_API_KEY);
          return Array.isArray(data) ? data : [];
        } catch { return []; }
      }));
      const byId = new Map();
      for (const v of chunks.flat()) if (v && v.id) byId.set(v.id, v);
      payload = [...byId.values()];
      ttl = 90;
    } else {
      return json({ error: '不明なAPI操作です。' }, 400);
    }

    const response = json(payload, 200, ttl);
    if (cache && ttl > 0) context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    console.error(err);
    return json({ error: '配信情報サービスへの接続に失敗しました。少ししてから再試行してください。' }, 502);
  }
}
