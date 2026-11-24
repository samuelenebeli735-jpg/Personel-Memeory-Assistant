import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { SearchEntityType, TaskStatus } from "@recall/shared";
import { useToast } from "../hooks/useToast";
import { useTimeZone } from "../hooks/useTimeZone";
import {
  searchApi,
  type SearchResponse,
  type SearchResultItem,
  type SearchQuery,
} from "../lib/api";
import {
  formatRelative,
  localDateTimeToUtcIso,
} from "../lib/date";
import {
  Button,
  Input,
  Select,
  Card,
  Badge,
  EmptyState,
} from "../components/ui";
import { detailPath, type RecordDetailType } from "../lib/routes";
import { SearchIcon } from "../components/Layout";
import { describeError } from "../lib/errors";
import { ErrorState, PageHeader, Pagination } from "../components/patterns";
import { PAGE_SIZE, SEARCH_MAX_OFFSET, pageToOffset, parsePageParam } from "../lib/pagination";
import { resolveFetchedPage, withPage } from "../hooks/usePagedQuery";
import {
  canFilterByStatus,
  parseSearchStatus,
  parseSearchTypes,
  selectedSearchTypes,
  SEARCH_STATUS_OPTIONS,
  SEARCH_TYPE_OPTIONS,
} from "../lib/search-filters";

const SEARCH_DETAIL_TYPES: Record<SearchResultItem["type"], RecordDetailType> =
  {
    TASK: "task",
    NOTE: "note",
    IDEA: "idea",
    EVENT: "event",
    CAPTURE: "capture",
    PROJECT: "project",
    REMINDER: "reminder",
  };

