const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Short random id. Uses getRandomValues because crypto.randomUUID is
 * unavailable on insecure origins (e.g. http://192.168.x.x).
 */
export function shortId(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}
