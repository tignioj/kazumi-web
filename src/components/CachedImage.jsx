import React, { useEffect, useRef, useState } from 'react';

// Keep normal image loading/lazy loading, then replace an expired cover after revalidation.
export function CachedImage({ src, ...props }) {
  if (!src?.startsWith('/api/image?')) return <img {...props} src={src} />;
  return <RevalidatingImage key={src} src={src} {...props} />;
}

function RevalidatingImage({ src, ...props }) {
  const image = useRef(null);
  const [updated, setUpdated] = useState(null);

  useEffect(() => {
    const element = image.current;
    const controller = new AbortController();
    let checked = false;
    let objectUrl;

    async function refresh() {
      if (checked) return;
      checked = true;
      try {
        // Reuse the response already loaded by <img> to inspect its freshness.
        const cached = await fetch(src, { cache: 'force-cache', signal: controller.signal });
        const expires = cached.headers.get('x-image-expires');
        const etag = cached.headers.get('etag');
        await cached.body?.cancel();
        if (!cached.ok || expires === null || Number(expires) > Date.now()) return;

        const response = await fetch(`${src}&refresh=1`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok || response.headers.get('etag') === etag) {
          await response.body?.cancel();
          return;
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUpdated(objectUrl);
      } catch {
        // Background failures must not hide a cover that has already loaded.
      }
    }

    element.addEventListener('load', refresh);
    if (element.complete && element.naturalWidth) void refresh();
    return () => {
      controller.abort();
      element.removeEventListener('load', refresh);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  return <img {...props} ref={image} src={updated || src} />;
}
