import { callMany, describeKey } from '../connection/acquire.js';
import type {
  RedisArgument,
  RedisCommand,
  RedisConnection,
  RedisPipelineResult,
  RedisReply,
} from '../connection/types.js';
import type { DiagnosticCollector, RedisCoreKeyType } from '../model/index.js';
import { isCoreKeyType } from '../model/index.js';
import {
  replyToArray,
  replyToBuffer,
  replyToBufferArray,
  replyToInteger,
  replyToNullableBuffer,
  replyToString,
} from '../protocol/replies.js';
import type { DumpSelection } from '../selection/index.js';
import { typeMatchesSelection } from '../selection/index.js';
import { errorMessage, throwIfAborted } from '../utils/errors.js';
import type { RedisServerCapabilities } from '../version/types.js';
import type { CommandSink } from './chunker.js';
import { CommandChunker, variadic } from './chunker.js';
import type { ServerClock } from './clock.js';
import { exportStream } from './streamExport.js';
import type { ResolvedKeyExportOptions } from './types.js';

export interface KeyExportContext {
  readonly connection: RedisConnection;
  readonly capabilities: RedisServerCapabilities;
  readonly options: ResolvedKeyExportOptions;
  readonly emit: CommandSink;
  readonly diagnostics: DiagnosticCollector;
  readonly clock: ServerClock;
  /** The logical database being exported; diagnostics carry it. */
  readonly database: number;
  readonly selection?: DumpSelection;
  readonly signal?: AbortSignal;
  /** Called before a key too large to prefetch is streamed, for progress reporting. */
  readonly onLargeKey?: (key: Buffer) => void;
}

export interface PageExportResult {
  readonly keysExported: number;
  /** Keys filtered out by type, vanished while being read, or of a skipped type. */
  readonly keysSkipped: number;
}

/** A key's expiry, in both forms, as of the moment it was read. */
interface Expiry {
  readonly absoluteMs: number;
  readonly remainingMs: number;
}

type Plan =
  | { readonly kind: 'skip' }
  | { readonly kind: 'payload'; payload?: Buffer | null }
  | { readonly kind: 'stream' }
  | {
      readonly kind: 'small';
      readonly type: Exclude<RedisCoreKeyType, 'stream'>;
      value?: RedisReply;
    }
  | {
      readonly kind: 'large';
      readonly type: Exclude<RedisCoreKeyType, 'stream'>;
      readonly size: number;
    };

interface KeyState {
  readonly key: Buffer;
  type: string;
  expiry: Expiry | null;
  plan: Plan;
  /** Per-field hash expirations, for small hashes on servers that have them. */
  fieldExpiries?: readonly number[];
}

const SIZE_COMMAND: Record<Exclude<RedisCoreKeyType, 'stream'>, string> = {
  string: 'STRLEN',
  hash: 'HLEN',
  list: 'LLEN',
  set: 'SCARD',
  zset: 'ZCARD',
};

function isWrongType(error: unknown): boolean {
  return /^WRONGTYPE\b/.test(errorMessage(error));
}

