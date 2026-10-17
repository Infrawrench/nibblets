/**
 * The smallest ISO 9660 image that will do: a volume label and a few files
 * in its root, which every OS can read without help. For the disc Windows'
 * setup reads its answers (autounattend.xml) from, which the hosts with
 * Windows guests (Windows itself among them) have no tool to make.
 *
 * Names are uppercased and given ISO's `;1`; readers take them as they are
 * (Windows, macOS and Linux all read past the 8.3 limit of level 1).
 */

const SECTOR = 2048;

export interface IsoFile {
  name: string;
  data: Uint8Array;
}

/** Writes `n` both ways round, little-endian then big-endian, as ISO wants most numbers. */
function both32(view: DataView, at: number, n: number): void {
  view.setUint32(at, n, true);
  view.setUint32(at + 4, n, false);
}

function both16(view: DataView, at: number, n: number): void {
  view.setUint16(at, n, true);
  view.setUint16(at + 2, n, false);
}

/** Text padded with spaces to `length`, as ISO's string fields are. */
function text(bytes: Uint8Array, at: number, length: number, value: string): void {
  const padded = value.toUpperCase().slice(0, length).padEnd(length, " ");
  for (let i = 0; i < length; i++) bytes[at + i] = padded.charCodeAt(i);
}

/** A directory record: where something is, how long, and its name. */
function record(
  extent: number,
  size: number,
  name: Uint8Array,
  dir: boolean,
  when: Date,
): Uint8Array {
  const length = 33 + name.byteLength + (name.byteLength % 2 === 0 ? 1 : 0);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  out[0] = length;
  both32(view, 2, extent);
  both32(view, 10, size);
  out[18] = when.getUTCFullYear() - 1900;
  out[19] = when.getUTCMonth() + 1;
  out[20] = when.getUTCDate();
  out[21] = when.getUTCHours();
  out[22] = when.getUTCMinutes();
  out[23] = when.getUTCSeconds();
  out[25] = dir ? 2 : 0;
  both16(view, 28, 1);
  out[32] = name.byteLength;
  out.set(name, 33);
  return out;
}

/** ISO's 17-byte dates in a volume descriptor: digits, then a time zone offset. */
function longDate(when: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${when.getUTCFullYear()}${p(when.getUTCMonth() + 1)}${p(when.getUTCDate())}${p(when.getUTCHours())}${p(when.getUTCMinutes())}${p(when.getUTCSeconds())}00`;
}

export function isoName(name: string): string {
  return `${name.toUpperCase()};1`;
}

/** An ISO 9660 image of `files` in its root, labelled `label`. */
export function makeIso(label: string, files: readonly IsoFile[], when = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const sorted = [...files].sort((a, b) => isoName(a.name).localeCompare(isoName(b.name)));
  // 0-15 empty, 16 the primary descriptor, 17 the terminator, 18 and 19 the
  // path tables, 20 the root directory, then each file from a sector of its own.
  const ROOT = 20;
  let next = ROOT + 1;
  const placed = sorted.map((file) => {
    const at = next;
    next += Math.max(1, Math.ceil(file.data.byteLength / SECTOR));
    return { ...file, at };
  });
  const total = next;
  const image = new Uint8Array(total * SECTOR);
  const view = new DataView(image.buffer);

  // The root directory: itself, its parent (itself again), then the files.
  const rootRecords = [
    record(ROOT, SECTOR, new Uint8Array([0]), true, when),
    record(ROOT, SECTOR, new Uint8Array([1]), true, when),
    ...placed.map((f) =>
      record(f.at, f.data.byteLength, encoder.encode(isoName(f.name)), false, when),
    ),
  ];
  let at = ROOT * SECTOR;
  for (const r of rootRecords) {
    if (at + r.byteLength > (ROOT + 1) * SECTOR)
      throw new Error("too many files for one directory sector");
    image.set(r, at);
    at += r.byteLength;
  }
  for (const f of placed) image.set(f.data, f.at * SECTOR);

  // Path tables, one entry each: the root.
  const pathTable = (offset: number, littleEndian: boolean) => {
    image[offset] = 1;
    view.setUint32(offset + 2, ROOT, littleEndian);
    view.setUint16(offset + 6, 1, littleEndian);
  };
  pathTable(18 * SECTOR, true);
  pathTable(19 * SECTOR, false);

  // The primary volume descriptor.
  const pvd = 16 * SECTOR;
  image[pvd] = 1;
  text(image, pvd + 1, 5, "CD001");
  image[pvd + 6] = 1;
  text(image, pvd + 8, 32, "");
  text(image, pvd + 40, 32, label);
  both32(view, pvd + 80, total);
  both16(view, pvd + 120, 1);
  both16(view, pvd + 124, 1);
  both16(view, pvd + 128, SECTOR);
  both32(view, pvd + 132, 10);
  view.setUint32(pvd + 140, 18, true);
  view.setUint32(pvd + 148, 19, false);
  image.set(record(ROOT, SECTOR, new Uint8Array([0]), true, when), pvd + 156);
  // The names of the volume set, publisher, preparer and application, and its files': none.
  const blanks: [number, number][] = [
    [190, 128],
    [318, 128],
    [446, 128],
    [574, 128],
    [702, 37],
    [739, 37],
    [776, 37],
  ];
  for (const [offset, length] of blanks) text(image, pvd + offset, length, "");
  for (const offset of [813, 830, 864]) text(image, pvd + offset, 16, longDate(when));
  text(image, pvd + 847, 16, "0".repeat(16));
  image[pvd + 881] = 1;

  // The terminator.
  const end = 17 * SECTOR;
  image[end] = 255;
  text(image, end + 1, 5, "CD001");
  image[end + 6] = 1;
  return image;
}
