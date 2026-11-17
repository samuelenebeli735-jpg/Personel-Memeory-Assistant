/**
 * Shared detail-page shell and presentation primitives.
 *
 * Error states deliberately show a generic message: a failed request must not
 * echo record content, provider text or server details into the page.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import { Button, Card, EmptyState } from "./ui";
import { CaptureIcon } from "./Layout";

export type DetailErrorKind = "unauthorized" | "not-found" | "unavailable";

export interface DetailErrorDescription {
  kind: DetailErrorKind;
  title: string;
  message: string;
}

const DEFAULT_NOT_FOUND_MESSAGE =
  "The record you are looking for does not exist.";

const NOT_FOUND_MESSAGES: Record<string, string> = {
  capture: "The capture you are looking for does not exist.",
  task: "The task you are looking for does not exist.",
  reminder: "The reminder you are looking for does not exist.",
  note: "The note you are looking for does not exist.",
  idea: "The idea you are looking for does not exist.",
  event: "The event you are looking for does not exist.",
  project: "The project you are looking for does not exist.",
};

function notFoundMessageFor(recordType?: string): string {
  if (!recordType) {
    return DEFAULT_NOT_FOUND_MESSAGE;
  }
  return NOT_FOUND_MESSAGES[recordType] ?? DEFAULT_NOT_FOUND_MESSAGE;
}

export function describeDetailError(
  error: unknown,
  recordType?: string,
): DetailErrorDescription {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        kind: "unauthorized",
        title: "Sign in required",
        message:
          "Your session is no longer valid. Sign in again to view this record.",
      };
    }
    if (error.status === 404) {
      return {
        kind: "not-found",
        title: "Not Found",
        message: notFoundMessageFor(recordType),
      };
    }
  }
  return {
    kind: "unavailable",
    title: "Unable to load record",
    message: "The record could not be loaded. Try again or return to the list.",
  };
}

export function useRecordDetail<T>(loader: (id: string) => Promise<T>) {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    if (!id) {
      setError(new ApiError("Record not found", "NOT_FOUND", 404));
      setLoadedId(null);
      setIsLoading(false);
      return () => {
        active = false;
      };
    }

    setIsLoading(true);
    setError(null);
    setData(null);
    setLoadedId(null);
    loader(id)
      .then((record) => {
        if (active) {
          setData(record);
          setLoadedId(id);
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError);
          setLoadedId(id);
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [id, loader]);

  const isCurrent = loadedId === (id ?? null);
  return {
    data: isCurrent ? data : null,
    error: isCurrent ? error : null,
    isLoading: isLoading || !isCurrent,
  };
}

export function DetailPageShell({
  backTo,
  backLabel,
  isLoading,
  error,
  children,
  recordType,
}: {
  backTo: string;
  backLabel: string;
  isLoading: boolean;
  error: unknown;
  children: ReactNode;
  recordType?: string;
}) {
  if (isLoading) {
    return (
      <div>
        <BackLink to={backTo} label={backLabel} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "320px",
          }}
        >
          <div
            className="loading-spinner"
            style={{ width: 32, height: 32 }}
            aria-hidden="true"
          />
        </div>
      </div>
    );
  }

  if (error) {
    const described = describeDetailError(error, recordType);
    return (
      <div>
        <BackLink to={backTo} label={backLabel} />
        <Card>
          <EmptyState
            icon={<CaptureIcon />}
            title={described.title}
            text={described.message}
            action={
              described.kind === "unauthorized" ? (
                <Link to="/login">
                  <Button variant="primary">Sign in</Button>
                </Link>
              ) : (
                <Link to={backTo}>
                  <Button variant="secondary">Back to {backLabel}</Button>
                </Link>
              )
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <BackLink to={backTo} label={backLabel} />
      {children}
    </div>
  );
}

function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="detail-back">
      ← {label}
    </Link>
  );
}

export function DetailField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="detail-field-label">{label}</div>
      <div className="detail-field-value">{children}</div>
    </div>
  );
}

export function DetailText({ children }: { children: ReactNode }) {
  return <div className="detail-text">{children}</div>;
}

export function DetailTags({ tags }: { tags: { id: string; name: string }[] }) {
  if (tags.length === 0) return <span className="detail-muted">None</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
      {tags.map((tag) => (
        <span key={tag.id} className="badge badge-muted">
          {tag.name}
        </span>
      ))}
    </div>
  );
}
