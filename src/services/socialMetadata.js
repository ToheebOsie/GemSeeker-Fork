'use strict';

/**
 * Normalizes metadata already returned by public DexScreener endpoints.
 * This is identity/context, not an attention score: URLs and handles are
 * preserved with source attribution, while unsupported or malformed values
 * are discarded. No X login, scraping, or inferred account ownership occurs.
 */

const ALLOWED_PLATFORMS = new Set(['twitter', 'x', 'telegram', 'discord', 'reddit', 'website', 'github', 'medium', 'youtube', 'tiktok', 'farcaster']);

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

function normalizeLinks(links, source) {
  if (!Array.isArray(links)) return [];
  return links.map((link) => {
    const url = safeUrl(link && (link.url || link.href));
    if (!url) return null;
    const rawType = String(link.type || link.platform || '').toLowerCase();
    return { platform: ALLOWED_PLATFORMS.has(rawType) ? rawType : 'other', label: link.label ? String(link.label).slice(0, 80) : null, url, source };
  }).filter(Boolean);
}

function normalizeSocials(socials, source) {
  if (!Array.isArray(socials)) return [];
  return socials.map((social) => {
    const platform = String(social.platform || social.type || '').toLowerCase();
    const rawHandle = social.handle ? String(social.handle).trim().slice(0, 120) : null;
    const url = safeUrl(social.url);
    const isTwitterPath = ['twitter', 'x'].includes(platform) && rawHandle && /\//.test(rawHandle);
    const derivedUrl = isTwitterPath && !url
      ? safeUrl(/^https?:\/\//i.test(rawHandle) ? rawHandle : `https://x.com/${rawHandle.replace(/^\/+/, '')}`)
      : url;
    const handle = isTwitterPath ? null : rawHandle;
    if (!handle && !derivedUrl) return null;
    return { platform: ALLOWED_PLATFORMS.has(platform) ? platform : 'other', handle, url: derivedUrl, source };
  }).filter(Boolean);
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.platform}|${item.handle || ''}|${item.url || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSocialMetadata({ profile, pair } = {}) {
  const links = dedupe([
    ...normalizeLinks(profile && profile.links, 'dexscreener_profile'),
    ...normalizeLinks(pair && pair.info && pair.info.websites, 'dexscreener_pair'),
  ]);
  const socials = dedupe([
    ...normalizeSocials(pair && pair.info && pair.info.socials, 'dexscreener_pair'),
    ...normalizeLinks(profile && profile.links, 'dexscreener_profile').filter((link) => ['twitter', 'x', 'telegram', 'discord', 'reddit'].includes(link.platform)),
  ]);
  const description = profile && typeof profile.description === 'string' ? profile.description.trim().slice(0, 1000) : null;
  const communityTakeover = Boolean(profile && profile.communityTakeover);
  return {
    available: Boolean(description || links.length || socials.length || communityTakeover),
    source: 'dexscreener',
    profileUrl: safeUrl(profile && profile.url),
    description,
    socials,
    links,
    communityTakeover,
    retrievedAt: new Date().toISOString(),
  };
}

function normalizeGeckoTokenSocialMetadata(tokenInfo) {
  const attrs = tokenInfo?.data?.attributes || tokenInfo?.attributes || {};
  const links = [];
  const websites = Array.isArray(attrs.websites) ? attrs.websites : [];
  for (const website of websites) {
    const url = safeUrl(website);
    if (url) links.push({ platform: 'website', label: 'website', url, source: 'geckoterminal' });
  }
  for (const [platform, value] of [['discord', attrs.discord_url], ['farcaster', attrs.farcaster_url]]) {
    const url = safeUrl(value);
    if (url) links.push({ platform, label: platform, url, source: 'geckoterminal' });
  }

  const socials = [];
  if (attrs.twitter_handle) {
    const raw = String(attrs.twitter_handle).trim().slice(0, 120);
    if (raw) {
      const isUrl = /^https?:\/\//i.test(raw);
      const isPath = raw.includes('/');
      const url = safeUrl(isUrl ? raw : `https://x.com/${raw.replace(/^@/, '')}`);
      socials.push({
        platform: 'twitter',
        handle: !isPath ? raw : null,
        url,
        source: 'geckoterminal',
      });
    }
  }
  if (attrs.telegram_handle) {
    const raw = String(attrs.telegram_handle).trim().slice(0, 120);
    if (raw) {
      const isUrl = /^https?:\/\//i.test(raw);
      const isPath = raw.includes('/');
      const url = safeUrl(isUrl ? raw : `https://t.me/${raw.replace(/^@/, '')}`);
      socials.push({
        platform: 'telegram',
        handle: !isPath ? raw : null,
        url,
        source: 'geckoterminal',
      });
    }
  }
  const discord = safeUrl(attrs.discord_url);
  if (discord) socials.push({ platform: 'discord', handle: null, url: discord, source: 'geckoterminal' });
  const farcaster = safeUrl(attrs.farcaster_url);
  if (farcaster) socials.push({ platform: 'farcaster', handle: null, url: farcaster, source: 'geckoterminal' });

  const description = typeof attrs.description === 'string' ? attrs.description.trim().slice(0, 1000) : null;
  const normalizedSocials = dedupe(socials);
  const normalizedLinks = dedupe(links);
  return {
    available: Boolean(description || normalizedSocials.length || normalizedLinks.length),
    source: 'geckoterminal',
    profileUrl: null,
    description,
    socials: normalizedSocials,
    links: normalizedLinks,
    communityTakeover: false,
    retrievedAt: new Date().toISOString(),
  };
}

function mergeSocialMetadata(existing, incoming) {
  if (!existing && !incoming) return null;
  if (!existing) return incoming;
  if (!incoming) return existing;
  const socials = dedupe([...(existing.socials || []), ...(incoming.socials || [])]);
  const links = dedupe([...(existing.links || []), ...(incoming.links || [])]);
  const description = existing.description || incoming.description || null;
  const available = Boolean(description || socials.length || links.length || existing.communityTakeover || incoming.communityTakeover);
  return { ...existing, available, description, socials, links, communityTakeover: Boolean(existing.communityTakeover || incoming.communityTakeover), sources: [...new Set([existing.source, incoming.source].filter(Boolean))], retrievedAt: incoming.retrievedAt || existing.retrievedAt };
}

module.exports = { normalizeSocialMetadata, normalizeGeckoTokenSocialMetadata, mergeSocialMetadata, safeUrl };
