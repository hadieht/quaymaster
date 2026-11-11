import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, onUnauthorized, setCsrfToken } from '@/api/client';
import { q } from '@/api/hooks';
import type { AuthStatus, ModeInfo, SessionInfo } from '@/api/types';

type Phase = 'loading' | 'setup' | 'login' | 'ready' | 'error';

interface AuthState {
  phase: Phase;
  session: SessionInfo | null;
  error: unknown;
  /** Logged-in user may change things (admin role). */
  isAdmin: boolean;
  /** Container logs are readable by this user. */
  canReadLogs: boolean;
  login: (username: string, password: string) => Promise<void>;
  setup: (token: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
  /** After a password change the other sessions are gone but this one stays. */
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<unknown>(null);

  const adopt = useCallback((s: SessionInfo) => {
    setCsrfToken(s.csrfToken);
    setSession(s);
    setPhase('ready');
  }, []);

  const bootstrap = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const st = await api.get<AuthStatus>('/auth/status');
      if (st.setupRequired) return setPhase('setup');
      if (!st.authenticated) return setPhase('login');
      adopt(await api.get<SessionInfo>('/auth/me'));
    } catch (e) {
      setError(e);
      setPhase('error');
    }
  }, [adopt]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 401 anywhere → back to the login page, with all cached data dropped.
  useEffect(() => {
    onUnauthorized(() => {
      setSession(null);
      setCsrfToken(null);
      qc.clear();
      setPhase((p) => (p === 'ready' ? 'login' : p));
    });
    return () => onUnauthorized(null);
  }, [qc]);

  const value = useMemo<AuthState>(
    () => ({
      phase,
      session,
      error,
      isAdmin: session?.user.role === 'admin',
      canReadLogs: session ? session.user.role === 'admin' || session.user.logsRead : false,
      login: async (username, password) => {
        adopt(await api.post<SessionInfo>('/auth/login', { username, password }));
      },
      setup: async (token, username, password) => {
        adopt(await api.post<SessionInfo>('/auth/setup', { token, username, password }));
      },
      logout: async () => {
        try {
          await api.post('/auth/logout');
        } finally {
          setSession(null);
          setCsrfToken(null);
          qc.clear();
          setPhase('login');
        }
      },
      retry: () => void bootstrap(),
      refresh: async () => adopt(await api.get<SessionInfo>('/auth/me')),
    }),
    [phase, session, error, adopt, bootstrap, qc],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used inside <AuthProvider>');
  return c;
}

export function useMode(): { mode: ModeInfo | undefined; isLoading: boolean } {
  const { data, isLoading } = useQuery(q.mode());
  return { mode: data, isLoading };
}

export interface GateInput {
  /** The object's own `mutable` flag (server-computed: scope + protection + read-only). */
  mutable?: boolean;
  protectedReason?: string | null;
  /** Capability levels that are NOT enough for this action. */
  needsFull?: boolean;
  level?: 'full' | 'limited' | 'standalone';
}

/**
 * Single place deciding whether a state-changing control is available. Returns the reason it is
 * not, in plain words (shown as the disabled-button tooltip), or null when allowed.
 */
export function useGate(): (g?: GateInput) => string | null {
  const { isAdmin } = useAuth();
  const { mode } = useMode();
  return useCallback(
    (g = {}) => {
      if (!isAdmin) return 'Your account has the viewer role: it can look but not change anything.';
      if (mode?.readOnly) return mode.readOnlyReason ?? 'Quaymaster is in read-only mode.';
      if (g.protectedReason) return g.protectedReason;
      if (g.mutable === false)
        return 'This resource is outside the managed scope of this Quaymaster instance.';
      if (g.needsFull && g.level && g.level !== 'full') {
        return g.level === 'limited'
          ? 'Limited control: the Compose files are not trusted or readable, so this action is unavailable.'
          : 'Standalone container: this action needs a Compose project.';
      }
      return null;
    },
    [isAdmin, mode],
  );
}
