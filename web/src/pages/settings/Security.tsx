import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { q, useAction } from '@/api/hooks';
import type { Role, SessionEntry, UserInfo } from '@/api/types';
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, ConfirmDialog, DataTable, ErrorState, Field, Input, LoadingState, Modal, Notice, Select, type Column } from '@/components/ui';
import { dateTime, relativeTime } from '@/lib/format';
import { useAuth } from '@/state/auth';

export function PasswordCard() {
  const { refresh } = useAuth();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const change = useAction((b: { current: string; next: string }) => api.post('/auth/password', b), { success: 'Password changed. Other sessions were signed out.', quietError: true, invalidate: ['sessions'] });
  const mismatch = again.length > 0 && next !== again;
  return (
    <Card>
      <CardHeader title="Change password" description="Changing it signs out every other session." />
      <CardBody>
        <form
          className="max-w-md space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            change.mutateAsync({ current: cur, next }).then(
              () => {
                setCur('');
                setNext('');
                setAgain('');
                void refresh();
              },
              (err: unknown) => setError(err instanceof Error ? err.message : 'Could not change the password'),
            );
          }}
        >
          {error ? <Notice tone="critical">{error}</Notice> : null}
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
          </Field>
          <Field label="New password" hint="At least 12 characters.">
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Repeat new password" error={mismatch ? 'The passwords do not match.' : null}>
            <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={change.isPending} disabled={!cur || !next || next !== again}>
            Change password
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

export function SessionsCard() {
  const sessions = useQuery(q.sessions());
  const [all, setAll] = useState(false);
  const revoke = useAction((id: string) => api.del(`/auth/sessions/${id}`), { success: 'Session ended', invalidate: ['sessions'] });
  const logoutAll = useAction(() => api.post('/auth/logout-all', {}), { quietError: true });
  const { logout } = useAuth();
  const columns: Column<SessionEntry>[] = [
    { key: 'device', header: 'Device', cell: (s) => <span className="block max-w-72 truncate" title={s.userAgent ?? ''}>{s.userAgent ?? 'unknown'} {s.current ? <Badge tone="info">this session</Badge> : null}</span> },
    { key: 'ip', header: 'IP', hideOnSmall: true, cell: (s) => s.ip ?? '–' },
    { key: 'seen', header: 'Last active', cell: (s) => <span title={dateTime(s.lastSeenAt)}>{relativeTime(s.lastSeenAt)}</span> },
    { key: 'exp', header: 'Expires', hideOnSmall: true, cell: (s) => dateTime(s.expiresAt) },
    { key: 'a', header: '', align: 'right', cell: (s) => (s.current ? null : <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>Sign out</Button>) },
  ];
  return (
    <Card>
      <CardHeader title="Your sessions" actions={<Button size="sm" variant="danger" onClick={() => setAll(true)}>Sign out everywhere…</Button>} />
      {sessions.isLoading ? <LoadingState rows={2} /> : sessions.error ? <ErrorState error={sessions.error} /> : (
        <DataTable caption="Your sessions" rows={sessions.data?.sessions ?? []} rowKey={(s) => s.id} columns={columns} empty={{ title: 'No sessions' }} />
      )}
      {all ? <ConfirmDialog open onClose={() => setAll(false)} title="Sign out everywhere" target="all your sessions" confirmLabel="Sign out everywhere" impact="Every session of your account, including this one, is ended. You will need to sign in again." onConfirm={async () => { await logoutAll.mutateAsync(undefined); await logout(); }} /> : null}
    </Card>
  );
}

function UserForm({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState<{ username: string; password: string; role: Role; logsRead: boolean }>({ username: '', password: '', role: 'viewer', logsRead: false });
  const [error, setError] = useState<string | null>(null);
  const create = useAction((b: typeof f) => api.post('/users', b), { success: 'User created', invalidate: ['users'], quietError: true });
  const submit = async () => {
    setError(null);
    try {
      await create.mutateAsync(f);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the user');
    }
  };
  return (
    <Modal open onClose={onClose} title="Add user" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!f.username || !f.password} onClick={() => void submit()}>Create</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {error ? <Notice tone="critical">{error}</Notice> : null}
        <Field label="Username"><Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="off" /></Field>
        <Field label="Initial password"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        <Field label="Role" hint="Viewers can look but not change anything.">
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        {f.role === 'viewer' ? <Checkbox checked={f.logsRead} onChange={(v) => setF({ ...f, logsRead: v })} label="May read container logs (logs can contain secrets)" /> : null}
      </form>
    </Modal>
  );
}