function replyOf(result: RedisPipelineResult | undefined): RedisReply {
  if (!result) {
    throw new Error('Missing pipeline reply');
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.reply;
}

/**
 * Exports keys one `SCAN` page at a time.
 *
 * Reading a key needs several commands (its type, its expiry, its size,
 * its value), and on a remote server each round trip costs far more than
 * the command itself. So a page is read in stages, each stage one pipeline
 * across every key in the page: types and expiries; sizes; then the values
 * of every key small enough to fetch in one command. Only keys too large to
 * hold in memory at once — and streams, which have groups to walk — are
 * read on their own, in chunks.
 *
 * Nothing here can be made atomic without blocking the server. A key can
 * be written, deleted or expire between two stages; each such race is
 * detected where it can be, and reported rather than papered over.
 */
export class KeyExporter {
  constructor(private readonly context: KeyExportContext) {}

  async exportPage(keys: readonly Buffer[]): Promise<PageExportResult> {
    const { signal } = this.context;
    throwIfAborted(signal);
    const states = await this.readTypesAndExpiries(keys);
    this.plan(states);
    await this.readSizes(states);
    await this.prefetch(states);

    let keysExported = 0;
    let keysSkipped = 0;
    for (const state of states) {
      throwIfAborted(signal);
      if (await this.write(state)) {
        keysExported++;
      } else {
        keysSkipped++;
      }
    }
    return { keysExported, keysSkipped };
  }

  private vanished(state: { key: Buffer }): void {
    this.context.diagnostics.addOnce({
      severity: 'info',
      code: 'key-vanished',
      message: 'A key was deleted or expired while the dump was reading it, and is not in the dump',
      database: this.context.database,
      key: describeKey(state.key),
    });
  }

  private changed(state: { key: Buffer }, detail: string): void {
    this.context.diagnostics.add({
      severity: 'warning',
      code: 'key-changed-during-dump',
      message: `A key was modified while the dump was reading it (${detail}); it is not in the dump`,
      database: this.context.database,
      key: describeKey(state.key),
    });
  }

  private async readTypesAndExpiries(keys: readonly Buffer[]): Promise<KeyState[]> {
    const { connection, capabilities, clock, signal } = this.context;
    const expiryCommand = capabilities.pexpireTime ? 'PEXPIRETIME' : 'PTTL';
    const commands: RedisCommand[] = [];
    for (const key of keys) {
      commands.push(['TYPE', key], [expiryCommand, key]);
    }
    const results = await callMany(connection, commands, signal);
    const now = clock.now();

    return keys.map((key, index) => {
      const type = replyToString(replyOf(results[index * 2]));
      const raw = replyToInteger(replyOf(results[index * 2 + 1]));
      const state: KeyState = { key, type, expiry: null, plan: { kind: 'skip' } };
      if (type === 'none' || raw === -2) {
        this.vanished(state);
        state.type = 'none';
      } else if (raw >= 0) {
        state.expiry = capabilities.pexpireTime
          ? { absoluteMs: raw, remainingMs: raw - now }
          : { absoluteMs: now + raw, remainingMs: raw };
      }
      return state;
    });
  }

  private plan(states: KeyState[]): void {
    const { options, selection } = this.context;
    for (const state of states) {
      const { type } = state;
      if (type === 'none' || !typeMatchesSelection(type, selection)) {
        state.plan = { kind: 'skip' };
      } else if (options.strategy === 'payload') {
        state.plan = { kind: 'payload' };
      } else if (type === 'stream') {
        state.plan = { kind: 'stream' };
      } else if (isCoreKeyType(type)) {
        // Sized in the next stage; `small` is provisional until then.
        state.plan = { kind: 'small', type: type as Exclude<RedisCoreKeyType, 'stream'> };
      } else if (options.unknownTypes === 'payload') {
        this.context.diagnostics.addOnce({
          severity: 'warning',
          code: 'module-type-as-payload',
          message: `Keys of module type "${type}" cannot be rebuilt with commands and are written as RESTORE payloads, which only restore onto a server with the same module and the same or a newer RDB version`,
          database: this.context.database,
          key: describeKey(state.key),
        });
        state.plan = { kind: 'payload' };
      } else {
        this.context.diagnostics.addOnce({
          severity: 'warning',
          code: 'unsupported-key-type',
          message: `Keys of module type "${type}" are not in the dump (unknownTypes: 'skip')`,
          database: this.context.database,
          key: describeKey(state.key),
        });
        state.plan = { kind: 'skip' };
      }
    }
  }

  private async readSizes(states: KeyState[]): Promise<void> {
    const { connection, options, signal } = this.context;
    const sized = states.filter(state => state.plan.kind === 'small');
    const results = await callMany(
      connection,
      sized.map(state => {
        const type = (state.plan as { type: Exclude<RedisCoreKeyType, 'stream'> }).type;
        return [SIZE_COMMAND[type], state.key];
      }),
      signal,
    );
    sized.forEach((state, index) => {
      const type = (state.plan as { type: Exclude<RedisCoreKeyType, 'stream'> }).type;
      const result = results[index];
      if (!result?.ok) {
        if (isWrongType(result?.error)) {
          this.changed(state, 'its type changed');
          state.plan = { kind: 'skip' };
          return;
        }
        throw result?.error;
      }
      const size = replyToInteger(result.reply);
      const limit = type === 'string' ? options.maxCommandBytes : options.batchSize;
      if (type !== 'string' && size === 0) {
        this.vanished(state);
        state.plan = { kind: 'skip' };
      } else if (size > limit) {
        state.plan = { kind: 'large', type, size };
      }
    });
  }

  private async prefetch(states: KeyState[]): Promise<void> {
    const { connection, capabilities, options, signal } = this.context;

    const fetchable = states.filter(
      state => state.plan.kind === 'small' || state.plan.kind === 'payload',
    );
    const results = await callMany(
      connection,
      fetchable.map(state => {
        const plan = state.plan;
        if (plan.kind === 'payload') {
          return ['DUMP', state.key];
        }
        switch ((plan as { type: string }).type) {
          case 'string':
            return ['GET', state.key];
          case 'hash':
            return ['HGETALL', state.key];
          case 'list':
            return ['LRANGE', state.key, 0, -1];
          case 'set':
            return ['SMEMBERS', state.key];
          default:
            return ['ZRANGE', state.key, 0, -1, 'WITHSCORES'];
        }
      }),
      signal,
    );
    fetchable.forEach((state, index) => {
      const result = results[index];
      if (!result?.ok) {
        if (isWrongType(result?.error)) {
          this.changed(state, 'its type changed');
          state.plan = { kind: 'skip' };
          return;
        }
        throw result?.error;
      }
      const plan = state.plan;
      if (plan.kind === 'payload') {
        plan.payload = replyToNullableBuffer(result.reply);
      } else if (plan.kind === 'small') {
        plan.value = result.reply;
      }
    });

    if (!(capabilities.hashFieldExpiration && options.hashFieldExpiration)) {
      return;
    }
    const hashes = states.filter(
      state =>
        state.plan.kind === 'small' &&
        state.plan.type === 'hash' &&
        Array.isArray(state.plan.value) &&
        state.plan.value.length > 0,
    );
    const ttlResults = await callMany(
      connection,
      hashes.map(state => {
        const pairs = (state.plan as { value: readonly RedisReply[] }).value;
        const fields = pairs.filter((_, at) => at % 2 === 0);
        return ['HPEXPIRETIME', state.key, 'FIELDS', fields.length, ...(fields as Buffer[])];
      }),
      signal,
    );
    hashes.forEach((state, index) => {
      const result = ttlResults[index];
      if (result?.ok) {
        state.fieldExpiries = replyToArray(result.reply).map(replyToInteger);
      }
    });
  }

  /** Writes one key. Returns `false` when it was skipped. */
  private async write(state: KeyState): Promise<boolean> {
    const plan = state.plan;
    switch (plan.kind) {
      case 'skip':
        return false;
      case 'payload':
        return this.writePayload(state, plan.payload ?? null);
      case 'stream': {
        this.context.onLargeKey?.(state.key);
        const written = await exportStream(this.context, state.key);
        if (!written) {
          this.vanished(state);
          return false;
        }
        await this.writeExpiry(state);
        return true;
      }
      case 'small':
        return this.writeSmall(state, plan.type, plan.value ?? null);
      case 'large':
        this.context.onLargeKey?.(state.key);
        return this.writeLarge(state, plan.type, plan.size);
    }
  }

  private async writeExpiry(state: KeyState): Promise<void> {
    const { expiry } = state;
    const { options, emit } = this.context;
    if (!expiry || options.expiration === 'none') {
      return;
    }
    if (options.expiration === 'absolute') {
      await emit(['PEXPIREAT', state.key, expiry.absoluteMs]);
    } else {
      // A key that is due to expire this instant still existed when read; one
      // millisecond keeps it from being written as persistent.
      await emit(['PEXPIRE', state.key, Math.max(1, expiry.remainingMs)]);
    }
  }

  private async writePayload(state: KeyState, payload: Buffer | null): Promise<boolean> {
    if (payload === null) {
      this.vanished(state);
      return false;
    }
    const { options, emit } = this.context;
    const command: RedisArgument[] = ['RESTORE', state.key];
    if (!state.expiry || options.expiration === 'none') {
      command.push(0, payload);
    } else if (options.expiration === 'absolute') {
      command.push(state.expiry.absoluteMs, payload);
    } else {
      command.push(Math.max(1, state.expiry.remainingMs), payload);
    }
    if (options.replace) {
      command.push('REPLACE');
    }
    if (state.expiry && options.expiration === 'absolute') {
      command.push('ABSTTL');
    }
    await emit(command);
    return true;
  }

  private chunker(head: readonly RedisArgument[]): CommandChunker {
    const { emit, options } = this.context;
    return new CommandChunker(emit, variadic(head), options.batchSize, options.maxCommandBytes);
  }

  private async writeSmall(
    state: KeyState,
    type: Exclude<RedisCoreKeyType, 'stream'>,
    value: RedisReply,
  ): Promise<boolean> {
    const { emit, options } = this.context;
    const { key } = state;

    if (type === 'string') {
      if (value === null) {
        this.vanished(state);
        return false;
      }
      // SET replaces a key of any type and clears its expiry: no DEL needed.
      await emit(['SET', key, replyToBuffer(value)]);
      await this.writeExpiry(state);
      return true;
    }

    const items = value === null ? [] : replyToBufferArray(value);
    if (items.length === 0) {
      this.vanished(state);
      return false;
    }
    if (options.replace) {
      await emit(['DEL', key]);
    }
    switch (type) {
      case 'hash': {
        const chunker = this.chunker(['HSET', key]);
        for (let at = 0; at + 1 < items.length; at += 2) {
          await chunker.add([items[at] as Buffer, items[at + 1] as Buffer]);
        }
        await chunker.flush();
        const fields = items.filter((_, at) => at % 2 === 0);
        await this.writeFieldExpiries(key, fields, state.fieldExpiries);
        break;
      }
      case 'list': {
        const chunker = this.chunker(['RPUSH', key]);
        for (const item of items) {
          await chunker.add([item]);
        }
        await chunker.flush();
        break;
      }
      case 'set': {
        const chunker = this.chunker(['SADD', key]);
        for (const item of items) {
          await chunker.add([item]);
        }
        await chunker.flush();
        break;
      }
      case 'zset': {
        const chunker = this.chunker(['ZADD', key]);
        for (let at = 0; at + 1 < items.length; at += 2) {
          // ZADD takes score then member; the score is the server's own text
          // (`inf`, `-inf`, 17 significant digits) and is never parsed here.
          await chunker.add([items[at + 1] as Buffer, items[at] as Buffer]);
        }
        await chunker.flush();
        break;
      }
    }
    await this.writeExpiry(state);
    return true;
  }

  /**
   * Writes `HPEXPIREAT` (or `HPEXPIRE`) for every field that has its own
   * expiry, grouping fields that share an instant into one command.
   */
  private async writeFieldExpiries(
    key: Buffer,
    fields: readonly Buffer[],
    expiries: readonly number[] | undefined,
  ): Promise<void> {
    const { options, emit, clock } = this.context;
    if (!expiries || options.expiration === 'none') {
      return;
    }
    const byInstant = new Map<number, Buffer[]>();
    fields.forEach((field, at) => {
      const instant = expiries[at];
      if (instant !== undefined && instant >= 0) {
        const group = byInstant.get(instant) ?? [];
        group.push(field);
        byInstant.set(instant, group);
      }
    });
    const now = clock.now();
    for (const [instant, group] of byInstant) {
      const relative = options.expiration === 'relative';
      const timing = relative ? Math.max(1, instant - now) : instant;
      const chunker = new CommandChunker(
        emit,
        elements => [
          relative ? 'HPEXPIRE' : 'HPEXPIREAT',
          key,
          timing,
          'FIELDS',
          elements.length,
          ...elements.flat(),
        ],
        options.batchSize,
        options.maxCommandBytes,
      );
      for (const field of group) {
        await chunker.add([field]);
      }
      await chunker.flush();
    }
  }

  /**
   * Streams one key too large to prefetch, a chunk at a time.
   *
   * The key is re-checked afterwards: if it vanished part way through, the
   * partial copy already written is deleted again by a trailing `DEL`, so a
   * restore never produces a half-populated key.
   */
  private async writeLarge(
    state: KeyState,
    type: Exclude<RedisCoreKeyType, 'stream'>,
    size: number,
  ): Promise<boolean> {
    const { connection, options, emit, signal } = this.context;
    const { key } = state;

    if (type === 'string') {
      let offset = 0;
      while (offset < size) {
        throwIfAborted(signal);
        const end = Math.min(size, offset + options.maxCommandBytes) - 1;
        const chunk = replyToBuffer(await connection.call(['GETRANGE', key, offset, end], signal));
        if (chunk.length === 0) {
          break;
        }
        await emit([offset === 0 ? 'SET' : 'APPEND', key, chunk]);
        offset += chunk.length;
      }
      const finalLength = replyToInteger(await connection.call(['STRLEN', key], signal));
      if (offset !== size || finalLength !== size) {
        if (offset > 0) {
          await emit(['DEL', key]);
        }
        this.changed(state, `its length changed from ${size} to ${finalLength} bytes`);
        return false;
      }
      await this.writeExpiry(state);
      return true;
    }

    if (options.replace) {
      await emit(['DEL', key]);
    }
    try {
      switch (type) {
        case 'list':
          await this.streamList(key);
          break;
        case 'hash':
          await this.streamScan(key, 'HSCAN', ['HSET', key], pair => pair, true);
          break;
        case 'set':
          await this.streamScan(key, 'SSCAN', ['SADD', key], member => member, false);
          break;
        case 'zset':
          await this.streamScan(
            key,
            'ZSCAN',
            ['ZADD', key],
            ([member, score]) => [score, member],
            true,
          );
          break;
      }
    } catch (error) {
      if (!isWrongType(error)) {
        throw error;
      }
      await emit(['DEL', key]);
      this.changed(state, 'its type changed');
      return false;
    }

    const stillThere = replyToString(await connection.call(['TYPE', key], signal));
    if (stillThere !== type) {
      await emit(['DEL', key]);
      if (stillThere === 'none') {
        this.vanished(state);
      } else {
        this.changed(state, 'its type changed');
      }
      return false;
    }
    await this.writeExpiry(state);
    return true;
  }

  private async streamList(key: Buffer): Promise<void> {
    const { connection, options, signal } = this.context;
    const chunker = this.chunker(['RPUSH', key]);
    for (let start = 0; ; start += options.batchSize) {
      throwIfAborted(signal);
      const items = replyToBufferArray(
        await connection.call(['LRANGE', key, start, start + options.batchSize - 1], signal),
      );
      for (const item of items) {
        await chunker.add([item]);
      }
      if (items.length < options.batchSize) {
        break;
      }
    }
    await chunker.flush();
  }

  /**
   * Walks a collection with `HSCAN`/`SSCAN`/`ZSCAN`. A scan may return an
   * element more than once; that is harmless here, because `HSET`, `SADD`
   * and `ZADD` of an element already present leave the result unchanged.
   */
  private async streamScan(
    key: Buffer,
    scanCommand: 'HSCAN' | 'SSCAN' | 'ZSCAN',
    head: readonly RedisArgument[],
    toElement: (items: readonly [Buffer, Buffer]) => readonly Buffer[],
    paired: boolean,
  ): Promise<void> {
    const { connection, options, capabilities, signal } = this.context;
    const chunker = this.chunker(head);
    const withFieldExpiries =
      scanCommand === 'HSCAN' && capabilities.hashFieldExpiration && options.hashFieldExpiration;
    let cursor = '0';
    do {
      throwIfAborted(signal);
      const reply = replyToArray(
        await connection.call([scanCommand, key, cursor, 'COUNT', options.batchSize], signal),
      );
      cursor = replyToString(reply[0] ?? null);
      const items = replyToBufferArray(reply[1] ?? []);
      const fields: Buffer[] = [];
      if (paired) {
        for (let at = 0; at + 1 < items.length; at += 2) {
          const pair: [Buffer, Buffer] = [items[at] as Buffer, items[at + 1] as Buffer];
          fields.push(pair[0]);
          await chunker.add(toElement(pair));
        }
      } else {
        for (const item of items) {
          await chunker.add([item]);
        }
      }
      if (withFieldExpiries && fields.length > 0) {
        await chunker.flush();
        const expiries = replyToArray(
          await connection.call(['HPEXPIRETIME', key, 'FIELDS', fields.length, ...fields], signal),
        ).map(replyToInteger);
        await this.writeFieldExpiries(key, fields, expiries);
      }
    } while (cursor !== '0');
    await chunker.flush();
  }
}
