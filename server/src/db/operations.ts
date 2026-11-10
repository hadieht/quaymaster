import type { OperationInfo, OperationStatus } from '@quaymaster/shared';
import type { Db } from './connection.js';

interface OpRow {
  id: string;
  kind: string;
  target: string;
  status: OperationStatus;
  actor: string;
  started_at: number;
  finished_at: number | null;
  compose_version: string | null;
  params: string | null;
  output: string;
  error: string | null;
}

const MAX_OUTPUT = 256 * 1024;

export class OperationsRepo {
  constructor(private readonly db: Db) {}

  create(op: {
    id: string;
    kind: string;
    target: string;
    actor: string;
    params: unknown;
    composeVersion: string | null;
  }): void {
    this.db
      .prepare(
        "INSERT INTO operations (id, kind, target, status, actor, started_at, compose_version, params) VALUES (?,?,?,'running',?,?,?,?)",
      )
      .run(
        op.id,
        op.kind,
        op.target,
        op.actor,
        Date.now(),
        op.composeVersion,
        JSON.stringify(op.params ?? null),
      );
  }

  appendOutput(id: string, text: string): void {
    // keep the tail when output exceeds the cap
    this.db
      .prepare('UPDATE operations SET output = substr(output || ?, -?) WHERE id = ?')
      .run(text, MAX_OUTPUT, id);
  }

  finish(id: string, status: Exclude<OperationStatus, 'running'>, error: string | null): void {
    this.db
      .prepare('UPDATE operations SET status = ?, finished_at = ?, error = ? WHERE id = ?')
      .run(status, Date.now(), error, id);
  }

  get(id: string): OperationInfo | undefined {
    const r = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as OpRow | undefined;
    return r ? toInfo(r) : undefined;
  }

  list(limit: number): OperationInfo[] {
    return (
      this.db.prepare('SELECT * FROM operations ORDER BY started_at DESC LIMIT ?').all(limit) as OpRow[]
    ).map(toInfo);
  }

  /** Startup: operations left `running` by a crash are marked failed/interrupted (never resumed). */
  markInterrupted(): number {
    return this.db
      .prepare(
        "UPDATE operations SET status='failed', finished_at=?, error='interrupted: Quaymaster stopped while this operation was running' WHERE status='running'",
      )
      .run(Date.now()).changes;
  }
}

function toInfo(r: OpRow): OperationInfo {
  return {
    id: r.id,
    kind: r.kind,
    target: r.target,
    status: r.status,
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    actor: r.actor,
    composeVersion: r.compose_version,
    output: r.output,
    error: r.error,
  };
}
