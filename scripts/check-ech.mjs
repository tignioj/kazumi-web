import { createHttpClient } from '../server/lib/http.js';
import { categorySearchOptions } from '../server/modules/metadata/service.js';
import { resolve } from 'node:path';
import { NetworkStore } from '../server/modules/network/store.js';

// Keep each comparison on the exact same request body and timeout. This is a
// live diagnostic, intentionally separate from the offline test suite.
const options = categorySearchOptions({});
const body = JSON.stringify({ keyword: '', sort: options.sort, filter: { type: [2] } });
const network = await new NetworkStore(resolve(process.env.DATA_DIR || 'data')).init();
const results = await Promise.all(
  [false, true].map(async (bangumiEch) => {
    const http = createHttpClient({
      bangumiEch,
      echDohUrl: network.data.echDohUrl,
      dnsOverHttpsUrl: process.env.DNS_OVER_HTTPS_URL || 'https://1.1.1.1/dns-query',
    });
    const start = performance.now();
    let result;
    try {
      const { response, echAccepted } = await http.request(
        'https://api.bgm.tv/v0/search/subjects?limit=24&offset=0',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      );
      const data = await response.json();
      result = {
        mode: bangumiEch ? 'ech' : 'direct',
        status: response.status,
        ms: Math.round(performance.now() - start),
        echAccepted: !!echAccepted,
        total: data.total,
        items: data.data?.length,
        error: data.error || data.message,
      };
    } catch (error) {
      result = {
        mode: bangumiEch ? 'ech' : 'direct',
        ms: Math.round(performance.now() - start),
        echAccepted: error.echAccepted === true,
        error: error.message,
      };
    } finally {
      await http.close();
    }
    console.log(JSON.stringify(result));
    return result;
  }),
);
if (!results.some((result) => result.mode === 'ech' && result.status === 200 && result.items > 0))
  process.exitCode = 1;
