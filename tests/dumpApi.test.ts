import { describe, expect, it } from 'vitest';
import { dumpRedis } from '../src/api/dump.js';
import { parseRedisCommands } from '../src/restore/parser.js';
import { BufferDumpWriter } from '../src/writer/bufferWriter.js';
import type { Responder } from './mockConnection.js';
import { infoServer, MockConnection, OK } from './mockConnection.js';

/** A one-database server holding `strings` as string keys, answering what a dump asks. */
function server(
  version: string,
  strings: Record<string, string>,
  extra: Record<string, string> = {},
): Responder {
  const keys = Object.keys(strings);
  return command => {
    const [name, first] = command;
    switch (name) {
      case 'INFO':
        return first === 'keyspace'
          ? Buffer.from(
              `# Keyspace\r\ndb0:keys=${keys.length},expires=0,avg_ttl=0\r\ndb3:keys=1,expires=0\r\n`,
            )
          : infoServer(version, extra);
      case 'TIME':
        return [Buffer.from('1700000000'), Buffer.from('500000')];
      case 'CLIENT':
        return Buffer.from('id=1 db=0 name=');
      case 'SELECT':
      case 'ECHO':
        return OK;
      case 'SCAN':
        return [Buffer.from('0'), keys.map(key => Buffer.from(key))];
      case 'TYPE':
        return Buffer.from(first !== undefined && first in strings ? 'string' : 'none');
      case 'PTTL':
      case 'PEXPIRETIME':
        return first === 'expiring' ? (name === 'PTTL' ? 60_000 : 1_700_000_060_000) : -1;
      case 'STRLEN':
        return Buffer.byteLength(strings[first as string] ?? '');
      case 'GET':
        return first !== undefined && first in strings
          ? Buffer.from(strings[first] as string)
          : null;
      default:
        return new Error(`ERR mock does not know ${name}`);
    }
  };
}

async function dump(connection: MockConnection, options: Parameters<typeof dumpRedis>[1] = {}) {
  const writer = new BufferDumpWriter();
  const result = await dumpRedis(connection, options, writer);
  return { result, commands: parseRedisCommands(writer.toBuffer()).map(c => c.argv.map(String)) };
}

describe('dumpRedis', () => {
  it('writes the current database without SELECT, so it restores anywhere', async () => {
    const connection = new MockConnection(server('7.2.5', { a: '1', b: 'two words' }), {
      selectedDatabase: 0,
    });
    const { result, commands } = await dump(connection);
    expect(commands).toEqual([
      ['SET', 'a', '1'],
      ['SET', 'b', 'two words'],
    ]);
    expect(result).toMatchObject({
      keysExported: 2,
      keysSkipped: 0,
      commandsWritten: 2,
      cancelled: false,
    });
    expect(result.server).toMatchObject({ flavor: 'redis', version: '7.2.5' });
    // Two keys, one SCAN page: types and expiries, sizes, values — three pipelines.
    expect(connection.pipelines).toEqual([4, 2, 2]);
  });

  it('writes expiries as absolute instants, or relative, or not at all', async () => {
    const connection = new MockConnection(server('7.2.5', { expiring: 'v' }), {
      selectedDatabase: 0,
    });
    expect((await dump(connection)).commands.at(-1)).toEqual([
      'PEXPIREAT',
      'expiring',
      '1700000060000',
    ]);
    const relative = await dump(connection, { expiration: 'relative' });
    expect(relative.commands.at(-1)?.[0]).toBe('PEXPIRE');
    expect(Number(relative.commands.at(-1)?.[2])).toBeGreaterThan(0);
    expect((await dump(connection, { expiration: 'none' })).commands).toEqual([
      ['SET', 'expiring', 'v'],
    ]);
  });

  it('computes absolute expiries from the server clock on servers without PEXPIRETIME', async () => {
    const connection = new MockConnection(server('6.2.14', { expiring: 'v' }), {
      selectedDatabase: 0,
    });
    const { commands } = await dump(connection);
    const instant = Number(commands.at(-1)?.[2]);
    // Server TIME said 1700000000.5s; the key had 60s left. The local clock is
    // nowhere near 2023, so this proves the server's clock was used.
    expect(Math.abs(instant - 1_700_000_060_500)).toBeLessThan(5_000);
  });

  it("SELECTs each database for 'all', and puts the connection back", async () => {
    const connection = new MockConnection(server('7.2.5', { a: '1' }), { selectedDatabase: 0 });
    const { result, commands } = await dump(connection, { databases: 'all' });
    expect(commands.filter(command => command[0] === 'SELECT')).toEqual([
      ['SELECT', '0'],
      ['SELECT', '3'],
    ]);
    expect(result.databases.map(entry => entry.database)).toEqual([0, 3]);
    expect(result.requirements.databases).toEqual([0, 3]);
    expect(connection.sent.at(-1)).toEqual(['SELECT', '0']);
  });

  it('labels the dump with an ECHO header when asked', async () => {
    const connection = new MockConnection(server('7.2.5', {}), { selectedDatabase: 0 });
    const { commands } = await dump(connection, { header: true });
    expect(commands[0]?.[0]).toBe('ECHO');
    expect(commands[0]?.[1]).toMatch(
      /^dbgate-redis-dumper \S+ format=text source=redis\/7\.2\.5 created=/,
    );
  });

  it('refuses cluster nodes, sentinels and servers older than 5.0', async () => {
    await expect(
      dump(new MockConnection(server('7.2.5', {}, { redis_mode: 'cluster' }))),
    ).rejects.toMatchObject({
      code: 'cluster-unsupported',
    });
    await expect(
      dump(new MockConnection(server('7.2.5', {}, { redis_mode: 'sentinel' }))),
    ).rejects.toMatchObject({
      code: 'sentinel-unsupported',
    });
    await expect(dump(new MockConnection(server('4.0.14', {})))).rejects.toMatchObject({
      code: 'unsupported-version',
    });
  });

  it('reports a key that vanished between SCAN and read, and leaves it out', async () => {
    const base = server('7.2.5', { a: '1', gone: 'x' });
    const connection = new MockConnection(
      command =>
        command[1] === 'gone' && command[0] === 'TYPE' ? Buffer.from('none') : base(command),
      { selectedDatabase: 0 },
    );
    const { result, commands } = await dump(connection);
    expect(commands).toEqual([['SET', 'a', '1']]);
    expect(result.keysSkipped).toBe(1);
    expect(result.warnings).toMatchObject([{ code: 'key-vanished', severity: 'info' }]);
  });

  it('validates its options before touching the connection', async () => {
    const connection = new MockConnection(server('7.2.5', {}));
    await expect(dump(connection, { batchSize: 0 })).rejects.toThrow(RangeError);
    await expect(dump(connection, { databases: [-1] })).rejects.toThrow(RangeError);
    expect(connection.sent).toEqual([]);
  });

  it('throws when cancelled before the server has even answered', async () => {
    const controller = new AbortController();
    controller.abort();
    const connection = new MockConnection(server('7.2.5', {}));
    await expect(
      dumpRedis(connection, {}, new BufferDumpWriter(), undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'OperationCancelledError' });
  });
});
