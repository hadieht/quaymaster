import { useState, type FormEvent, type ReactNode } from 'react';
import { describeError } from '@/api/client';
import { Button, Field, Input, Notice, Spinner } from '@/components/ui';
import { useAuth } from '@/state/auth';

function Frame({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src="/favicon.svg" alt="" className="h-12 w-12 rounded-xl" />
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted">{subtitle}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-5 shadow-card">{children}</div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Sign in to Quaymaster" subtitle="Docker monitoring and maintenance">
      <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label="Sign in">
        <Field label="Username">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        {error ? <Notice tone="critical">{error}</Notice> : null}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          loading={busy}
          disabled={!username || !password}
        >
          Sign in
        </Button>
      </form>
    </Frame>
  );
}

export function SetupPage() {
  const { setup } = useAuth();
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;
  const tooShort = password.length > 0 && password.length < 12;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setup(token.trim(), username.trim(), password);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Welcome to Quaymaster" subtitle="Create the first administrator">
      <form onSubmit={(e) => void submit(e)} className="space-y-4" aria-label="First-run setup">
        <Notice tone="info">
          The one-time setup token is printed in the server log on first start and saved as{' '}
          <code>setup-token</code> in the data directory.
        </Notice>
        <Field label="Setup token">
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </Field>
        <Field label="Administrator username">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </Field>
        <Field
          label="Password"
          hint="At least 12 characters."
          error={tooShort ? 'Use at least 12 characters.' : null}
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field label="Repeat password" error={mismatch ? 'The passwords do not match.' : null}>
          <Input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        {error ? <Notice tone="critical">{error}</Notice> : null}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          loading={busy}
          disabled={!token || !username || password.length < 12 || mismatch}
        >
          Create administrator
        </Button>
      </form>
    </Frame>
  );
}

export function BootScreen({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  if (error) {
    return (
      <Frame title="Cannot reach the server" subtitle="Quaymaster did not answer">
        <Notice tone="critical">{describeError(error)}</Notice>
        {onRetry ? (
          <Button className="mt-4 w-full" icon="refresh" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </Frame>
    );
  }
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  );
}
