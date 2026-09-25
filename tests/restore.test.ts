import { describe, expect, it } from 'vitest';
import { encodeRespCommand } from '../src/protocol/respEncoding.js';
import { restoreRedisDump } from '../src/restore/restoreRedisDump.js';
import { analyzeRedisDump, detectDumpFormat, isRedisDump } from '../src/restore/inspect.js';
import { MockConnection, OK } from './mockConnection.js';

const okay = () => OK;
const data = (sent: string[][]) => sent.filter(command => command[0] !== 'CLIENT');

describe('restoreRedisDump', () => {
  it('sends every command in order, pipelined', async () => {
    const connection = new MockConnection(okay, { selectedDatabase: 0 });
    const source = Array.from({ length: 10 }, (_, at) => `SET k${at} ${at}`).join('\n');
    const result = await restoreRedisDump({ connection, source, options: { pipelineSize: 4 } });
    expect(result).toMatchObject({
      commandsExecuted: 10,
      commandsFailed: 0,
      format: 'text',
      cancelled: false,
    });
    expect(connection.pipelines).toEqual([4, 4, 2]);
    expect(data(connection.sent).map(command => command[1])).toEqual(
      Array.from({ length: 10 }, (_, at) => `k${at}`),
    );
  });

  it('works without a pipeline, one command at a time', async () => {
    const connection = new MockConnection(okay, { selectedDatabase: 0, pipeline: false });
    const result = await restoreRedisDump({ connection, source: 'SET a 1\nSET b 2\n' });
    expect(result.commandsExecuted).toBe(2);
  });

  it('stops at the first error by default, after the pipeline that contained it', async () => {
    const connection = new MockConnection(
      command => (command[1] === 'bad' ? new Error('WRONGTYPE Operation against a key') : OK),
      { selectedDatabase: 0 },
    );
    const source = ['SET a 1', 'INCR bad', 'SET b 2', 'SET c 3', 'SET d 4'].join('\n');
    const result = await restoreRedisDump({ connection, source, options: { pipelineSize: 3 } });
    expect(result.commandsFailed).toBe(1);
    expect(result.errors[0]).toMatchObject({
      kind: 'server',
      commandIndex: 1,
      location: { line: 2 },
      commandPreview: 'INCR bad',
      serverError: { prefix: 'WRONGTYPE' },
    });
    // The pipeline [SET a, INCR bad, SET b] ran; nothing after it did.
    expect(data(connection.sent).map(command => command[1])).toEqual(['a', 'bad', 'b']);
  });

  it('rewrites SELECTs through the mapping and puts the connection back afterwards', async () => {
    const connection = new MockConnection(okay, { selectedDatabase: 2 });
    const result = await restoreRedisDump({
      connection,
      source: 'SELECT 0\nSET a 1\nSELECT 1\nSET b 2\n',
      options: { databaseMapping: { 0: 7 } },
    });
    expect(result.databases).toEqual([7, 1]);
    expect(data(connection.sent)).toEqual([
      ['SELECT', '7'],
      ['SET', 'a', '1'],
      ['SELECT', '1'],
      ['SET', 'b', '2'],
      ['SELECT', '2'],
    ]);
  });

  it('selects the requested database before a dump without SELECTs', async () => {
    const connection = new MockConnection(okay, { selectedDatabase: 0 });
    await restoreRedisDump({ connection, source: 'SET a 1\n', options: { database: 4 } });
    expect(data(connection.sent)).toEqual([
      ['SELECT', '4'],
      ['SET', 'a', '1'],
      ['SELECT', '0'],
    ]);
  });

  it('asks the server which database is selected when the adapter cannot say', async () => {
    const connection = new MockConnection(command =>
      command[0] === 'CLIENT' ? Buffer.from('id=3 addr=x db=9 name=') : OK,
    );
    await restoreRedisDump({ connection, source: 'SELECT 1\nSET a 1\n' });
    expect(connection.sent.at(-1)).toEqual(['SELECT', '9']);
  });

  it('warns rather than guesses when nobody knows the original database', async () => {
    const connection = new MockConnection(command =>
      command[0] === 'CLIENT' ? new Error('ERR unknown subcommand') : OK,
    );
    const result = await restoreRedisDump({ connection, source: 'SELECT 1\nSET a 1\n' });
    expect(result.warnings.map(warning => warning.code)).toEqual(['selected-database-unknown']);
  });

  it('refuses administrative commands without sending them', async () => {
    const connection = new MockConnection(okay, { selectedDatabase: 0 });
    const result = await restoreRedisDump({
      connection,
      source: 'SET a 1\nCONFIG SET requirepass hunter2\nSET b 2\n',
      options: { stopOnError: false },
    });
    expect(result.errors).toMatchObject([{ kind: 'refused', commandIndex: 1 }]);
    expect(result.errors[0]?.commandPreview).not.toContain('hunter2');
    expect(data(connection.sent).map(command => command[0])).toEqual(['SET', 'SET']);
  });

  it('reads RESP and inline commands alike', async () => {
    const connection = new MockConnection(okay, { selectedDatabase: 0 });
    const source = Buffer.concat([
      encodeRespCommand(['SET', 'a', Buffer.from([0, 255])]),
      Buffer.from('PING\r\n'),
    ]);
    const result = await restoreRedisDump({ connection, source });
    expect(result.format).toBe('resp');
    expect(data(connection.sent)).toEqual([['SET', 'a', '\x00\xff'], ['PING']]);
  });

  it('reports cancellation and still cleans up', async () => {
    const controller = new AbortController();
    const connection = new MockConnection(
      command => {
        if (command[1] === 'k3') controller.abort();
        return OK;
      },
      { selectedDatabase: 0 },
    );
    const source = ['SELECT 5', ...Array.from({ length: 100 }, (_, at) => `SET k${at} v`)].join(
      '\n',
    );
    const result = await restoreRedisDump({
      connection,
      source,
      signal: controller.signal,
      options: { pipelineSize: 1 },
    });
    expect(result.cancelled).toBe(true);
    expect(result.commandsExecuted).toBeLessThan(10);
    expect(connection.sent.at(-1)).toEqual(['SELECT', '0']);
  });

  it('warns when a text dump lacks its final newline', async () => {
    const connection = new MockConnection(okay, { selectedDatabase: 0 });
    const result = await restoreRedisDump({ connection, source: 'SET a 1\nSET b "trunc' });
    expect(result.errors).toMatchObject([{ kind: 'parse' }]);
    const clean = await restoreRedisDump({ connection, source: 'SET a 1\nSET b 2' });
    expect(clean.warnings.map(warning => warning.code)).toEqual(['missing-final-newline']);
  });
});

