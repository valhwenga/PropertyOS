/**
 * The ZIP writer.
 *
 * An archive is only worth writing if other tools can open it, so these tests
 * read it back the way a real unzip does — through the central directory — and
 * check the CRC the format exists to carry. A file that round-trips through
 * our own reader and nothing else would prove very little.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { buildZip, crc32 } from '@propertyos/domain';

interface Entry { name: string; content: Buffer; crc: number; declaredCrc: number }

function readCentralDirectory(archive: Buffer): Entry[] {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(-1);
  const count = archive.readUInt16LE(eocd + 10);
  expect(archive.readUInt16LE(eocd + 8)).toBe(count);

  let offset = archive.readUInt32LE(eocd + 16);
  const entries: Entry[] = [];
  for (let i = 0; i < count; i += 1) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
    const declaredCrc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50);
    // Bit 11, so a name outside ASCII is read as UTF-8 rather than code page 437.
    expect(archive.readUInt16LE(localOffset + 6) & 0x0800).toBe(0x0800);
    const dataStart =
      localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const content = inflateRawSync(archive.subarray(dataStart, dataStart + compressedSize));
    expect(content.length).toBe(uncompressedSize);

    entries.push({ name, content, crc: crc32(content), declaredCrc });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('ZIP writer', () => {
  it('writes entries that read back byte for byte, with a correct CRC', () => {
    const archive = buildZip([
      { name: 'README.txt', content: 'Line one\r\nLine two\r\n' },
      { name: 'data/rows.csv', content: 'a,b\r\n1,2\r\n' },
    ]);

    const entries = readCentralDirectory(archive);
    expect(entries.map((e) => e.name)).toEqual(['README.txt', 'data/rows.csv']);
    expect(entries[0]!.content.toString('utf8')).toBe('Line one\r\nLine two\r\n');
    expect(entries[1]!.content.toString('utf8')).toBe('a,b\r\n1,2\r\n');
    for (const entry of entries) expect(entry.crc).toBe(entry.declaredCrc);
  });

  it('keeps a name and a value outside ASCII intact', () => {
    // A document titled in isiZulu, or an address with an é, must survive the
    // trip. This is the case the UTF-8 flag exists for.
    const archive = buildZip([
      { name: 'ídentity — notes.txt', content: 'Résumé · Ubuntu ngumuntu\n' },
    ]);
    const [entry] = readCentralDirectory(archive);
    expect(entry!.name).toBe('ídentity — notes.txt');
    expect(entry!.content.toString('utf8')).toBe('Résumé · Ubuntu ngumuntu\n');
  });

  it('holds an empty file without corrupting the directory', () => {
    const archive = buildZip([
      { name: 'empty.csv', content: '' },
      { name: 'after.txt', content: 'still readable' },
    ]);
    const entries = readCentralDirectory(archive);
    expect(entries[0]!.content).toHaveLength(0);
    expect(entries[1]!.content.toString('utf8')).toBe('still readable');
  });

  it('compresses, rather than merely storing', () => {
    const repetitive = 'lease,rent,currency\r\n'.repeat(500);
    const archive = buildZip([{ name: 'rows.csv', content: repetitive }]);
    expect(archive.length).toBeLessThan(repetitive.length / 4);
  });

  it('produces an archive the system unzip accepts', () => {
    // The real test of a file format is a tool that did not write it. Skipped
    // rather than failed where unzip is not installed, because its absence
    // says nothing about the archive.
    let unzip = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      unzip = false;
    }
    if (!unzip) return;

    const directory = mkdtempSync(join(tmpdir(), 'propertyos-zip-'));
    try {
      const path = join(directory, 'export.zip');
      writeFileSync(path, buildZip([
        { name: 'README.txt', content: 'documented export\n' },
        { name: 'rows.csv', content: 'id,amount_minor\r\n1,185000\r\n' },
      ]));
      // -t tests every entry's CRC against its data.
      const output = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
      expect(output).toContain('No errors detected');
      expect(execFileSync('unzip', ['-p', path, 'rows.csv'], { encoding: 'utf8' }))
        .toContain('185000');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
