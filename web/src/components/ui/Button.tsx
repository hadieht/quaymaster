import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './Icon';
import { Spinner } from './states';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90 border-transparent',
  secondary: 'bg-surface text-fg border-border hover:bg-surface-2',
  danger: 'bg-critical text-white border-transparent hover:opacity-90 dark:text-bg',
  ghost: 'bg-transparent text-fg border-transparent hover:bg-surface-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
  loading?: boolean;
  /** When set, the button is disabled and this explains why (tooltip + screen-reader text). */
  disabledReason?: string | null;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, disabledReason, className, children, disabled, title, ...rest },
  ref,
) {
  const isDisabled = Boolean(disabled || loading || disabledReason);
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      disabled={isDisabled}
      title={disabledReason ?? title}
      aria-describedby={undefined}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Spinner className="h-3.5 w-3.5" /> : icon ? <Icon name={icon} className="h-4 w-4" /> : null}
      {children}
      {disabledReason ? <span className="sr-only"> (unavailable: {disabledReason})</span> : null}
    </button>
  );
});

export function IconButton({
  icon,
  label,
  className,
  ...rest
}: { icon: IconName; label: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50',
        className,
      )}
    >
      <Icon name={icon} className="h-5 w-5" />
    </button>
  );
}
