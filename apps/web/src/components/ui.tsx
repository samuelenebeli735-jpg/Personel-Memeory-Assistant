import { forwardRef, type ReactNode } from "react";
import { Dialog } from "./Dialog";

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "ghost" | "danger";
    size?: "sm" | "md" | "lg" | "icon";
    loading?: boolean;
  }
>(
  (
    {
      className = "",
      variant = "primary",
      size = "md",
      loading = false,
      disabled,
      children,
      onClick,
      ...props
    },
    ref,
  ) => {
    const classNames = [
      "btn",
      `btn-${variant}`,
      size !== "md" ? `btn-${size}` : "",
      loading ? "loading" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        className={classNames}
        disabled={disabled}
        aria-disabled={loading || undefined}
        aria-busy={loading || undefined}
        onClick={(event) => {
          // While busy the button keeps focus but ignores clicks (and, for a
          // submit button, the form submission).
          if (loading) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        }}
        {...props}
      >
        {loading && <span className="loading-spinner" aria-hidden="true" />}
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";

export const Input = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & {
    label?: string;
    error?: string;
    hint?: string;
  }
>(({ className = "", label, error, hint, id, ...props }, ref) => {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");

  return (
    <div className="form-group">
      {label && (
        <label htmlFor={inputId} className="form-label">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={className}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined
        }
        {...props}
      />
      {error && (
        <div id={`${inputId}-error`} className="form-error" role="alert">
          {error}
        </div>
      )}
      {hint && !error && (
        <div id={`${inputId}-hint`} className="form-hint">
          {hint}
        </div>
      )}
    </div>
  );
});

Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    label?: string;
    error?: string;
    hint?: string;
  }
>(({ className = "", label, error, hint, id, ...props }, ref) => {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");

  return (
    <div className="form-group">
      {label && (
        <label htmlFor={inputId} className="form-label">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={inputId}
        className={`form-textarea ${className}`}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined
        }
        {...props}
      />
      {error && (
        <div id={`${inputId}-error`} className="form-error" role="alert">
          {error}
        </div>
      )}
      {hint && !error && (
        <div id={`${inputId}-hint`} className="form-hint">
          {hint}
        </div>
      )}
    </div>
  );
});

Textarea.displayName = "Textarea";

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & {
    label?: string;
    error?: string;
    hint?: string;
    options: { value: string; label: string }[];
  }
>(({ className = "", label, error, hint, options, id, ...props }, ref) => {
  const selectId = id || label?.toLowerCase().replace(/\s+/g, "-");

  return (
    <div className="form-group">
      {label && (
        <label htmlFor={selectId} className="form-label">
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={selectId}
        className={`form-select ${className}`}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined
        }
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && (
        <div id={`${selectId}-error`} className="form-error" role="alert">
          {error}
        </div>
      )}
      {hint && !error && (
        <div id={`${selectId}-hint`} className="form-hint">
          {hint}
        </div>
      )}
    </div>
  );
});

Select.displayName = "Select";

export const Card = ({
  children,
  className = "",
  header,
  style,
}: {
  children: ReactNode;
  className?: string;
  header?: ReactNode;
  style?: React.CSSProperties;
}) => (
  <div className={`card ${className}`} style={style}>
    {header && <div className="card-header">{header}</div>}
    <div className="card-content">{children}</div>
  </div>
);

export const Badge = ({
  children,
  variant = "primary",
  className = "",
  style,
}: {
  children: ReactNode;
  variant?: "primary" | "success" | "warning" | "danger" | "muted";
  className?: string;
  style?: React.CSSProperties;
}) => (
  <span className={`badge badge-${variant} ${className}`} style={style}>
    {children}
  </span>
);

export const EmptyState = ({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) => (
    <div className="empty-state">
    <div className="empty-state-icon" aria-hidden="true">
      {icon}
    </div>
    <h2 className="empty-state-title">{title}</h2>
    <div className="empty-state-text">{text}</div>
    {action && <div>{action}</div>}
  </div>
);

/**
 * Kept for existing callers; built on the shared Dialog so focus, Escape,
 * stacking and focus return behave the same everywhere.
 */
export const Modal = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) => (
  <Dialog open={isOpen} title={title} onRequestClose={onClose}>
    <div className="modal-body">{children}</div>
    {footer && <div className="modal-footer">{footer}</div>}
  </Dialog>
);
