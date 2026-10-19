// Generate visible, editable domain rules; never infer a media CDN from a name.
export function routingId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

export function sourceRoutingRules(source, outbound = 'default') {
  const hosts = new Set();
  for (const value of [
    source.baseURL,
    source.searchURL,
    source.searchApiConfig?.request?.url,
    source.chapterApiConfig?.request?.url,
  ]) {
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
      if (host && !host.includes('@')) hosts.add(host);
    } catch {}
  }
  return [...hosts]
    .filter((host) => ![...hosts].some((other) => other !== host && host.endsWith(`.${other}`)))
    .map((host) => ({
      id: routingId(),
      name: `${source.name} · ${host}`,
      enabled: true,
      scope: 'video',
      matchType: 'domainSuffix',
      value: host,
      action: outbound === 'direct' ? 'direct' : 'proxy',
      proxyId: outbound === 'direct' ? 'default' : outbound,
    }));
}
