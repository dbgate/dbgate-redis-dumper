import type { RedisArgument, RedisCommand } from '../connection/types.js';
import { argumentText, commandName } from '../protocol/arguments.js';
import { encodeTextCommand } from '../protocol/textEncoding.js';

/**
 * Commands a restore executes by default: everything that writes data, and
 * nothing that administers the server.
 *
 * A dump file is input from outside the program, and a Redis script can do
 * far more than insert data — `FLUSHALL`, `CONFIG SET dir`, `SLAVEOF`,
 * `SHUTDOWN`, `MODULE LOAD`, `EVAL`. Restoring a file of unknown origin
 * should not be able to reconfigure or wipe the server, so anything not
 * listed here is refused unless the caller opts in with
 * `allowedCommands: 'any'` or its own list.
 */
export const RESTORE_COMMANDS: ReadonlySet<string> = new Set([
  // Connection state and no-ops.
  'SELECT',
  'ECHO',
  'PING',
  // Transactions, which some scripts wrap batches in.
  'MULTI',
  'EXEC',
  'DISCARD',
  // Keys and expiry.
  'DEL',
  'UNLINK',
  'EXPIRE',
  'PEXPIRE',
  'EXPIREAT',
  'PEXPIREAT',
  'PERSIST',
  'RESTORE',
  // Strings.
  'SET',
  'SETEX',
  'PSETEX',
  'SETNX',
  'MSET',
  'MSETNX',
  'APPEND',
  'SETRANGE',
  'SETBIT',
  'INCR',
  'INCRBY',
  'INCRBYFLOAT',
  'DECR',
  'DECRBY',
  'PFADD',
  'PFMERGE',
  // Hashes.
  'HSET',
  'HMSET',
  'HSETNX',
  'HINCRBY',
  'HINCRBYFLOAT',
  'HEXPIRE',
  'HPEXPIRE',
  'HEXPIREAT',
  'HPEXPIREAT',
  'HPERSIST',
  // Lists.
  'RPUSH',
  'LPUSH',
  'RPUSHX',
  'LPUSHX',
  'LINSERT',
  'LSET',
  // Sets and sorted sets.
  'SADD',
  'ZADD',
  'ZINCRBY',
  'GEOADD',
  // Streams.
  'XADD',
  'XSETID',
  'XGROUP',
  'XCLAIM',
  'XDEL',
  'XTRIM',
]);

/** `XGROUP` subcommands that belong in a restore; `XGROUP HELP` and friends do not matter either way. */
const XGROUP_SUBCOMMANDS = new Set(['CREATE', 'CREATECONSUMER', 'DESTROY', 'DELCONSUMER', 'SETID']);

/** What a restore may execute: the default data-only set, anything, or an explicit list. */
export type AllowedCommands = 'restore' | 'any' | readonly string[];

/** `undefined` when `command` may run; otherwise the reason it may not. */
export function checkCommandAllowed(
  command: RedisCommand,
  allowed: AllowedCommands,
): string | undefined {
  if (allowed === 'any') {
    return undefined;
  }
  const name = commandName(command);
  if (allowed !== 'restore') {
    return allowed.some(entry => entry.toUpperCase() === name)
      ? undefined
      : `${name} is not in allowedCommands`;
  }
  if (!RESTORE_COMMANDS.has(name)) {
    return `${name} is not a data command; pass allowedCommands to permit it`;
  }
  if (name === 'XGROUP' && !XGROUP_SUBCOMMANDS.has(argumentText(command, 1)?.toUpperCase() ?? '')) {
    return `XGROUP ${argumentText(command, 1) ?? ''} is not a data command; pass allowedCommands to permit it`;
  }
  return undefined;
}

const REDACTED = '<redacted>';

/**
 * A copy of `command` with every credential replaced by `<redacted>`, for
 * error messages and previews: `AUTH`, `HELLO ... AUTH`, `MIGRATE ... AUTH`/
 * `AUTH2`, `CONFIG SET requirepass|masterauth`, `ACL SETUSER` passwords.
 */
export function redactCommand(command: RedisCommand): RedisArgument[] {
  const name = commandName(command);
  const out = [...command];
  const upper = (index: number): string => argumentText(command, index)?.toUpperCase() ?? '';

  if (name === 'AUTH') {
    for (let index = 1; index < out.length; index++) out[index] = REDACTED;
  } else if (name === 'HELLO' || name === 'MIGRATE') {
    for (let index = 1; index < out.length; index++) {
      if (upper(index) === 'AUTH') {
        // HELLO/MIGRATE AUTH: username password (HELLO) or password (MIGRATE).
        const count = name === 'HELLO' ? 2 : 1;
        for (let at = 1; at <= count && index + at < out.length; at++) out[index + at] = REDACTED;
      } else if (upper(index) === 'AUTH2') {
        for (let at = 1; at <= 2 && index + at < out.length; at++) out[index + at] = REDACTED;
      }
    }
  } else if (name === 'CONFIG' && upper(1) === 'SET') {
    for (let index = 2; index + 1 < out.length; index += 2) {
      if (/^(requirepass|masterauth|masteruser)$/i.test(argumentText(command, index) ?? '')) {
        out[index + 1] = REDACTED;
      }
    }
  } else if (name === 'ACL' && upper(1) === 'SETUSER') {
    for (let index = 3; index < out.length; index++) {
      if (/^[>#<!]/.test(argumentText(command, index) ?? '')) out[index] = REDACTED;
    }
  }
  return out;
}

/** A bounded, credential-redacted, printable rendering of a command. */
export function previewCommand(command: RedisCommand, maxLength = 200): string {
  const text = encodeTextCommand(redactCommand(command)).toString('utf8').trimEnd();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
