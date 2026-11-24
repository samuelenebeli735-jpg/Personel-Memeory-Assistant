import { useState, type FormEvent } from "react";
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

export function SearchPage() {
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
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

  const timeZone = useTimeZone().timeZone;
  const statusAvailable = canFilterByStatus(types);

  const handleSearch = async (e: FormEvent) => {
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
    if (
      fromResult.value &&
      toResult.value &&
      fromResult.value > toResult.value
    ) {
      showToast(
        "error",
        "Invalid date range",
        "The From date must be before the To date.",
      );
      return;
    }

    const effectiveStatus = statusAvailable ? status : "";
    const searchQuery: SearchQuery = {
      q: query,
      limit: 50,
      offset: 0,
      sort: "relevance",
      order: "desc",
      includeDeleted: false,
    };
    if (types.length > 0) searchQuery.types = types;
    if (effectiveStatus) searchQuery.status = effectiveStatus;
    if (fromResult.value) searchQuery.from = fromResult.value;
    if (toResult.value) searchQuery.to = toResult.value;

    setIsLoading(true);
    try {
      const data = await searchApi.searchGet(searchQuery);
      setResults(data);
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (types.length > 0) types.forEach((t) => params.append("t", t));
      if (effectiveStatus) params.set("status", effectiveStatus);
      // Keep the wall-clock values in URL state so reloading reopens the same
      // datetime-local controls; only the API request uses UTC.
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      setSearchParams(params);
    } catch (err) {
      const described = describeError(err, "Search");
      showToast(described.retryAfter !== undefined ? "warning" : "error", "Search failed", described.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "24px",
        }}
      >
        <h1 style={{ fontSize: "24px", fontWeight: "600", margin: 0 }}>
          Search
        </h1>
      </div>

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
              />
              <Input
                label="To"
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <Button type="submit" size="lg" loading={isLoading}>
              <SearchIcon style={{ marginRight: "8px" }} /> Search
            </Button>
          </form>
        </div>
      </Card>

      {results && (
        <Card>
          <div className="card-header">
            <h2 className="card-title">Results ({results.total})</h2>
          </div>
          <div className="card-content" style={{ padding: 0 }}>
            {isLoading ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "32px",
                }}
              >
                <div className="loading-spinner" aria-hidden="true" />
              </div>
            ) : results.items.length === 0 ? (
              <EmptyState
                icon={<SearchIcon />}
                title="No results found"
                text="Try adjusting your search terms or filters."
              />
            ) : (
              <div
                className="list"
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
        </Card>
      )}
    </div>
  );
}
