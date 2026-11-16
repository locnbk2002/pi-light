/** A short, redacted provider reason so failures are diagnosable without echoing credentials. */
export function providerErrorSummary(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'no provider reason reported';
  return value.split('\n')[0]
    .replace(/(bearer|token|key|authorization)["':= ]+\S+/gi, '$1 [redacted]')
    .replace(/\b(sk|pk|rk|ak)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]')
    .slice(0, 200);
}
