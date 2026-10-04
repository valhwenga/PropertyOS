import { describe, it, expect } from 'vitest';
import { parseCsv, CsvParseError, toCsvTemplate } from '@propertyos/domain';

describe('CSV parsing', () => {
  it('parses a simple file', () => {
    const doc = parseCsv('code,name\nPROTEA14,14 Protea Street\nALOE,Aloe Court\n');
    expect(doc.headers).toEqual(['code', 'name']);
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows[0]!.values).toEqual({ code: 'PROTEA14', name: '14 Protea Street' });
  });

  it('strips the byte order mark Excel writes', () => {
    const doc = parseCsv('﻿code,name\nA,B\n');
    // Without this the first header is "﻿code" and every lookup fails.
    expect(doc.headers[0]).toBe('code');
  });

  it('handles a quoted field containing a comma', () => {
    const doc = parseCsv('code,address\nA,"14 Protea Street, Newlands, Cape Town"\n');
    expect(doc.rows[0]!.values.address).toBe('14 Protea Street, Newlands, Cape Town');
  });

  it('handles a quoted field containing a newline, and keeps later line numbers right', () => {
    const doc = parseCsv('code,note\nA,"line one\nline two"\nB,second\n');
    expect(doc.rows[0]!.values.note).toBe('line one\nline two');
    expect(doc.rows[1]!.values.code).toBe('B');
    // The embedded newline must not make the second row claim to be row 3.
    expect(doc.rows[1]!.line).toBe(4);
  });

  it('handles escaped quotes', () => {
    const doc = parseCsv('code,name\nA,"The ""Old"" Mill"\n');
    expect(doc.rows[0]!.values.name).toBe('The "Old" Mill');
  });

  it('handles CRLF and mixed line endings', () => {
    const doc = parseCsv('code,name\r\nA,First\r\nB,Second\n');
    expect(doc.rows).toHaveLength(2);
    expect(doc.rows[1]!.values.name).toBe('Second');
  });

  it('reports the original line number for a bad row', () => {
    try {
      parseCsv('code,name\nA,First\nB\nC,Third\n');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CsvParseError);
      expect((error as CsvParseError).line).toBe(3);
      expect((error as CsvParseError).message).toContain('1 values but the file has 2 columns');
    }
  });

  it('rejects a duplicate column heading rather than silently losing one', () => {
    expect(() => parseCsv('code,code\nA,B\n')).toThrow(/appears more than once/);
  });

  it('rejects a blank column heading', () => {
    expect(() => parseCsv('code,,name\nA,B,C\n')).toThrow(/blank/);
  });

  it('rejects an unclosed quote instead of swallowing the rest of the file', () => {
    expect(() => parseCsv('code,name\nA,"unterminated\n')).toThrow(/unclosed/);
  });

  it('rejects an empty file', () => {
    expect(() => parseCsv('')).toThrow(/empty/);
  });

  it('tolerates a trailing blank line and a file with headers only', () => {
    expect(parseCsv('code,name\nA,B\n\n').rows).toHaveLength(1);
    expect(parseCsv('code,name\n').rows).toHaveLength(0);
  });

  it('trims surrounding whitespace from values', () => {
    const doc = parseCsv('code,name\n  A  ,  Spaced  \n');
    expect(doc.rows[0]!.values).toEqual({ code: 'A', name: 'Spaced' });
  });

  it('round-trips a template through the parser', () => {
    const template = toCsvTemplate(
      ['code', 'address'],
      [{ code: 'PROTEA14', address: '14 Protea Street, Newlands' }],
    );
    const doc = parseCsv(template);
    expect(doc.rows[0]!.values.address).toBe('14 Protea Street, Newlands');
  });
});
