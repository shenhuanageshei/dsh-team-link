import fs from "node:fs";
import zlib from "node:zlib";

const src = process.argv[2];
const dst = process.argv[3];
const buf = fs.readFileSync(src);
const MAGIC = 0xfd2fb528; // little-endian read of 28 B5 2F FD

// Walk zstd frames deterministically (frame header + block headers).
function frameEnd(b, off) {
  if (b.readUInt32LE(off) !== MAGIC) return -1;
  let p = off + 4;
  const fhd = b[p++];
  const fcsFlag = (fhd >> 6) & 3;
  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const didFlag = fhd & 3;
  if (!singleSegment) p += 1; // Window_Descriptor
  const didSize = [0, 1, 2, 4][didFlag];
  p += didSize;
  let fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
  p += fcsSize;
  // blocks
  for (;;) {
    if (p + 3 > b.length) return -1;
    const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
    p += 3;
    const last = h & 1;
    const btype = (h >> 1) & 3;
    const bsize = (h >> 3) & 0x1fffff;
    if (btype === 0 || btype === 2) p += bsize;
    else if (btype === 1) p += 1;
    else return -1; // reserved
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}

const outs = [];
let off = 0, frames = 0, resync = 0;
while (off < buf.length) {
  let end = frameEnd(buf, off);
  if (end < 0 || end <= off) {
    // fall back: next magic
    const nxt = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), off + 1);
    if (nxt < 0) break;
    resync++;
    off = nxt;
    continue;
  }
  const slice = buf.subarray(off, end);
  try {
    outs.push(zlib.zstdDecompressSync(slice));
    frames++;
  } catch (e) {
    console.error("decode fail at", off, "len", end - off, e.message);
    resync++;
  }
  off = end;
}
console.log("frames decoded:", frames, "resyncs:", resync, "consumed:", off, "/", buf.length);
const out = Buffer.concat(outs).toString("utf8");
fs.writeFileSync(dst, out, "utf8");
console.log("decompressed bytes:", out.length, "lines:", out.split("\n").filter(Boolean).length);
