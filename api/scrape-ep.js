const cheerio = require('cheerio');

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

const LEAGUE_FACTORS = {
  NHL: 1.00, KHL: 0.71, SHL: 0.54, AHL: 0.53, NL: 0.51, NLA: 0.51,
  Liiga: 0.48, Czech: 0.48, Czechia: 0.48, DEL: 0.38, VHL: 0.36,
  Allsvenskan: 0.33, HockeyAllsvenskan: 0.33, ICEHL: 0.28, Slovakia: 0.27,
  NCAA: 0.26, 'Hockey East': 0.26, 'Big Ten': 0.26, NCHC: 0.26, ECAC: 0.26,
  CCHA: 0.26, ECHL: 0.25, OHL: 0.21, SL: 0.21, Mestis: 0.20, USHL: 0.18,
  MHL: 0.17, WHL: 0.17, QMJHL: 0.16, BCHL: 0.11, AJHL: 0.10, OJHL: 0.09,
  NAHL: 0.12, 'J20 Nationell': 0.13, 'J20 SuperElit': 0.13
};

function getNF(lg) {
  if (!lg) return null;
  const k = lg.trim();
  if (LEAGUE_FACTORS[k] !== undefined) return LEAGUE_FACTORS[k];
  const kl = k.toLowerCase();
  for (const key of Object.keys(LEAGUE_FACTORS)) {
    if (key.toLowerCase() === kl) return LEAGUE_FACTORS[key];
  }
  return null;
}

function calcNHLe(pts, gp, lg) {
  const f = getNF(lg);
  if (!f || !gp || gp < 5) return 0;
  return +((pts * f / gp) * 82).toFixed(2);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = req.query.url || (req.body && req.body.url);
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const m = url.match(/eliteprospects\.com\/player\/(\d+)/);
  if (!m) return res.status(400).json({ error: 'Invalid EP URL' });

  const playerId = m[1];

  if (cache.has(playerId)) {
    const cached = cache.get(playerId);
    if (Date.now() - cached.ts < CACHE_TTL) {
      return res.status(200).json({ ...cached.data, cached: true });
    }
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `EP returned ${response.status}`,
        details: response.statusText
      });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const name = $('h1').first().text().trim() || $('title').text().split('|')[0].trim();

    let position = 'F';
    const posText = $('body').text();
    const posMatch = posText.match(/Position[:\s]+([CLRWD\/]+)/i);
    if (posMatch) {
      const p = posMatch[1].toUpperCase();
      if (p === 'D' || p.includes('D')) position = 'D';
    }

    let draftPick = null;
    const draftMatch = posText.match(/(\d+)(?:st|nd|rd|th)\s+overall/i);
    if (draftMatch) draftPick = parseInt(draftMatch[1]);

    const seasons = [];
    $('table').each((i, table) => {
      const $t = $(table);
      const headers = [];
      $t.find('thead th, tr').first().find('th, td').each((j, h) => {
        headers.push($(h).text().trim().toUpperCase());
      });
      
      const hasGP = headers.some(h => h === 'GP');
      const hasPts = headers.some(h => h === 'TP' || h === 'PTS' || h === 'P');
      if (!hasGP || !hasPts) return;

      const gpIdx = headers.findIndex(h => h === 'GP');
      const ptsIdx = headers.findIndex(h => h === 'TP' || h === 'PTS' || h === 'P');
      const seasonIdx = 0;
      const leagueIdx = headers.findIndex(h => h === 'LEAGUE') !== -1 
        ? headers.findIndex(h => h === 'LEAGUE') : 2;

      $t.find('tbody tr, tr').each((j, row) => {
        const cells = $(row).find('td');
        if (cells.length < 4) return;

        const seasonText = $(cells[seasonIdx]).text().trim();
        const leagueText = $(cells[leagueIdx]).text().trim();
        const gp = parseInt($(cells[gpIdx]).text().trim()) || 0;
        const pts = parseInt($(cells[ptsIdx]).text().trim()) || 0;

        if (gp < 1 || !seasonText.match(/\d{4}/)) return;

        const yearMatch = seasonText.match(/(\d{4})-?(\d{2,4})?/);
        if (!yearMatch) return;
        const startYear = parseInt(yearMatch[1]);
        const endYear = yearMatch[2]
          ? (yearMatch[2].length === 2 ? parseInt(yearMatch[1].slice(0,2) + yearMatch[2]) : parseInt(yearMatch[2]))
          : startYear + 1;

        seasons.push({
          year: endYear,
          league: leagueText,
          gp,
          pts,
          nhle: calcNHLe(pts, gp, leagueText)
        });
      });
    });

    seasons.sort((a, b) => a.year - b.year);

    let nhlIdx = seasons.findIndex(s => s.league === 'NHL' && s.gp >= 20);
    if (nhlIdx === -1) nhlIdx = seasons.length - 1;

    seasons.forEach((s, i) => {
      const diff = i - nhlIdx + 1;
      s.dl = diff === 0 ? 'D0' : diff > 0 ? `D+${diff}` : `D${diff}`;
    });

    const data = {
      name, position, draftPick, seasons, source: 'EliteProspects',
      scrapedAt: new Date().toISOString()
    };

    cache.set(playerId, { ts: Date.now(), data });

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({
      error: 'Scrape failed',
      details: err.message
    });
  }
};
