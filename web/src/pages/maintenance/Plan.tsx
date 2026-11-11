import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { q } from '@/api/hooks';
import type { Plan, RunInfo } from '@/api/types';
import { PlanView } from '@/components/domain/PlanView';
import { Button, Card, CardBody, Checkbox, ConfirmDialog, Field, Notice, Select } from '@/components/ui';
import { useGate } from '@/state/auth';

export function PlanPanel() {
  const navigate = useNavigate();
  const gate = useGate();
  const projects = useQuery(q.projects());
  const [project, setProject] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const proj = projects.data?.find((p) => p.name === project);
  const block = gate({
    mutable: proj?.mutable,
    protectedReason: proj?.protectedReason,
    level: proj?.level,
    needsFull: true,
  });

  const make = async () => {
    setBusy(true);
    setError(null);
    setPlan(null);
    try {
      setPlan(
        await api.post<Plan>('/maintenance/plan', {
          project,
          ...(picked.length ? { services: picked } : {}),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The plan could not be created');
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const run = await api.post<RunInfo>('/maintenance/runs', {
      project,
      ...(picked.length ? { services: picked } : {}),
      startNow: false,
    });
    navigate(`/maintenance/runs/${run.id}`);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-4">
          <p className="text-sm text-muted">
            A dry run shows exactly what an update would do. It changes nothing.
          </p>
          <Field label="Project">
            <Select
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                setPicked([]);
                setPlan(null);
              }}
            >
              <option value="">Choose a project…</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.level})
                </option>
              ))}
            </Select>
          </Field>
          {proj ? (
            <fieldset>
              <legend className="mb-1 text-sm font-medium">
                Services (none selected = all with updates)
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {proj.services.map((s) => (
                  <Checkbox
                    key={s.name}
                    label={s.name}
                    checked={picked.includes(s.name)}
                    onChange={(v) => setPicked(v ? [...picked, s.name] : picked.filter((x) => x !== s.name))}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}
          <Button
            variant="primary"
            icon="search"
            loading={busy}
            disabled={!project}
            onClick={() => void make()}
          >
            Create dry-run plan
          </Button>
          {error ? <Notice tone="critical">{error}</Notice> : null}
        </CardBody>
      </Card>
      {plan ? (
        <>
          <PlanView plan={plan} />
          <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">
                Happy with the plan? Save it as a run that waits for approval. Nothing is changed until you
                approve it.
              </p>
              <Button
                variant="primary"
                icon="check"
                disabledReason={block ?? (plan.blocked ? plan.blocked.message : null)}
                onClick={() => setConfirm(true)}
              >
                Prepare run for approval…
              </Button>
            </CardBody>
          </Card>
        </>
      ) : null}
      {confirm ? (
        <ConfirmDialog
          open
          onClose={() => setConfirm(false)}
          title="Prepare run"
          target={project}
          variant="primary"
          confirmLabel="Prepare run"
          impact="A run is stored and appears in the approval queue. No container is changed until it is approved."
          onConfirm={start}
        />
      ) : null}
    </div>
  );
}
