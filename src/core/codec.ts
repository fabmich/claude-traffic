/** Binary and compression helpers for save games. */

export function bytesToB64(a: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < a.length; i += CHUNK) s += String.fromCharCode(...a.subarray(i, i + CHUNK));
  return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as unknown as Uint8Array<ArrayBuffer>);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export async function gzipText(text: string): Promise<Uint8Array> {
  return pipe(new TextEncoder().encode(text), new CompressionStream('gzip'));
}

export async function gunzipText(bytes: Uint8Array): Promise<string> {
  return new TextDecoder().decode(await pipe(bytes, new DecompressionStream('gzip')));
}
