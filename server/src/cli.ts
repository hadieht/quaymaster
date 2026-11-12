#!/usr/bin/env node
/**
 * Operator helper commands (no Docker access, no network):
 *
 *   quaymaster-cli gen-secret                 print a fresh QM_SECRET_KEY line
 *   quaymaster-cli hash-password              read a password from stdin (or prompt) and print QM_ADMIN_PASSWORD_HASH
 *   quaymaster-cli backup <dest.db>           online, consistent backup of <QM_DATA_DIR>/quaymaster.db
 *   quaymaster-cli restore <src.db>           restore a backup into QM_DATA_DIR (Quaymaster must be stopped)
 *   quaymaster-cli check <file.db>            integrity check + schema version of a database file
 */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PasswordService } from './crypto/password.js';
import { acquireInstanceLock } from './db/connection.js';

const out = (s: string): void => void process.stdout.write(s + '\n');
const err = (s: string): void => void process.stderr.write(s + '\n');

const dataDir = (): string => path.resolve(process.env['QM_DATA_DIR'] ?? './data');
const dbFile = (): string => path.join(dataDir(), 'quaymaster.db');

function readPasswordFromTty(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const w = rl as unknown as { _writeToOutput: (s: string) => void };
    process.stderr.write(prompt);
    w._writeToOutput = () => undefined; // do not echo the password
    rl.question('', (a) => {
      rl.close();
      process.stderr.write('\n');
      resolve(a);
    });
  });
}

async function readPassword(): Promise<string> {
  if (process.stdin.isTTY) {
    const a = await readPasswordFromTty('Password (min 12 characters): ');
    const b = await readPasswordFromTty('Repeat: ');
    if (a !== b) throw new Error('The passwords do not match');
    return a;
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  switch (cmd) {
    case 'gen-secret':
      out(`QM_SECRET_KEY=${randomBytes(32).toString('base64')}`);
      return 0;

    case 'hash-password': {
      const pw = await readPassword();
      PasswordService.validateStrength(pw);
      const log2n = Number.parseInt(process.env['QM_SCRYPT_LOG2_N'] ?? '17', 10);
      // single quotes: the hash contains `$`, which Docker Compose and shells would otherwise expand
      out(`QM_ADMIN_PASSWORD_HASH='${await new PasswordService(log2n).hash(pw)}'`);
      return 0;
    }

    case 'backup': {
      if (!arg) throw new Error('usage: backup <dest.db>');
      const src = dbFile();
      if (!existsSync(src)) throw new Error(`No database at ${src}`);
      const dest = path.resolve(arg);
      if (existsSync(dest)) throw new Error(`${dest} already exists; refusing to overwrite`);
      mkdirSync(path.dirname(dest), { recursive: true });
      // read-only handle: safe next to the running server (WAL), result is a consistent snapshot
      const db = new Database(src, { readonly: true, fileMustExist: true });
      try {
        await db.backup(dest);
      } finally {
        db.close();
      }
      const chk = new Database(dest, { readonly: true });
      const ok = chk.pragma('integrity_check', { simple: true });
      chk.close();
      if (ok !== 'ok') throw new Error(`Backup written but integrity_check says: ${String(ok)}`);
      out(`backup written: ${dest} (${statSync(dest).size} bytes, integrity ok)`);
      out('Also keep QM_SECRET_KEY: stored credentials and webhook secrets are encrypted with it.');
      return 0;
    }

    case 'restore': {
      if (!arg) throw new Error('usage: restore <src.db>');
      const src = path.resolve(arg);
      const chk = new Database(src, { readonly: true, fileMustExist: true });
      const ok = chk.pragma('integrity_check', { simple: true });
      chk.close();
      if (ok !== 'ok') throw new Error(`${src} failed integrity_check: ${String(ok)}`);
      const release = acquireInstanceLock(dataDir()); // refuses while Quaymaster is running on this directory
      try {
        const target = dbFile();
        if (existsSync(target)) {
          const keep = `${target}.before-restore-${Date.now()}`;
          renameSync(target, keep);
          out(`previous database kept as ${keep}`);
        }
        for (const ext of ['-wal', '-shm']) if (existsSync(target + ext)) unlinkSync(target + ext);
        copyFileSync(src, target);
        out(`restored ${src} -> ${target}`);
      } finally {
        release();
      }
      return 0;
    }

    case 'check': {
      if (!arg) throw new Error('usage: check <file.db>');
      const db = new Database(path.resolve(arg), { readonly: true, fileMustExist: true });
      const ok = db.pragma('integrity_check', { simple: true });
      const v = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v;
      db.close();
      out(`integrity_check: ${String(ok)}; schema version: ${String(v)}`);
      return ok === 'ok' ? 0 : 1;
    }

    default:
      err(
        'usage: quaymaster-cli gen-secret | hash-password | backup <dest.db> | restore <src.db> | check <file.db>',
      );
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e: unknown) => {
      err(`error: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
