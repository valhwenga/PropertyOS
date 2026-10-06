/**
 * Guards the .env.local template in scripts/preview.sh.
 *
 * Its heredoc delimiter is unquoted, because the connection strings inside it
 * have to expand. That also makes every backtick and $(...) in the body a
 * command substitution the shell runs while writing the file.
 *
 * This is not hypothetical. A comment mentioning pnpm test, written with
 * backticks around it, executed the test suite during `./scripts/preview.sh`
 * and spliced its output into .env.local — which then failed to source. It
 * survived review because the file-creation branch only runs when no
 * .env.local exists, so every machine that had already run the script once was
 * immune.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const script = readFileSync(
  fileURLToPath(new URL('../../scripts/preview.sh', import.meta.url)),
  'utf8',
);

/** The body between `cat > "$ENV_FILE" <<ENV` and the closing ENV delimiter. */
function envTemplateBody(): string {
  const lines = script.split('\n');
  const start = lines.findIndex((l) => l.includes('cat > "$ENV_FILE" <<ENV'));
  expect(start, 'the .env.local heredoc should still exist in preview.sh').toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && l === 'ENV');
  expect(end, 'the .env.local heredoc should be terminated').toBeGreaterThan(start);
  return lines.slice(start + 1, end).join('\n');
}

describe('the .env.local template in scripts/preview.sh', () => {
  it('contains no backtick, which the shell would execute while writing the file', () => {
    const offending = envTemplateBody()
      .split('\n')
      .filter((line) => line.includes('`') && !line.includes('\\`'));
    expect(offending, 'escape it as \\` or reword without backticks').toEqual([]);
  });

  it('contains no $(...), which the shell would execute while writing the file', () => {
    const offending = envTemplateBody()
      .split('\n')
      .filter((line) => /(^|[^\\])\$\(/.test(line));
    expect(offending).toEqual([]);
  });

  it('still carries the variables the app and the tests read', () => {
    const body = envTemplateBody();
    for (const key of [
      'DATABASE_URL', 'APP_DATABASE_URL', 'TEST_ADMIN_DATABASE_URL',
      'SESSION_SECRET', 'FIELD_ENCRYPTION_KEY',
    ]) {
      expect(body, `${key} should be written to .env.local`).toMatch(
        new RegExp(`^${key}=`, 'm'),
      );
    }
  });
});