function SearchResultRow({
  item,
  timeZone,
}: {
  item: SearchResultItem;
  timeZone: string;
}) {
  const typeLabels: Record<string, string> = {
    TASK: "Task",
    NOTE: "Note",
    IDEA: "Idea",
    EVENT: "Event",
    CAPTURE: "Capture",
    PROJECT: "Project",
    REMINDER: "Reminder",
  };

  return (
    <Link
      to={detailPath(SEARCH_DETAIL_TYPES[item.type], item.id)}
      className="list-item"
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <div className="list-item-content" style={{ minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginBottom: "4px",
          }}
        >
          <Badge variant="primary">{typeLabels[item.type] || item.type}</Badge>
          <div
            className="list-item-title"
            style={{
              textOverflow: "ellipsis",
              overflow: "hidden",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            {item.title}
          </div>
        </div>
        <div className="list-item-meta">
          {item.matchedOn.length > 0 && (
            <Badge variant="muted">matched: {item.matchedOn.join(", ")}</Badge>
          )}
          {item.snippet && (
            <span
              style={{ color: "var(--color-text-muted)", fontSize: "12px" }}
            >
              {item.snippet}
            </span>
          )}
          <span>{formatRelative(item.timestamp, timeZone)}</span>
          <span
            style={{
              fontFamily: "monospace",
              fontSize: "11px",
              color: "var(--color-text-muted)",
            }}
          >
            #{item.id.slice(0, 6)}
          </span>
        </div>
      </div>
    </Link>
  );
}

/** Reads the search criteria from the URL; null when there is nothing to search for. */
function criteriaFromUrl(params: URLSearchParams) {
  const q = params.get("q") ?? "";
  const types = parseSearchTypes(params.getAll("t"));
  const status = canFilterByStatus(types) ? parseSearchStatus(params.get("status")) : "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (!q.trim() && types.length === 0 && !from && !to) return null;
  return { q, types, status, from, to };
}

export function SearchPage() {
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [rerun, setRerun] = useState(0);
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [types, setTypes] = useState<SearchEntityType[]>(() =>
    parseSearchTypes(searchParams.getAll("t")),
  );
  const [status, setStatus] = useState<TaskStatus | "">(() => {
    const parsedStatus = parseSearchStatus(searchParams.get("status"));
    return canFilterByStatus(parseSearchTypes(searchParams.getAll("t")))
      ? parsedStatus
      : "";
  });
  const [from, setFrom] = useState(searchParams.get("from") || "");
  const [to, setTo] = useState(searchParams.get("to") || "");
  const [queryError, setQueryError] = useState("");
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusResults = useRef(false);

  const timeZone = useTimeZone().timeZone;
  const statusAvailable = canFilterByStatus(types);
  const page = parsePageParam(searchParams.get("page"));
  const urlKey = searchParams.toString();

  // The URL is the search (R2-05): refresh, Back and shared links run the
  // same search and show the same page. The form follows the URL.
  useEffect(() => {
    const criteria = criteriaFromUrl(searchParams);
    setQuery(criteria?.q ?? "");
    setTypes(criteria?.types ?? []);
    setStatus(criteria?.status ?? "");
    setFrom(criteria?.from ?? "");
    setTo(criteria?.to ?? "");
    if (!criteria) {
      setResults(null);
      setLoadState("idle");
      return undefined;
    }
    const fromResult = localDateTimeToUtcIso(criteria.from, timeZone);
    const toResult = localDateTimeToUtcIso(criteria.to, timeZone);
    const searchQuery: SearchQuery = {
      q: criteria.q,
      limit: PAGE_SIZE,
      // The API reads at most 10,000 rows deep.
      offset: Math.min(pageToOffset(page), SEARCH_MAX_OFFSET),
      sort: "relevance",
      order: "desc",
      includeDeleted: false,
    };
    if (criteria.types.length > 0) searchQuery.types = criteria.types;
    if (criteria.status) searchQuery.status = criteria.status;
    if (fromResult.ok && fromResult.value) searchQuery.from = fromResult.value;
    if (toResult.ok && toResult.value) searchQuery.to = toResult.value;

    let cancelled = false;
    setLoadState("loading");
    searchApi
      .searchGet(searchQuery)
      .then((data) => {
        if (cancelled) return;
        const decision = resolveFetchedPage(page, Math.min(data.total, SEARCH_MAX_OFFSET + PAGE_SIZE));
        if (!decision.show) {
          setSearchParams((prev) => withPage(prev, decision.redirectTo), { replace: true });
          return;
        }
        setResults(data);
        setLoadError(null);
        setLoadState("ready");
        if (focusResults.current) {
          focusResults.current = false;
          resultsHeadingRef.current?.focus();
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err);
        setLoadState("error");
        const described = describeError(err, "Search");
        showToast(described.retryAfter !== undefined ? "warning" : "error", "Search failed", described.message);
      });
    return () => {
      cancelled = true;
    };
    // urlKey stands for searchParams; rerun repeats an identical search.
  }, [urlKey, timeZone, rerun]);

  const handleSearch = (e: FormEvent) => {
    e.preventDefault();

    if (!query.trim() && types.length === 0 && !from && !to) {
      setQueryError("Enter a search query");
      return;
    }
    setQueryError("");

    const fromResult = localDateTimeToUtcIso(from, timeZone);
    if (!fromResult.ok) {
      showToast("error", "Invalid From date", fromResult.error);
      return;
    }
    const toResult = localDateTimeToUtcIso(to, timeZone);
    if (!toResult.ok) {
      showToast("error", "Invalid To date", toResult.error);
      return;
    }
    if (fromResult.value && toResult.value && fromResult.value > toResult.value) {
      showToast("error", "Invalid date range", "The From date must be before the To date.");
      return;
    }

    const effectiveStatus = statusAvailable ? status : "";
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (types.length > 0) types.forEach((t) => params.append("t", t));
    if (effectiveStatus) params.set("status", effectiveStatus);
    // Keep the wall-clock values in URL state so reloading reopens the same
    // datetime-local controls; only the API request uses UTC.
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    // A new search always starts on page 1.
    if (params.toString() === withPage(searchParams, 1).toString() && page === 1) setRerun((n) => n + 1);
    setSearchParams(params);
  };

  const reachableTotal = results ? Math.min(results.total, SEARCH_MAX_OFFSET + PAGE_SIZE) : 0;

  return (
    <div>
      <PageHeader title="Search" />

      <Card style={{ marginBottom: "24px" }}>
        <div className="card-content">
          <form
            onSubmit={handleSearch}
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            <Input
              label="Search"
              placeholder="Enter search terms..."
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (queryError) setQueryError("");
              }}
              error={queryError}
              style={{ flex: 1 }}
            />
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
              <Select
                label="Types"
                options={[
                  { value: "", label: "All types" },
                  ...SEARCH_TYPE_OPTIONS,
                ]}
                value={types}
                onChange={(e) => {
                  const nextTypes = selectedSearchTypes(
                    e.currentTarget.selectedOptions,
                  );
                  setTypes(nextTypes);
                  if (!canFilterByStatus(nextTypes)) setStatus("");
                }}
                multiple
              />
              <Select
                label="Task status"
                options={[
                  { value: "", label: "All task statuses" },
                  ...SEARCH_STATUS_OPTIONS,
                ]}
                value={status}
                onChange={(e) => setStatus(parseSearchStatus(e.target.value))}
                disabled={!statusAvailable}
                hint={
                  statusAvailable
                    ? "Status applies to tasks and narrows the search to tasks."
                    : "Status is only available for tasks. Add Tasks to the type filter."
                }
              />
              <Input
                label="From"
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                hint={`Time zone: ${timeZone}`}
              />
              <Input
                label="To"
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <Button type="submit" size="lg" loading={loadState === "loading"}>
              <SearchIcon style={{ marginRight: "8px" }} /> Search
            </Button>
          </form>
        </div>
      </Card>

      {loadState === "error" && !results && (
        <ErrorState
          title="Couldn’t search"
          message={describeError(loadError, "Search").message}
          code={describeError(loadError, "Search").code}
          onRetry={() => setRerun((n) => n + 1)}
        />
      )}

      {results && (
        <Card>
          <div className="card-header">
            <h2 className="card-title" ref={resultsHeadingRef} tabIndex={-1}>
              Results ({results.total})
            </h2>
          </div>
          <div className="card-content" style={{ padding: 0 }}>
            {results.items.length === 0 ? (
              <EmptyState
                icon={<SearchIcon />}
                title="No results found"
                text="Try adjusting your search terms or filters."
              />
            ) : (
              <div
                className="list"
                aria-busy={loadState === "loading"}
                style={{ borderTop: "1px solid var(--color-border)" }}
              >
                {results.items.map((item) => (
                  <SearchResultRow
                    key={`${item.type}:${item.id}`}
                    item={item}
                    timeZone={timeZone}
                  />
                ))}
              </div>
            )}
          </div>
          <div style={{ padding: "0 16px 12px" }}>
            <Pagination
              page={page}
              total={reachableTotal}
              pageSize={PAGE_SIZE}
              onPageChange={(next) => {
                focusResults.current = true;
                setSearchParams((prev) => withPage(prev, next));
              }}
            />
            {results.total > reachableTotal && (
              <p className="page-header-sub">
                Showing the first {reachableTotal.toLocaleString()} results. Narrow the search to see the rest.
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
