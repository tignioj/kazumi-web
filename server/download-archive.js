import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  const octal = (value, offset, length) => {
    const encoded = value.toString(8);
    if (encoded.length < length) {
      header.write(`${encoded.padStart(length - 1, '0')}\0`, offset, length, 'ascii');
      return;
    }
    // GNU/base-256 fields support a single media object larger than 8 GiB.
    let remaining = BigInt(value);
    for (let index = offset + length - 1; index > offset; index--) {
      header[index] = Number(remaining & 255n);
      remaining >>= 8n;
    }
    header[offset] = 0x80 | Number(remaining);
  };
  octal(0o600, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

// Assets already use short, generated basenames. Stream an ordinary portable
// tar.gz without making a second copy of the cached video on disk.
export async function streamArchive(directory, files, output) {
  async function* entries() {
    for (const { name } of files) {
      const path = join(directory, name);
      const { size } = await stat(path);
      yield tarHeader(name, size);
      for await (const chunk of createReadStream(path)) yield chunk;
      if (size % 512) yield Buffer.alloc(512 - (size % 512));
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(entries()), createGzip(), output);
}
