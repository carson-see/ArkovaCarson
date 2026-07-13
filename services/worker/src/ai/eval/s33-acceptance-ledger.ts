/**
 * Offline S3.3 ceremony evidence ledger.
 *
 * Records are newline-delimited canonical JSON with a SHA-256 hash chain.
 * Every mutation holds an O_EXCL lock and fsyncs the ledger before release.
 * Selection consumption additionally creates an O_EXCL marker and fsyncs its
 * directory before appending, so a crash can cause a safe permanent refusal
 * but can never return the same sample ceremony twice.
 */

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { canonicaliseJson } from '../../utils/canonical-json.js';

export type CeremonyEvent = Record<string, unknown> & { kind: string };

interface LedgerRecord {
  sequence: number;
  previousRecordSha256: string | null;
  event: CeremonyEvent;
  recordSha256: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function writeAll(fd: number, content: string): void {
  const bytes = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DurableAcceptanceLedger {
  private readonly ledgerPath: string;
  private readonly evidenceDirectory: string;
  private readonly lockPath: string;
  private readonly consumptionDirectory: string;

  constructor(ledgerPath: string) {
    if (!isAbsolute(ledgerPath) || basename(ledgerPath).trim().length === 0) {
      throw new Error('Acceptance ledger path must be an absolute file path');
    }
    mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
    this.evidenceDirectory = realpathSync(dirname(ledgerPath));
    this.ledgerPath = join(this.evidenceDirectory, basename(ledgerPath));
    this.lockPath = `${this.ledgerPath}.lock`;
    this.consumptionDirectory = `${this.ledgerPath}.consumed`;
    mkdirSync(this.consumptionDirectory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.consumptionDirectory).isSymbolicLink()) {
      throw new Error('Acceptance consumption directory must not be a symbolic link');
    }
  }

  append(event: CeremonyEvent, validate: (events: readonly CeremonyEvent[]) => void): CeremonyEvent[] {
    return this.withExclusiveLock((records) => {
      const events = records.map(({ event: prior }) => prior);
      validate(events);
      const next = this.buildRecord(records, event);
      this.appendRecord(next);
      return [...events, event];
    });
  }

  consume(
    uniqueKey: string,
    event: CeremonyEvent,
    validate: (events: readonly CeremonyEvent[]) => void,
  ): CeremonyEvent[] {
    return this.withExclusiveLock((records) => {
      const events = records.map(({ event: prior }) => prior);
      validate(events);
      const markerName = `${sha256(uniqueKey)}.json`;
      const markerPath = join(this.consumptionDirectory, markerName);
      let markerFd: number;
      try {
        markerFd = openSync(
          markerPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'UNKNOWN';
        if (code === 'EEXIST') {
          throw new Error('Selection ceremony already consumed by an exclusive marker', { cause: error });
        }
        throw error;
      }
      try {
        writeAll(markerFd, `${canonicaliseJson({ uniqueKey, event })}\n`);
        fsyncSync(markerFd);
      } finally {
        closeSync(markerFd);
      }
      syncDirectory(this.consumptionDirectory);

      // Marker durability precedes the append. If append/fsync fails, the
      // marker intentionally remains and all retries fail closed.
      const next = this.buildRecord(records, event);
      this.appendRecord(next);
      return [...events, event];
    });
  }

  private withExclusiveLock<T>(operation: (records: LedgerRecord[]) => T): T {
    let lockFd: number;
    try {
      lockFd = openSync(
        this.lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'UNKNOWN';
      if (code === 'EEXIST') {
        throw new Error('Acceptance ledger is locked by another ceremony process', { cause: error });
      }
      throw error;
    }
    try {
      writeAll(lockFd, `${process.pid}\n`);
      fsyncSync(lockFd);
      return operation(this.readValidatedRecords());
    } finally {
      closeSync(lockFd);
      unlinkSync(this.lockPath);
      syncDirectory(this.evidenceDirectory);
    }
  }

  private readValidatedRecords(): LedgerRecord[] {
    if (!existsSync(this.ledgerPath)) return [];
    if (lstatSync(this.ledgerPath).isSymbolicLink()) {
      throw new Error('Acceptance ledger must not be a symbolic link');
    }
    const content = readFileSync(this.ledgerPath, 'utf8');
    if (content.length === 0) return [];
    if (!content.endsWith('\n')) throw new Error('Acceptance ledger hash chain is truncated');
    const records: LedgerRecord[] = [];
    for (const [index, line] of content.trimEnd().split('\n').entries()) {
      let candidate: unknown;
      try {
        candidate = JSON.parse(line);
      } catch (error) {
        throw new Error(`Acceptance ledger hash chain record ${index + 1} is invalid JSON`, { cause: error });
      }
      if (!isRecord(candidate)
        || candidate.sequence !== index + 1
        || !isRecord(candidate.event)
        || typeof candidate.event.kind !== 'string'
        || !/^[0-9a-f]{64}$/.test(String(candidate.recordSha256))) {
        throw new Error(`Acceptance ledger hash chain record ${index + 1} has an invalid schema`);
      }
      const expectedPrevious = records.at(-1)?.recordSha256 ?? null;
      if (candidate.previousRecordSha256 !== expectedPrevious) {
        throw new Error(`Acceptance ledger hash chain predecessor mismatch at record ${index + 1}`);
      }
      const material = {
        sequence: candidate.sequence,
        previousRecordSha256: candidate.previousRecordSha256,
        event: candidate.event,
      };
      const expectedHash = sha256(canonicaliseJson(material));
      if (candidate.recordSha256 !== expectedHash) {
        throw new Error(`Acceptance ledger hash chain digest mismatch at record ${index + 1}`);
      }
      records.push(candidate as unknown as LedgerRecord);
    }
    return records;
  }

  private buildRecord(records: readonly LedgerRecord[], event: CeremonyEvent): LedgerRecord {
    const material = {
      sequence: records.length + 1,
      previousRecordSha256: records.at(-1)?.recordSha256 ?? null,
      event,
    };
    return { ...material, recordSha256: sha256(canonicaliseJson(material)) };
  }

  private appendRecord(record: LedgerRecord): void {
    const fd = openSync(
      this.ledgerPath,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeAll(fd, `${canonicaliseJson(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(this.evidenceDirectory);
  }
}
