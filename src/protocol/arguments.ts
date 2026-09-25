import type { RedisArgument, RedisCommand } from '../connection/types.js';

/** The exact bytes an argument is sent as. Strings are UTF-8; numbers are decimal text. */
export function toBuffer(argument: RedisArgument): Buffer {
  if (Buffer.isBuffer(argument)) {
    return argument;
  }
  if (typeof argument === 'number') {
    if (!Number.isFinite(argument)) {
      throw new TypeError(`Cannot send non-finite number ${argument} as a Redis argument`);
    }
    return Buffer.from(String(argument), 'latin1');
  }
  return Buffer.from(argument, 'utf8');
}

/** Byte length of an argument as sent. */
export function argumentByteLength(argument: RedisArgument): number {
  if (Buffer.isBuffer(argument)) {
    return argument.length;
  }
  if (typeof argument === 'number') {
    return String(argument).length;
  }
  return Buffer.byteLength(argument, 'utf8');
}

/** Upper-cased command name, for dispatch and allow-listing. */
export function commandName(command: RedisCommand): string {
  const first = command[0];
  if (first === undefined) {
    return '';
  }
  return toBuffer(first).toString('latin1').toUpperCase();
}

/** Argument `index` as text (ASCII options, numbers and ids), or `undefined` when absent. */
export function argumentText(command: RedisCommand, index: number): string | undefined {
  const argument = command[index];
  return argument === undefined ? undefined : toBuffer(argument).toString('latin1');
}
