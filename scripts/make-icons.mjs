// Génère les icônes PNG de la PWA sans dépendance : une caisse claire sur fond vert.
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const inBox = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [u, v] = [x / size, y / size];
      const box = inBox(u, v, 0.27, 0.34, 0.73, 0.72);
      const lid = inBox(u, v, 0.24, 0.27, 0.76, 0.38);
      const slot = inBox(u, v, 0.43, 0.27, 0.57, 0.52);
      const light = (box || lid) && !slot;
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      raw[offset] = light ? 244 : 15;
      raw[offset + 1] = light ? 243 : 92;
      raw[offset + 2] = light ? 238 : 77;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const size of [192, 512]) writeFileSync(`public/icons/icon-${size}.png`, png(size));

// Icônes de l'app Android (mobile/android) : l'icône complète sert de premier plan adaptatif.
const res = 'mobile/android/app/src/main/res';
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, k] of Object.entries(densities)) {
  mkdirSync(`${res}/mipmap-${name}`, { recursive: true });
  writeFileSync(`${res}/mipmap-${name}/ic_launcher.png`, png(48 * k));
  writeFileSync(`${res}/mipmap-${name}/ic_launcher_round.png`, png(48 * k));
  writeFileSync(`${res}/mipmap-${name}/ic_launcher_foreground.png`, png(108 * k));
}
