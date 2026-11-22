const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.join(__dirname, '..');
const directory = path.join(root, 'media-source', 'ignite-vsl-2');
const parts = Array.from({ length: 10 }, (_, i) =>
  fs.readFileSync(path.join(directory, String(i).padStart(2, '0') + '.part'))
);
const video = Buffer.concat(parts);
if (video.length !== 23161998 ||
    createHash('sha256').update(video).digest('hex') !== 'ea559ead347544f88dc707ff62817f014bf43ef42ad31b2f3e184e5b0d55614b') {
  throw new Error('Ignite VSL source failed integrity validation.');
}
const output = path.join(root, 'media');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'ignite-vsl-2-web.mp4'), video);
console.log('Built the browser-compatible Ignite VSL (1080x720, 3:2).');
