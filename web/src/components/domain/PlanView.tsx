import type { Plan } from '@/api/types';
import { Badge, Card, CardBody, CardHeader, Notice, Tag } from '@/components/ui';
import { bytes, shortDigest } from '@/lib/format';

/** Dry-run plan: ordered steps, affected services and dependents, downtime and data-risk flags. */
export function PlanView({ plan }: { plan: Plan }) {
  const byName = new Map(plan.services.map((s) => [s.service, s]));
  return (
    <div className="space-y-4">
      {plan.blocked ? (
        <Notice tone="critical" title="This plan cannot run">
          {plan.blocked.message}
        </Notice>
      ) : null}
      {plan.warnings.map((w) => (
        <Notice key={w} tone="warning">
          {w}
        </Notice>
      ))}

      <Card>
        <CardHeader title="Order of operations" description={`Target: ${plan.target}. Services are updated in this order; dependencies first.`} />
        <CardBody>
          {plan.order.length === 0 ? (
            <p className="text-sm text-muted">Nothing to update: no service has a newer staged or available image.</p>
          ) : (
            <ol className="space-y-3">
              {plan.order.map((name, i) => {
                const s = byName.get(name);
                if (!s) return null;
                return (
                  <li key={name} className="rounded-lg border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold">{i + 1}</span>
                      <span className="font-medium">{name}</span>
                      <Badge tone={s.role === 'update' ? 'info' : 'inactive'}>{s.role === 'update' ? 'update' : `recreated with ${s.dependentOf ?? 'dependency'}`}</Badge>
                      {s.critical ? <Badge tone="warning">critical</Badge> : null}
                      {s.requireApproval ? <Badge tone="warning">needs approval</Badge> : null}
                      {s.quarantined ? <Badge tone="critical">quarantined</Badge> : null}
                      {s.dataRisk.flagged ? <Badge tone="critical">data risk</Badge> : null}
                    </div>
                    <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="inline text-muted">Image: </dt>
                        <dd className="inline break-all font-mono text-xs">{s.ref}</dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Digest: </dt>
                        <dd className="inline font-mono text-xs">
                          {shortDigest(s.fromDigest)} → {shortDigest(s.toDigest)}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Downtime: </dt>
                        <dd className="inline">{s.downtime}</dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Health check: </dt>
                        <dd className="inline">
                          {s.health.kind === 'healthcheck' ? 'container healthcheck' : s.health.kind === 'oneshot' ? 'one-shot (exit code)' : `stable for ${s.health.stabilizationSeconds}s`}, up to {s.health.timeoutSeconds}s
                          {s.health.probe ? `, probe ${s.health.probe.url}` : ''}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Automatic rollback: </dt>
                        <dd className="inline">{s.autoRollback ? 'yes' : `no — ${s.autoRollbackReason}`}</dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Containers: </dt>
                        <dd className="inline">{s.containers.map((c) => c.name).join(', ') || 'none yet'}</dd>
                      </div>
                    </dl>
                    {s.dataRisk.flagged ? (
                      <Notice tone="critical" title="Data risk" className="mt-2">
                        {s.dataRisk.note}
                        <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                          {s.dataRisk.mounts.map((m) => (
                            <li key={m.target}>
                              {m.type}: {m.source} → {m.target}
                              {m.readOnly ? ' (read-only)' : ''}
                            </li>
                          ))}
                        </ul>
                      </Notice>
                    ) : null}
                    {!s.unattended.eligible ? (
                      <p className="mt-2 text-xs text-muted">Not eligible for unattended runs: {s.unattended.blockers.join('; ')}</p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </CardBody>
      </Card>

      {plan.excluded.length ? (
        <Card>
          <CardHeader title="Left out" />
          <CardBody>
            <ul className="space-y-1 text-sm">
              {plan.excluded.map((e) => (
                <li key={e.service}>
                  <b>{e.service}</b> — <span className="text-muted">{e.reason}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {plan.impact.dependents.length || plan.impact.sharedTag.length ? (
        <Card>
          <CardHeader title="Affected dependents" description="Services that are restarted or share an image with the update." />
          <CardBody className="space-y-2 text-sm">
            {plan.impact.dependents.map((d) => (
              <div key={d.service + d.via}>
                <b>{d.service}</b> <span className="text-muted">({d.kind} via {d.via})</span>
              </div>
            ))}
            {plan.impact.sharedTag.map((t) => (
              <div key={t.containerName}>
                <b>{t.containerName}</b> <Tag>{t.inRun ? 'in this run' : 'not in this run'}</Tag> <span className="text-muted">{t.note}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {plan.drift.length ? (
        <Notice tone="warning" title="Configuration drift">
          {plan.drift.map((d) => d.service).join(', ')}: the running containers differ from the Compose files. Updating applies those changes too.
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title="Safety checks"
          actions={<Badge tone={plan.preflight.ok && plan.validation.valid ? 'healthy' : 'critical'}>{plan.preflight.ok && plan.validation.valid ? 'all passed' : 'attention needed'}</Badge>}
        />
        <CardBody>
          <ul className="space-y-1.5 text-sm">
            {plan.preflight.checks.map((c) => (
              <li key={c.name} className="flex gap-2">
                <Badge tone={c.ok ? 'healthy' : 'critical'}>{c.ok ? 'ok' : 'fail'}</Badge>
                <span>
                  <b>{c.name}</b> <span className="text-muted">{c.detail}</span>
                </span>
              </li>
            ))}
            {plan.validation.errors.map((e) => (
              <li key={e} className="text-critical">
                {e}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            Disk: {plan.disk.requiredBytes == null ? 'needed space unknown' : `${bytes(plan.disk.requiredBytes)} needed`}, {plan.disk.freeBytes == null ? 'free space unknown' : `${bytes(plan.disk.freeBytes)} free`} ({plan.disk.ok ? 'enough' : 'not enough'}).
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
