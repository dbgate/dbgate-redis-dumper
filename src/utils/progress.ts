export type DumpProgressPhase =
  'connecting' | 'detecting-version' | 'scanning' | 'exporting-keys' | 'finalizing';

export interface DumpProgressEvent {
  readonly phase: DumpProgressPhase;
  readonly message?: string;
  /** Logical database currently being dumped. */
  readonly database?: number;
  /** Keys written for the current database so far. */
  readonly keysExported?: number;
  /** Keys written across every database so far. */
  readonly totalKeysExported?: number;
  /**
   * The server's own key count for the current database (`INFO keyspace`),
   * read once when the database starts. An estimate: keys are written and
   * expire while the dump runs, and a selection only exports a subset.
   */
  readonly keysEstimated?: number;
  /** Commands written to the output so far. */
  readonly commandsWritten?: number;
  /** Bytes written to the output so far. */
  readonly bytesWritten?: number;
  /** Printable form of the key currently being exported, for large keys. */
  readonly keyName?: string;
}

export type DumpProgressCallback = (event: DumpProgressEvent) => void;

export type RestoreProgressPhase = 'connecting' | 'executing' | 'finalizing';

export interface RestoreProgressEvent {
  readonly phase: RestoreProgressPhase;
  readonly message?: string;
  /** Commands executed plus commands failed so far. */
  readonly commandsProcessed?: number;
  /** UTF-8/raw bytes of the source consumed by the parser so far. */
  readonly bytesConsumed?: number;
  /** Logical database the restore is currently writing to, when known. */
  readonly database?: number;
  /** Details of a command failure, emitted as soon as it is known. */
  readonly error?: {
    readonly commandIndex: number;
    readonly location: { readonly line?: number; readonly offset: number };
    readonly commandPreview: string;
    readonly message: string;
  };
}

export type RestoreProgressCallback = (event: RestoreProgressEvent) => void;
