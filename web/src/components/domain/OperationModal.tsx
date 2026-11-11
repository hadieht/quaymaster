import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useInvalidateDocker } from '@/api/hooks';
import { openStream } from '@/api/stream';
import type { OperationInfo } from '@/api/types';
import { Badge, Button, Modal, Notice, Spinner } from '@/components/ui';

/** Live output of a long operation (Compose action, image pull) from `/stream/operations/:id`. */
export function OperationModal({
  operationId,
  title,
  onClose,
}: {
  operationId: string | null;
  title: string;
  onClose: () => void;
}) {
  const invalidate = useInvalidateDocker();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'running' | 'succeeded' | 'failed'>('running');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLPreElement>(null);

  // output is polled from the stored operation (the SSE stream only adds the instant final status)
  const snap = useQuery({
    queryKey: ['operation', operationId],
    queryFn: () => api.get<OperationInfo>(`/operations/${operationId}`),
    enabled: !!operationId,
    refetchInterval: status === 'running' ? 1500 : false,
  });

  useEffect(() => {
    if (!snap.data) return;
    setText(snap.data.output);
    setStatus(snap.data.status);
    setError(snap.data.error);
  }, [snap.data]);

  useEffect(() => {
    if (!operationId) return;
    setText('');
    setStatus('running');
    setError(null);
    return openStream(`/operations/${operationId}`, {
      events: {
        status: (d) => {
          const s = d as { status: 'running' | 'succeeded' | 'failed'; error: string | null };
          setStatus(s.status);
          setError(s.error);
          if (s.status !== 'running') invalidate();
        },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operationId]);

  useEffect(() => {
    if (status !== 'running') void snap.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);

  if (!operationId) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="lg"
      description={
        <span className="inline-flex items-center gap-2">
          {status === 'running' ? <Spinner className="h-4 w-4" /> : null}
          <Badge tone={status === 'succeeded' ? 'healthy' : status === 'failed' ? 'critical' : 'info'}>
            {status}
          </Badge>
        </span>
      }
      footer={<Button onClick={onClose}>{status === 'running' ? 'Hide (keeps running)' : 'Close'}</Button>}
    >
      <pre
        ref={box}
        aria-label="Operation output"
        className="qm-scroll h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-2 p-3 font-mono text-xs leading-5"
      >
        {text || (status === 'running' ? 'Waiting for output…' : 'No output.')}
      </pre>
      {error ? (
        <Notice tone="critical" title="The operation failed" className="mt-3">
          {error}
        </Notice>
      ) : null}
    </Modal>
  );
}
