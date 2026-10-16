/** A test BB's URL, refused unless it's on this machine: the e2e tests write reviews and settings to the BB they reach. */
export function loopbackUrl(name: string, url: string): string {
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/.test(url)) throw new Error(`${name} must be a test BB on this machine, such as http://127.0.0.1:4331, not ${url}`);
  return url.replace(/\/$/, "");
}
