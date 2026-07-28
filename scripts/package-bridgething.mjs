import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import packageJson from "../package.json" with { type: "json" };

const root = new URL("..", import.meta.url).pathname;
const distDir = join(root, "dist");
const releaseDir = join(root, "release");
const packageBase = packageJson.name.endsWith("-bridgething")
  ? packageJson.name
  : `${packageJson.name}-bridgething`;
const packageName = `${packageBase}-v${packageJson.version}.zip`;
const outputPath = join(releaseDir, packageName);

const crcTable = new Uint32Array(256);
for (let i = 0; i < crcTable.length; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[i] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function buildZip(files) {
  const chunks = [];
  const centralDir = [];
  let offset = 0;

  for (const file of files) {
    const data = await readFile(file);
    const info = await stat(file);
    const compressed = deflateRawSync(data, { level: 9 });
    const name = relative(distDir, file).split(sep).join("/");
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const { time, date } = dosDateTime(info.mtime);

    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(8),
      u16(time), u16(date), u32(crc),
      u32(compressed.length), u32(data.length),
      u16(nameBuf.length), u16(0), nameBuf,
    ]);

    chunks.push(local, compressed);
    centralDir.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8),
      u16(time), u16(date), u32(crc),
      u32(compressed.length), u32(data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBuf,
    ]));
    offset += local.length + compressed.length;
  }

  const centralStart = offset;
  const central = Buffer.concat(centralDir);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(central.length), u32(centralStart), u16(0),
  ]);

  return Buffer.concat([...chunks, central, eocd]);
}

const files = (await listFiles(distDir))
  .filter((f) => !f.endsWith(".map"))
  .sort();

if (!files.some((f) => basename(f) === "manifest.json")) {
  throw new Error("dist/manifest.json is missing — run `npm run build:bridgething` first.");
}

await mkdir(releaseDir, { recursive: true });
await writeFile(outputPath, await buildZip(files));
console.log(`Wrote ${relative(root, outputPath)}`);
