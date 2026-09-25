import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { describeIoredisError, fromIoredis } from '../src/ioredis.js';

/** Just enough of an ioredis client: callBuffer, pipeline and the 'close' event. */
class FakeClient extends EventEmitter {
  readonly options = { db: 4 };
  condition: { select: number } | null = null;
  readonly calls: [string, Buffer[]][] = [];

  async callBuffer(name: string, args: Buffer[]): Promise<unknown> {
    this.calls.push([name, args]);
    if (name === 'FAIL') throw new Error('WRONGTYPE Operation against a key');
    return Buffer.from('OK');
  }

  pipeline() {
    const queued: [string, Buffer[]][] = [];
    const pipeline = {
      callBuffer: (name: string, args: Buffer[]) => {
        queued.push([name, args]);
        return pipeline;
      },
      exec: async () =>
        queued.map(([name, args]) => {
          this.calls.push([name, args]);
          return name === 'FAIL' ? [new Error('ERR nope'), null] : [null, Buffer.from('OK')];
        }),
    };
    return pipeline;
  }
}

const adapt = (client: FakeClient) => fromIoredis(client as unknown as Redis);

describe('ioredis adapter', () => {
  it('sends every argument as bytes, so nothing is re-encoded or reformatted', async () => {
    const client = new FakeClient();
    await adapt(client).call(['SET', 'k', 1.5, Buffer.from([0xff])]);
    expect(client.calls[0]).toEqual([
      'SET',
      [Buffer.from('k'), Buffer.from('1.5'), Buffer.from([0xff])],
    ]);
  });

  it('knows the database from the client, and follows its own SELECTs', async () => {
    const client = new FakeClient();
    const connection = adapt(client);
    expect(connection.selectedDatabase).toBe(4);
    await connection.call(['SELECT', 9]);
    expect(connection.selectedDatabase).toBe(9);
    await connection.pipeline([['SELECT', 2], ['FAIL']]);
    expect(connection.selectedDatabase).toBe(2);
    client.condition = { select: 7 };
    expect(adapt(client).selectedDatabase).toBe(7);
  });

  it('reports pipeline errors per command', async () => {
    const results = await adapt(new FakeClient()).pipeline([
      ['SET', 'a', '1'],
      ['FAIL'],
      ['SET', 'b', '2'],
    ]);
    expect(results.map(result => result.ok)).toEqual([true, false, true]);
  });

  it('fails every command once the socket has closed, instead of trusting a reconnect', async () => {
    const client = new FakeClient();
    const connection = adapt(client);
    await connection.call(['PING']);
    client.emit('close');
    await expect(connection.call(['PING'])).rejects.toMatchObject({ code: 'connection-lost' });
    await expect(connection.pipeline([['PING']])).rejects.toMatchObject({
      code: 'connection-lost',
    });
  });

  it('stops listening when detached', () => {
    const client = new FakeClient();
    adapt(client).detach();
    expect(client.listenerCount('close')).toBe(0);
  });

  it('extracts the error prefix', () => {
    expect(describeIoredisError(new Error('NOPERM this user has no permissions'))).toEqual({
      prefix: 'NOPERM',
      message: 'NOPERM this user has no permissions',
    });
    expect(describeIoredisError('not an error')).toBeUndefined();
  });
});