describe('dump inspection', () => {
  it('recognizes Redis scripts and rejects other text', () => {
    expect(isRedisDump('SET a 1\nHSET h f v\n')).toBe(true);
    expect(isRedisDump(encodeRespCommand(['SELECT', 0]))).toBe(true);
    expect(isRedisDump('-- MySQL dump 10.13\nCREATE TABLE t (a int);\n')).toBe(false);
    expect(isRedisDump('{"json": true}\n')).toBe(false);
    expect(isRedisDump('')).toBe(false);
    expect(detectDumpFormat('  *1\r\n')).toBe('resp');
    expect(detectDumpFormat('SET a 1')).toBe('text');
    expect(detectDumpFormat('\n')).toBeUndefined();
  });

  it('summarizes a dump without executing it', async () => {
    const analysis = await analyzeRedisDump(
      'SELECT 2\nSET a 1\nSET b 2\nFLUSHALL\nXGROUP CREATECONSUMER s g c\n',
    );
    expect(analysis).toMatchObject({
      format: 'text',
      commands: 5,
      commandCounts: { SELECT: 1, SET: 2, FLUSHALL: 1, XGROUP: 1 },
      refusedByDefault: ['FLUSHALL'],
      requirements: { databases: [2], minimumRedisVersion: '6.2.0' },
    });
  });
});
