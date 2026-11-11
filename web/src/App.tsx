import { lazy, Suspense } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ErrorBoundary } from '@/components/layout/ErrorBoundary';
import { Button, EmptyState, LoadingState } from '@/components/ui';
import { BootScreen, LoginPage, SetupPage } from '@/pages/Auth';
import { LiveProvider } from '@/state/live';
import { useAuth } from '@/state/auth';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Containers = lazy(() => import('@/pages/Containers'));
const ContainerDetail = lazy(() => import('@/pages/ContainerDetail'));
const ComposePage = lazy(() => import('@/pages/Compose'));
const ComposeDetail = lazy(() => import('@/pages/ComposeDetail'));
const Images = lazy(() => import('@/pages/Images'));
const Maintenance = lazy(() => import('@/pages/Maintenance'));
const Storage = lazy(() => import('@/pages/Storage'));
const LogsEvents = lazy(() => import('@/pages/LogsEvents'));
const Settings = lazy(() => import('@/pages/Settings'));

export function NotFound() {
  return (
    <EmptyState
      icon="search"
      title="Page not found"
      action={
        <Link to="/">
          <Button variant="primary">Back to the dashboard</Button>
        </Link>
      }
    >
      There is nothing at this address.
    </EmptyState>
  );
}

export default function App() {
  const { phase, error, retry } = useAuth();
  if (phase === 'loading') return <BootScreen />;
  if (phase === 'error') return <BootScreen error={error} onRetry={retry} />;
  if (phase === 'setup') return <SetupPage />;
  if (phase === 'login') return <LoginPage />;

  return (
    <LiveProvider>
      <ErrorBoundary level="root">
        <Suspense fallback={<LoadingState />}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Dashboard />} />
              <Route path="containers" element={<Containers />} />
              <Route path="containers/:ref" element={<ContainerDetail />} />
              <Route path="compose" element={<ComposePage />} />
              <Route path="compose/:name" element={<ComposeDetail />} />
              <Route path="images" element={<Images />} />
              <Route path="maintenance/*" element={<Maintenance />} />
              <Route path="storage" element={<Storage />} />
              <Route path="logs" element={<LogsEvents />} />
              <Route path="settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </LiveProvider>
  );
}
