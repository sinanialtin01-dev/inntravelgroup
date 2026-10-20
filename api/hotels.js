// Vercel Serverless Function: POST /api/hotels
// Env vars (Vercel → Settings → Environment Variables):
//   RATEHAWK_KEY_ID, RATEHAWK_API_KEY   — from your RateHawk API account
//   RATEHAWK_BASE   (optional) default https://api.worldota.net  (use the sandbox URL RateHawk gives you while testing)
//   RESIDENCY       (optional) guest residency country code, default "xk" — confirm with RateHawk
//   MARKUP_PERCENT  (optional) agency markup added to the price, e.g. 10
// Without keys it returns { demo: true } and the site shows sample results.

const CITY_QUERY = { istanbul: 'Istanbul', barcelona: 'Barcelona', roma: 'Rome', milano: 'Milan', paris: 'Paris', dubai: 'Dubai', maldives: 'Maldives' };
const regionCache = new Map();
const infoCache = new Map();

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const { RATEHAWK_KEY_ID: id, RATEHAWK_API_KEY: key } = process.env;
  if (!id || !key) return res.status(200).json({ demo: true, hotels: [] });

  const base = (process.env.RATEHAWK_BASE || 'https://api.worldota.net') + '/api/b2b/v3';
  const auth = 'Basic ' + Buffer.from(id + ':' + key).toString('base64');
  const call = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.status !== 'ok') throw new Error(path + ': ' + (j.error || r.status));
    return j.data;
  };

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { city, checkin, checkout } = b;
    const adults = Math.max(1, Math.min(12, +b.adults || 2));
    const kids = Math.max(0, Math.min(8, +b.kids || 0));
    const language = b.language || 'en';
    if (!CITY_QUERY[city] || !/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) return res.status(400).json({ error: 'params' });

    // 1. region id for the city
    let regionId = regionCache.get(city);
    if (!regionId) {
      const d = await call('/search/multicomplete/', { query: CITY_QUERY[city], language });
      const reg = (d.regions || []).find(r => /city|multi/i.test(r.type || '')) || (d.regions || [])[0];
      if (!reg) throw new Error('region');
      regionId = reg.id; regionCache.set(city, regionId);
    }

    // 2. guests: split adults into rooms of max 2, kids go in the first room (age 8 by default)
    const rooms = [];
    for (let a = adults; a > 0; a -= 2) rooms.push({ adults: Math.min(2, a), children: [] });
    rooms[0].children = Array(kids).fill(8);

    // 3. search
    const serp = await call('/search/serp/region/', {
      checkin, checkout, residency: process.env.RESIDENCY || 'xk', language, guests: rooms,
      region_id: regionId, currency: 'EUR', hotels_limit: 30
    });

    const markup = 1 + (+process.env.MARKUP_PERCENT || 0) / 100;
    const list = (serp.hotels || []).map(h => {
      const best = (h.rates || []).map(r => ({ r, amount: +((r.payment_options?.payment_types || [])[0]?.show_amount || Infinity) }))
        .sort((x, y) => x.amount - y.amount)[0];
      return best && isFinite(best.amount) ? { h, rate: best.r, amount: best.amount } : null;
    }).filter(Boolean).sort((a, b) => a.amount - b.amount).slice(0, 12);

    // 4. static info (name, stars, photo). Cached in memory; for production RateHawk recommends a preloaded content dump.
    const hotels = await Promise.all(list.map(async ({ h, rate, amount }) => {
      const hid = h.hid ?? h.id;
      let info = infoCache.get(hid);
      if (!info) {
        try { info = await call('/hotel/info/', h.hid ? { hid: h.hid, language } : { id: h.id, language }); infoCache.set(hid, info); } catch { info = {}; }
      }
      const img = (info.images_ext?.[0]?.url || info.images?.[0] || '').replace('{size}', '640x400');
      return {
        id: String(hid), name: info.name || h.id, stars: info.star_rating || 0, address: info.address || '',
        image: img, room: rate.room_name || '', meal: rate.meal_data?.value || rate.meal || '',
        price: Math.round(amount * markup), currency: (rate.payment_options?.payment_types || [])[0]?.show_currency_code || 'EUR'
      };
    }));

    res.setHeader('Cache-Control', 's-maxage=300');
    return res.status(200).json({ hotels });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'ratehawk' });
  }
};
