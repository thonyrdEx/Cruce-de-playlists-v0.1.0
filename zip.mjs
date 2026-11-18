import { Buffer } from 'node:buffer';

// ZIP method 0 stores JPEG, WebP and other already compressed image data as-is.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value;
});

function checksum(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function fileFields(header, start, filename, data, crc) {
  header.writeUInt16LE(0x0800, start); // UTF-8 filename
  header.writeUInt16LE(0x0021, start + 6); // DOS date, January 1, 1980
  header.writeUInt32LE(crc, start + 8);
  header.writeUInt32LE(data.length, start + 12);
  header.writeUInt32LE(data.length, start + 16);
  header.writeUInt16LE(filename.length, start + 20);
}

export async function* zipArchive(files) {
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for await (const { name, data } of files) {
    const filename = Buffer.from(name, 'utf8');
    const crc = checksum(data);
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    fileFields(local, 6, filename, data, crc);
    filename.copy(local, 30);

    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    fileFields(central, 8, filename, data, crc);
    central.writeUInt32LE(offset, 42);
    filename.copy(central, 46);
    directory.push(central);
    directorySize += central.length;
    offset += local.length + data.length;
    yield local;
    yield data;
  }

  yield* directory;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length, 8);
  end.writeUInt16LE(directory.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}
