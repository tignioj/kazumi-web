// Reports can be shared without including signed media URLs or query credentials.
export function sanitizeDiagnosticText(value) {
  return String(value).replace(/(?:https?:\/\/|\/api\/)[^\s<>"']+/gi, (address) => {
    try {
      const url = new URL(address, 'https://diagnostics.invalid');
      const relative = address.startsWith('/');
      return `${relative ? '' : url.origin}${url.pathname}${url.search ? '?[已隐藏参数]' : ''}`;
    } catch {
      return '[地址已隐藏]';
    }
  });
}
