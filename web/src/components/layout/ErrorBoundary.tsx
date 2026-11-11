import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Card } from '@/components/ui';
import { Icon } from '@/components/ui/Icon';

interface Props {
  children: ReactNode;
  /** `page` shows a compact in-layout card; `root` is the full-screen last resort. */
  level?: 'page' | 'root';
}

/** Catches render errors so one broken view never blanks the whole app. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI error:', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const card = (
      <Card className="mx-auto max-w-lg p-8 text-center" >
        <div role="alert" className="flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-critical/10 text-critical">
            <Icon name="alert" className="h-6 w-6" />
          </div>
          <h1 className="text-lg font-semibold">This view crashed</h1>
          <p className="break-words text-sm text-muted">{this.state.error.message}</p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button onClick={() => window.location.assign('/')}>Go to dashboard</Button>
          </div>
        </div>
      </Card>
    );
    return this.props.level === 'root' ? <div className="flex h-full items-center justify-center p-4">{card}</div> : card;
  }
}