export function UsersCard() {
  const { session } = useAuth();
  const users = useQuery(q.users());
  const [adding, setAdding] = useState(false);
  const [del, setDel] = useState<UserInfo | null>(null);
  const [pw, setPw] = useState<UserInfo | null>(null);
  const [newPw, setNewPw] = useState('');
  const patch = useAction((v: { id: number; body: Partial<Pick<UserInfo, 'role' | 'logsRead' | 'disabled'>> }) => api.patch(`/users/${v.id}`, v.body), { success: 'User updated', invalidate: ['users'] });
  const remove = useAction((id: number) => api.del(`/users/${id}`), { success: 'User deleted', invalidate: ['users'], quietError: true });
  const setPassword = useAction((v: { id: number; password: string }) => api.post(`/users/${v.id}/password`, { password: v.password }), { success: 'Password set', quietError: true });
  const me = session?.user.id;
  const columns: Column<UserInfo>[] = [
    { key: 'u', header: 'User', sort: (a, b) => a.username.localeCompare(b.username), cell: (u) => <span className="font-medium">{u.username}{u.id === me ? <span className="ml-2 text-xs text-muted">(you)</span> : null}</span> },
    { key: 'role', header: 'Role', cell: (u) => (
      <Select aria-label={`Role of ${u.username}`} value={u.role} disabled={u.id === me} onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value as Role } })} className="w-28">
        <option value="viewer">Viewer</option>
        <option value="admin">Admin</option>
      </Select>
    ) },
    { key: 'logs', header: 'Logs', hideOnSmall: true, cell: (u) => (u.role === 'admin' ? <span className="text-muted">always</span> : <Checkbox checked={u.logsRead} onChange={(v) => patch.mutate({ id: u.id, body: { logsRead: v } })} label={<span className="sr-only">Logs for {u.username}</span>} />) },
    { key: 'status', header: 'Status', cell: (u) => (u.disabled ? <Badge tone="inactive">disabled</Badge> : <Badge tone="healthy">active</Badge>) },
    { key: 'a', header: '', align: 'right', cell: (u) => (
      <span className="inline-flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => { setPw(u); setNewPw(''); }}>Set password</Button>
        <Button size="sm" variant="ghost" disabled={u.id === me} onClick={() => patch.mutate({ id: u.id, body: { disabled: !u.disabled } })}>{u.disabled ? 'Enable' : 'Disable'}</Button>
        <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${u.username}`} disabled={u.id === me} onClick={() => setDel(u)} />
      </span>
    ) },
  ];
  return (
    <Card>
      <CardHeader title="Users and roles" description="Admins can change things; viewers can only look." actions={<Button size="sm" icon="plus" variant="primary" onClick={() => setAdding(true)}>Add user</Button>} />
      {users.isLoading ? <LoadingState rows={2} /> : users.error ? <ErrorState error={users.error} /> : (
        <DataTable caption="Users" rows={users.data ?? []} rowKey={(u) => String(u.id)} columns={columns} empty={{ title: 'No users' }} />
      )}
      {adding ? <UserForm onClose={() => setAdding(false)} /> : null}
      {del ? <ConfirmDialog open onClose={() => setDel(null)} title="Delete user" target={del.username} requireText={del.username} confirmLabel="Delete user" impact="The account and all its sessions are removed immediately." onConfirm={() => remove.mutateAsync(del.id)} /> : null}
      {pw ? (
        <Modal open onClose={() => setPw(null)} title={`Set password for ${pw.username}`} footer={<><Button onClick={() => setPw(null)}>Cancel</Button><Button variant="primary" disabled={!newPw} onClick={() => void setPassword.mutateAsync({ id: pw.id, password: newPw }).then(() => setPw(null)).catch(() => undefined)}>Set password</Button></>}>
          <Field label="New password" hint="The user is signed out everywhere."><Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" /></Field>
        </Modal>
      ) : null}
    </Card>
  );
}
