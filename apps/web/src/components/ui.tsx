import { forwardRef, type ReactNode } from 'react'

export const Button = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg' | 'icon'
  loading?: boolean
}>(
  ({ className = '', variant = 'primary', size = 'md', loading = false, disabled, children, ...props }, ref) => {
    const classNames = [
      'btn',
      `btn-${variant}`,
      size !== 'md' ? `btn-${size}` : '',
      loading ? 'loading' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <button
        ref={ref}
        className={classNames}
        disabled={disabled || loading}
        {...props}
      >
        {loading && <span className="loading-spinner" aria-hidden="true" />}
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string
  error?: string
  hint?: string
}>(
  ({ className = '', label, error, hint, id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-')

    return (
      <div className="form-group">
        {label && <label htmlFor={inputId} className="form-label">{label}</label>}
        <input
          ref={ref}
          id={inputId}
          className={className}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          {...props}
        />
        {error && <div id={`${inputId}-error`} className="form-error" role="alert">{error}</div>}
        {hint && !error && <div id={`${inputId}-hint`} className="form-hint">{hint}</div>}
      </div>
    )
  }
)

Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string
  error?: string
  hint?: string
}>(
  ({ className = '', label, error, hint, id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-')

    return (
      <div className="form-group">
        {label && <label htmlFor={inputId} className="form-label">{label}</label>}
        <textarea
          ref={ref}
          id={inputId}
          className={`form-textarea ${className}`}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          {...props}
        />
        {error && <div id={`${inputId}-error`} className="form-error" role="alert">{error}</div>}
        {hint && !error && <div id={`${inputId}-hint`} className="form-hint">{hint}</div>}
      </div>
    )
  }
)

Textarea.displayName = 'Textarea'

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string
  error?: string
  hint?: string
  options: { value: string; label: string }[]
}>(
  ({ className = '', label, error, hint, options, id, ...props }, ref) => {
    const selectId = id || label?.toLowerCase().replace(/\s+/g, '-')

    return (
      <div className="form-group">
        {label && <label htmlFor={selectId} className="form-label">{label}</label>}
        <select
          ref={ref}
          id={selectId}
          className={`form-select ${className}`}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
          {...props}
        >
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {error && <div id={`${selectId}-error`} className="form-error" role="alert">{error}</div>}
        {hint && !error && <div id={`${selectId}-hint`} className="form-hint">{hint}</div>}
      </div>
    )
  }
)

Select.displayName = 'Select'

export const Card = ({ children, className = '', header, style }: { children: ReactNode; className?: string; header?: ReactNode; style?: React.CSSProperties }) => (
  <div className={`card ${className}`} style={style}>
    {header && (
      <div className="card-header">
        {header}
      </div>
    )}
    <div className="card-content">{children}</div>
  </div>
)

export const Badge = ({
  children,
  variant = 'primary',
  className = '',
  style,
}: { children: ReactNode; variant?: 'primary' | 'success' | 'warning' | 'danger' | 'muted'; className?: string; style?: React.CSSProperties }) => (
  <span className={`badge badge-${variant} ${className}`} style={style}>{children}</span>
)

export const EmptyState = ({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode
  title: string
  text: string
  action?: ReactNode
}) => (
  <div className="empty-state">
    <div className="empty-state-icon" aria-hidden="true">{icon}</div>
    <div className="empty-state-title">{title}</div>
    <div className="empty-state-text">{text}</div>
    {action && <div>{action}</div>}
  </div>
)

export const Modal = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
}: {
  isOpen: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}) => {
  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id="modal-title" className="modal-title">{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}