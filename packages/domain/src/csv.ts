/**
 * RFC 4180 CSV parsing.
 *
 * Written rather than imported because onboarding data arrives from real
 * spreadsheets, and the failure modes that matter — a BOM from Excel, a quoted
 * address containing a comma, a note containing a newline, mixed line endings —
 * are exactly the ones a naive `split(',')` gets wrong and a library would hide
 * behind options we would have to understand anyway.
 *
 * Every row keeps its ORIGINAL line number, because an import that reports
 * "row 47 is wrong" must mean row 47 of the operator's file.
 */

export interface CsvRow {
  /** 1-based line number in the source file, including the header. */
  line: number;
  values: Record<string, string>;
}

export interface CsvDocument {
  headers: string[];
  rows: CsvRow[];
}

export class CsvParseError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = 'CsvParseError';
  }
}

export function parseCsv(input: string): CsvDocument {
  // Excel writes a UTF-8 byte order mark; left in place it corrupts the first
  // header name and every lookup against it fails confusingly.
  const text = input.replace(/^﻿/, '');

  const records: Array<{ line: number; fields: string[] }> = [];
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let sawAnyChar = false;

  const pushField = () => { fields.push(field); field = ''; };
  const pushRecord = () => {
    pushField();
    // Ignore a trailing blank line, but not a genuinely empty field row.
    if (!(fields.length === 1 && fields[0] === '')) {
      records.push({ line: recordStartLine, fields });
    }
    fields = [];
    recordStartLine = line + 1;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    sawAnyChar = true;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (field !== '') {
        throw new CsvParseError('A quote may only open at the start of a field.', line);
      }
      inQuotes = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRecord();
      line += 1;
    } else if (char === '\n') {
      pushRecord();
      line += 1;
    } else {
      field += char;
    }
  }

  if (inQuotes) {
    throw new CsvParseError('The file ends inside a quoted value. A quote is unclosed.', recordStartLine);
  }
  if (sawAnyChar && (field !== '' || fields.length > 0)) pushRecord();

  const header = records.shift();
  if (!header) throw new CsvParseError('The file is empty.', 1);

  const headers = header.fields.map((h) => h.trim());
  const seen = new Set<string>();
  for (const name of headers) {
    if (name === '') throw new CsvParseError('A column heading is blank.', header.line);
    if (seen.has(name.toLowerCase())) {
      throw new CsvParseError(`The column "${name}" appears more than once.`, header.line);
    }
    seen.add(name.toLowerCase());
  }

  const rows: CsvRow[] = records.map((record) => {
    if (record.fields.length !== headers.length) {
      throw new CsvParseError(
        `This row has ${record.fields.length} values but the file has ${headers.length} columns.`,
        record.line,
      );
    }
    const values: Record<string, string> = {};
    headers.forEach((name, index) => { values[name] = (record.fields[index] ?? '').trim(); });
    return { line: record.line, values };
  });

  return { headers, rows };
}

/** Renders rows back to CSV, for the downloadable templates. */
export function toCsvTemplate(headers: string[], examples: Array<Record<string, string>>): string {
  const escape = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [headers.map(escape).join(',')];
  for (const example of examples) {
    lines.push(headers.map((h) => escape(example[h] ?? '')).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
