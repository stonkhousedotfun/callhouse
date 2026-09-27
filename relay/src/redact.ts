/**
 * The rule, applied by log.ts to every finished line before it reaches the sink. Any URL whose
 * path, query or userinfo could carry a credential is cut to scheme://host/…. Both of the relay's outbound URLs
 * are credentials: a Discord webhook's path IS its secret, and Telegram's sendMessage path carries bot<TOKEN>.
 *
 * BY SHAPE, NEVER BY HOST. A list of known providers leaks again on the next one, so every URL with anything
 * after its host is reduced; only a bare origin (`https://host` or `https://host/`) is left as it is.
 *
 * SAFE ON A SERIALIZED LINE. It runs on finished JSON lines, so a match never takes a backslash: a `\"`
 * after a URL inside a JSON string stays an escape and the line still parses.
 *
 * The same function lives in keeper/src/v2/redact.ts, indexer/lib/redact.ts, notifier/src/redact.ts,
 * relay/src/redact.ts and indexer/lib/stdio-redact.mjs; no module is shared between them, and
 * keeper/src/v2/redact.test.ts runs one corpus through all five and fails if they disagree.
 */
const URL_IN_TEXT = /(?:https?|wss?):\/\/[^\s"'<>`\\]+/gi;

export function redactUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (raw) => {
    try {
      const url = new URL(raw);
      const bare = url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
      return bare ? raw : `${url.protocol}//${url.host}/…`;
    } catch {
      return '[url]';
    }
  });
}
