import { describe, expect, it } from 'vitest';
import { checkCommandAllowed, previewCommand, redactCommand } from '../src/security/index.js';
import { matchGlob } from '../src/selection/glob.js';

describe('command allow-list', () => {
  it('permits data commands and refuses administration by default', () => {
    for (const command of [
      ['SET', 'k', 'v'],
      ['select', '3'],
      ['XGROUP', 'CREATE', 's', 'g', '0'],
      ['RESTORE', 'k', '0', 'x'],
    ]) {
      expect(checkCommandAllowed(command, 'restore'), command.join(' ')).toBeUndefined();
    }
    for (const command of [
      ['FLUSHALL'],
      ['CONFIG', 'SET', 'dir', '/tmp'],
      ['EVAL', 'return 1', '0'],
      ['SHUTDOWN'],
      ['REPLICAOF', 'evil', '6379'],
      ['XGROUP', 'HELP'],
      ['MODULE', 'LOAD', '/x.so'],
    ]) {
      expect(checkCommandAllowed(command, 'restore'), command.join(' ')).toBeDefined();
    }
  });

  it("accepts anything with 'any', and exactly the named commands with a list", () => {
    expect(checkCommandAllowed(['FLUSHALL'], 'any')).toBeUndefined();
    expect(checkCommandAllowed(['flushdb'], ['FLUSHDB'])).toBeUndefined();
    expect(checkCommandAllowed(['SET', 'k', 'v'], ['FLUSHDB'])).toBeDefined();
  });
});

describe('redaction', () => {
  it('hides credentials in every command that carries them', () => {
    expect(redactCommand(['AUTH', 'user', 'secret'])).toEqual(['AUTH', '<redacted>', '<redacted>']);
    expect(redactCommand(['HELLO', '3', 'AUTH', 'user', 'secret', 'SETNAME', 'x'])).toEqual([
      'HELLO',
      '3',
      'AUTH',
      '<redacted>',
      '<redacted>',
      'SETNAME',
      'x',
    ]);
    expect(redactCommand(['MIGRATE', 'h', '6379', 'k', '0', '1000', 'AUTH', 'secret'])).toContain(
      '<redacted>',
    );
    expect(
      redactCommand(['MIGRATE', 'h', '6379', 'k', '0', '1000', 'AUTH2', 'u', 'p']).slice(-2),
    ).toEqual(['<redacted>', '<redacted>']);
    expect(redactCommand(['CONFIG', 'SET', 'requirepass', 'secret', 'maxmemory', '1gb'])).toEqual([
      'CONFIG',
      'SET',
      'requirepass',
      '<redacted>',
      'maxmemory',
      '1gb',
    ]);
    expect(redactCommand(['ACL', 'SETUSER', 'bob', 'on', '>secret', '~*'])).toEqual([
      'ACL',
      'SETUSER',
      'bob',
      'on',
      '<redacted>',
      '~*',
    ]);
  });

  it('previews are single-line, bounded and redacted', () => {
    expect(previewCommand(['SET', 'k', 'a\nb'])).toBe('SET k "a\\nb"');
    expect(previewCommand(['SET', 'k', 'x'.repeat(1000)]).length).toBeLessThanOrEqual(201);
    expect(previewCommand(['AUTH', 'secret'])).not.toContain('secret');
  });
});

describe('glob matching (stringmatchlen)', () => {
  it.each([
    ['*', '', true],
    ['*', 'anything', true],
    ['user:*', 'user:1', true],
    ['user:*', 'User:1', false],
    ['h?llo', 'hello', true],
    ['h?llo', 'hllo', false],
    ['h[ae]llo', 'hallo', true],
    ['h[ae]llo', 'hillo', false],
    ['h[^e]llo', 'hallo', true],
    ['h[^e]llo', 'hello', false],
    ['h[a-b]llo', 'hbllo', true],
    ['h[b-a]llo', 'hallo', true],
    ['a\\*b', 'a*b', true],
    ['a\\*b', 'axb', false],
    ['*:1', 'user:1', true],
    ['**x', 'abcx', true],
  ])('%s against %s is %s', (pattern, subject, expected) => {
    expect(matchGlob(pattern, subject)).toBe(expected);
  });

  it('matches binary keys byte by byte', () => {
    expect(matchGlob(Buffer.from([0x2a, 0xff]), Buffer.from([0x00, 0x01, 0xff]))).toBe(true);
  });

  it('survives a pathological pattern without blowing the stack', () => {
    expect(matchGlob('*'.repeat(5_000) + 'x', 'y'.repeat(50))).toBe(false);
  });
});
