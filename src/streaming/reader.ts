/**
 * Server-Sent Events reader using the Web Streams API.
 *
 * Multi-runtime safe: no `node:stream`. Consumes `Response.body` (a
 * `ReadableStream<Uint8Array>`) and yields one SSE event payload per
 * iteration. The payload is the raw text content of `data:` lines for one
 * event - the caller (provider-specific normaliser) parses it.
 *
 * Compliant with the SSE wire format:
 *   - lines terminated by \n, \r, or \r\n
 *   - empty line ends an event
 *   - `data:` lines (one or more) joined by \n form the event payload
 *   - other field types (`event:`, `id:`, `retry:`) are accepted but ignored
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';
  let dataLines: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();
      while (true) {
        const newlineIndex = findLineEnd(buffer);
        if (newlineIndex < 0) {
          if (done) {
            // Flush any trailing line.
            if (buffer.length > 0) {
              processSseLine(buffer, dataLines);
              buffer = '';
            }
            const event = flushEvent(dataLines);
            if (event !== null) yield event;
            return;
          }
          break;
        }
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(
          newlineIndex +
            (buffer[newlineIndex] === '\r' && buffer[newlineIndex + 1] === '\n' ? 2 : 1),
        );
        if (rawLine.length === 0) {
          const event = flushEvent(dataLines);
          dataLines = [];
          if (event !== null) yield event;
        } else {
          processSseLine(rawLine, dataLines);
        }
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

function findLineEnd(buffer: string): number {
  for (let i = 0; i < buffer.length; i += 1) {
    const ch = buffer[i];
    if (ch === '\n' || ch === '\r') return i;
  }
  return -1;
}

function processSseLine(line: string, dataLines: string[]): void {
  if (line.startsWith(':')) return; // comment
  const colon = line.indexOf(':');
  const field = colon < 0 ? line : line.slice(0, colon);
  const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
  if (field === 'data') dataLines.push(value);
}

function flushEvent(dataLines: readonly string[]): string | null {
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}
