import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Icon, IconButton, Notice, type IconName } from '@/components/ui';
import { useAuth, useMode } from '@/state/auth';
import { useTheme } from '@/state/theme';
import { useLive } from '@/state/live';
import { ErrorBoundary } from './ErrorBoundary';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/containers', label: 'Containers', icon: 'box' },
  { to: '/compose', label: 'Compose Projects', icon: 'layers' },
  { to: '/images', label: 'Images', icon: 'image' },
  { to: '/maintenance', label: 'Maintenance', icon: 'wrench' },
  { to: '/storage', label: 'Volumes & Networks', icon: 'database' },
  { to: '/logs', label: 'Logs & Events', icon: 'scroll' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <img src="/favicon.svg" alt="" className="h-8 w-8 rounded-lg" />
      <span className="text-base font-semibold tracking-tight">Quaymaster</span>
    </div>
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )
          }
        >
          <Icon name={n.icon} className="h-[18px] w-[18px]" />
          {n.label}
        </NavLink>
      ))}
    </nav>
  );
}

function LiveDot() {
  const { status } = useLive();
  const map = {
    live: ['bg-healthy', 'Live updates connected'],
    connecting: ['bg-info', 'Connecting to live updates…'],
    reconnecting: ['bg-warning', 'Live updates interrupted, reconnecting…'],
    closed: ['bg-inactive', 'Live updates stopped'],
  } as const;
  const [dot, label] = map[status];
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted" title={label}>
      <span className={cn('h-2 w-2 rounded-full', dot, status === 'live' && 'animate-pulse')} />
      <span className="hidden sm:inline">{status === 'live' ? 'Live' : status === 'closed' ? 'Offline' : 'Reconnecting'}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function AppShell() {
  const [open, setOpen] = useState(false);
  const { session, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { mode } = useMode();
  const loc = useLocation();

  useEffect(() => setOpen(false), [loc.pathname]);

  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[200] focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-fg"
      >
        Skip to content
      </a>
      {/* desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r border-border bg-surface px-3 py-4 lg:flex">
        <Brand />
        <NavList />
        <div className="mt-auto px-2 text-xs text-muted">Docker maintenance dashboard</div>
      </aside>
      {/* mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col gap-6 bg-surface px-3 py-4 shadow-xl">
            <div className="flex items-center justify-between">
              <Brand />
              <IconButton icon="x" label="Close navigation" onClick={() => setOpen(false)} />
            </div>
            <NavList onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 sm:px-5">
          <IconButton
            icon="menu"
            label="Open navigation"
            className="lg:hidden"
            onClick={() => setOpen(true)}
            aria-expanded={open}
          />
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="ml-auto flex items-center gap-1 sm:gap-3">
            <LiveDot />
            <IconButton
              icon={theme === 'dark' ? 'sun' : 'moon'}
              label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={toggle}
            />
            <div className="hidden items-center gap-2 border-l border-border pl-3 text-sm sm:flex">
              <Icon name="user" className="h-4 w-4 text-muted" />
              <span className="max-w-32 truncate font-medium">{session?.user.username}</span>
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">{session?.user.role}</span>
            </div>
            <IconButton icon="logout" label="Sign out" onClick={() => void logout()} />
          </div>
        </header>

        {mode?.readOnly ? (
          <div className="border-b border-border bg-warning/10 px-4 py-2 text-sm">
            <span className="font-semibold text-warning">Read-only mode.</span>{' '}
            <span className="text-muted">{mode.readOnlyReason ?? 'Changes are disabled on this instance.'}</span>
          </div>
        ) : null}

        <main id="main" tabIndex={-1} className="qm-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1500px] p-4 sm:p-6">
            <ErrorBoundary key={loc.pathname}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}

export function ScopeNotice() {
  const { mode } = useMode();
  if (!mode || mode.managedScope.length === 0) return null;
  return (
    <Notice tone="info" className="mb-4" title="Managed scope is active">
      Only resources matching <code className="font-mono">{mode.managedScope.join(', ')}</code> can be changed. Everything
      else is read-only.
    </Notice>
  );
}
