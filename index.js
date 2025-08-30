// api/index.js

const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const TMDB_API_KEY = '49c4965e452d44430e00626adada2a45';

const manifest = {
  id: 'org.cineby',
  version: '3.0.0',
  name: 'Cineby',
  description: 'Stream movies & full series from Cineby.app with automatic episodes, multi-server, and subtitles',
  resources: ['stream', 'meta', 'catalog'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'cineby_movies', name: 'Cineby Movies' },
    { type: 'series', id: 'cineby_series', name: 'Cineby Series' }
  ]
};

const builder = new addonBuilder(manifest);

// --- Simple in-memory cache per request (resets between requests) ---
const cache = new Map();

// --- Utility functions ---

async function tmdbToTitle(id) {
  try {
    const parts = id.split('/');
    const type = parts[0] === 'tmdb' && parts[2] ? 'tv' : 'movie';
    const tmdbId = parts[1];
    const resp = await axios.get(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}`);
    return resp.data.title || resp.data.name;
  } catch (err) {
    console.error('TMDb title fetch error:', err.message);
    return null;
  }
}

async function fetchPosterAndDescription(title) {
  try {
    const resp = await axios.get(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`);
    const results = resp.data.results;
    if (results && results.length) {
      return {
        poster: `https://image.tmdb.org/t/p/w500${results[0].poster_path}`,
        description: results[0].overview
      };
    }
    return { poster: null, description: '' };
  } catch {
    return { poster: null, description: '' };
  }
}

async function searchCineby(title) {
  if (cache.has(`search:${title}`)) return cache.get(`search:${title}`);
  try {
    const resp = await axios.get(`https://www.cineby.app/search?query=${encodeURIComponent(title)}`);
    const $ = cheerio.load(resp.data);
    const href = $('.result a').attr('href');
    const url = href.startsWith('http') ? href : `https://www.cineby.app${href}`;
    cache.set(`search:${title}`, url);
    return url;
  } catch {
    return null;
  }
}

// --- Scraping functions ---

async function getMovieStreams(title) {
  const cacheKey = `movie:${title}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const moviePage = await searchCineby(title);
  if (!moviePage) return [];

  try {
    const resp = await axios.get(moviePage, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(resp.data);
    const streams = [];

    $('iframe, video').each((i, el) => {
      const src = $(el).attr('src') || $(el).find('source').attr('src');
      if (src) {
        const subs = [];
        $(el).find('track[kind="subtitles"]').each((i, t) => subs.push({ url: $(t).attr('src'), lang: $(t).attr('srclang') || 'en' }));
        streams.push({ title: 'Cineby', url: src, lang: 'en', rel: ['native'], subtitles: subs });
      }
    });

    cache.set(cacheKey, streams);
    return streams;
  } catch (err) {
    console.error('Movie stream scraping error:', err.message);
    return [];
  }
}

async function getSeriesEpisodes(title) {
  const cacheKey = `series:${title}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const seriesPage = await searchCineby(title);
  if (!seriesPage) return [];

  try {
    const resp = await axios.get(seriesPage, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(resp.data);
    const episodesList = [];

    $('[id^=season-]').each((s, seasonEl) => {
      const seasonNum = $(seasonEl).attr('id').replace('season-', '');
      $(seasonEl).find('.episode').each((e, epEl) => {
        const episodeNum = $(epEl).data('episode') || e + 1;
        const iframe = $(epEl).find('iframe, video').attr('src') || $(epEl).find('source').attr('src');
        const subtitles = [];
        $(epEl).find('track[kind="subtitles"]').each((i, t) => subtitles.push({ url: $(t).attr('src'), lang: $(t).attr('srclang') || 'en' }));

        if (iframe) {
          episodesList.push({
            season: seasonNum,
            episode: episodeNum,
            streams: [{ title: 'Cineby', url: iframe, lang: 'en', rel: ['native'], subtitles }]
          });
        }
      });
    });

    cache.set(cacheKey, episodesList);
    return episodesList;
  } catch (err) {
    console.error('Series scraping error:', err.message);
    return [];
  }
}

// --- Stremio Handlers ---

builder.defineMetaHandler(async ({ id }) => {
  const title = await tmdbToTitle(id);
  if (!title) return {};
  const { poster, description } = await fetchPosterAndDescription(title);
  return { id, type: 'movie', name: title, poster, description };
});

builder.defineStreamHandler(async ({ id }) => {
  const parts = id.split('/');
  const title = await tmdbToTitle(id);
  if (!title) return { streams: [] };

  if (parts.length >= 4) {
    const season = parts[2];
    const episode = parts[3];
    const episodes = await getSeriesEpisodes(title);
    const epData = episodes.find(ep => ep.season == season && ep.episode == episode);
    return { streams: epData ? epData.streams : [] };
  } else {
    const streams = await getMovieStreams(title);
    return { streams };
  }
});

// --- Vercel serverless handler ---
module.exports = async (req, res) => {
  const addonInterface = builder.getInterface();
  await addonInterface(req, res);
};
