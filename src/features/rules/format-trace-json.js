export const TRACE_JSON_MAX_CHARS = 256 * 1024;
export const TRACE_JSON_MAX_DEPTH = 64;

// Format original tokens instead of stringifying a parsed object. This preserves
// numeric literals and bounds output before allocating each indentation chunk.
export function formatTraceJson(raw) {
  if (raw.length > TRACE_JSON_MAX_CHARS) return { error: 'size' };
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of raw) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '[' || character === '{') {
      if (++depth > TRACE_JSON_MAX_DEPTH) return { error: 'depth' };
    } else if (character === ']' || character === '}') depth--;
  }
  try {
    JSON.parse(raw);
  } catch {
    return { error: 'invalid' };
  }

  const parts = [];
  let length = 0;
  const append = (text) => {
    if (length + text.length > TRACE_JSON_MAX_CHARS) throw new RangeError('format budget');
    length += text.length;
    parts.push(text);
  };
  const newline = () => append(`\n${'  '.repeat(depth)}`);
  const nextToken = (index) => {
    while (/\s/.test(raw[index] || '') && index < raw.length) index++;
    return raw[index];
  };
  depth = 0;
  let previous;
  try {
    for (let index = 0; index < raw.length; index++) {
      const character = raw[index];
      if (/\s/.test(character)) continue;
      if (character === '"') {
        const start = index;
        let escaped = false;
        while (++index < raw.length) {
          if (escaped) escaped = false;
          else if (raw[index] === '\\') escaped = true;
          else if (raw[index] === '"') break;
        }
        append(raw.slice(start, index + 1));
      } else if (character === '[' || character === '{') {
        append(character);
        depth++;
        if (nextToken(index + 1) !== (character === '[' ? ']' : '}')) newline();
      } else if (character === ']' || character === '}') {
        depth--;
        if (previous !== (character === ']' ? '[' : '{')) newline();
        append(character);
      } else if (character === ',') {
        append(',');
        newline();
      } else if (character === ':') append(': ');
      else {
        const start = index;
        while (index + 1 < raw.length && !/[\s,[\]{}:]/.test(raw[index + 1])) index++;
        append(raw.slice(start, index + 1));
      }
      previous = character;
    }
  } catch (error) {
    if (error instanceof RangeError) return { error: 'size' };
    throw error;
  }
  const text = parts.join('');
  return text.length <= TRACE_JSON_MAX_CHARS ? { text } : { error: 'size' };
}
