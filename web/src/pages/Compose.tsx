import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { q } from '@/api/hooks';
import type { ComposeProjectSummary, CapabilityLevel } from '@/api/types';
import { CapabilityBadge, ProjectStatus } from '@/components/domain/badges';
import { REASON_TITLE } from '@/components/domain/ProjectReasons';
import { ScopeNotice } from '@/components/layout/AppShell';
import {
  Button,
  Card,
  CardBody,
  DataTable,
  ErrorState,
  LoadingState,
  PageHeader,
  SearchInput,
  type Column,
} from '@/components/ui';
import { CAPABILITY_TEXT } from '@/lib/status';

export default function ComposePage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const projects = useQuery(q.projects());
  const rows = useMemo(() => {
    const n = search.trim().toLowerCase();
    return (projects.data ?? []).filter(
      (p) =>
        !n || p.name.toLowerCase().includes(n) || p.services.some((s) => s.name.toLowerCase().includes(n)),
    );
  }, [projects.data, search]);

  const columns: Column<ComposeProjectSummary>[] = [
    {
      key: 'name',
      header: 'Project',
      sort: (a, b) => a.name.localeCompare(b.name),
      cell: (p) => <span className="font-medium">{p.name}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sort: (a, b) => a.status.localeCompare(b.status),
      cell: (p) => <ProjectStatus status={p.status} />,
    },
    {
      key: 'level',
      header: 'Control',
      sort: (a, b) => a.level.localeCompare(b.level),
      cell: (p) => (
        <span className="block">
          <CapabilityBadge level={p.level} />
          {p.level !== 'full' && p.reasonDetails?.length ? (
            <span
              className="mt-1 block max-w-72 text-xs text-muted"
              title={p.reasonDetails.map((r) => r.message).join('\n')}
            >
              {p.reasonDetails.map((r) => REASON_TITLE[r.code] ?? r.code).join('; ')}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'services',
      header: 'Services',
      hideOnSmall: true,
      sort: (a, b) => a.services.length - b.services.length,
      cell: (p) => {
        const running = p.services.filter((s) => s.status === 'running').length;
        return (
          <span className="text-muted">
            {running}/{p.services.length} running
          </span>
        );
      },
    },
    {
      key: 'images',
      header: 'Images',
      hideOnSmall: true,
      cell: (p) => (
        <span
          className="block max-w-72 truncate font-mono text-xs text-muted"
          title={p.services.map((s) => s.image ?? '?').join(', ')}
        >
          {[...new Set(p.services.map((s) => s.image).filter(Boolean))].join(', ') || '–'}
        </span>
      ),
    },
  ];

  const levels: CapabilityLevel[] = ['full', 'limited', 'standalone'];
  return (
    <>
      <PageHeader
        title="Compose Projects"
        description="Projects found from running containers and from the configured stack folders."
        actions={
          <Button icon="refresh" onClick={() => void projects.refetch()}>
            Refresh
          </Button>
        }
      />
      <ScopeNotice />
      <Card className="mb-4">
        <CardBody className="grid gap-3 text-sm sm:grid-cols-3">
          {levels.map((l) => (
            <div key={l}>
              <CapabilityBadge level={l} />
              <p className="mt-1.5 text-xs text-muted">{CAPABILITY_TEXT[l].text}</p>
            </div>
          ))}
        </CardBody>
      </Card>
      <Card>
        <div className="border-b border-border p-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search project or service…"
            label="Search projects"
          />
        </div>
        {projects.isLoading ? (
          <LoadingState rows={4} />
        ) : projects.error ? (
          <ErrorState
            error={projects.error}
            onRetry={() => void projects.refetch()}
            title="Could not load projects"
          />
        ) : (
          <DataTable
            caption="Compose projects"
            rows={rows}
            rowKey={(p) => p.name}
            columns={columns}
            initialSort={{ key: 'name', dir: 'asc' }}
            onRowClick={(p) => navigate(`/compose/${encodeURIComponent(p.name)}`)}
            empty={{
              icon: 'layers',
              title: 'No Compose projects found',
              text: 'Start a project with docker compose, or add its folder to the stack paths.',
            }}
          />
        )}
      </Card>
    </>
  );
}
