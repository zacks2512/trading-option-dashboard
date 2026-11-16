export const defaultOrigins = ['https://zacks2512.github.io', 'http://localhost:3000', 'http://127.0.0.1:3000'];

// Allow exact frontend origins, never every Vercel project or preview URL.
export function allowedOrigins(value) {
  if (!value) return defaultOrigins;
  return [...new Set(value.split(',').map(entry => {
    const url = new URL(entry.trim());
    if (url.username || url.password || url.hostname.includes('*') ||
        url.pathname !== '/' || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
      throw new Error('JOURNAL_ALLOWED_ORIGINS must contain exact HTTPS origins or local development origins.');
    }
    return url.origin;
  }))];
}
