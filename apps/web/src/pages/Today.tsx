/**
 * Today (R2-02): the briefing for one day in the Settings zone.
 *
 * Previous / next day and a date picker move through days in `?date=`; an
 * invalid date falls back to today with a notice. Sections appear in the
 * order configured in Settings, empty ones say so, and every item links to its
 * record. The "now" marker is drawn only on today.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { briefingApi } from '../lib/api'
import type { BriefingItemDto, BriefingResponseDto } from '../types/api'
import { useTimeZone } from '../hooks/useTimeZone'
import { localDateKey } from '../lib/date'
import { detailPath, type RecordDetailType } from '../lib/routes'
import {
  addDays,
  clockTime,
  daysOverdue,
  EMPTY_SECTION_TEXT,
  isValidDateKey,
  longDateLabel,
  nowMarkerIndex,
  shortDayLabel,
  timeColumnLabel,
} from '../lib/briefing'
import { describeError } from '../lib/errors'
import { Button } from '../components/ui'
import { ErrorState, LoadingState, PageHeader } from '../components/patterns'

const DETAIL_TYPES: Record<BriefingItemDto['type'], RecordDetailType> = {
  TASK: 'task',
  NOTE: 'note',
  IDEA: 'idea',
  EVENT: 'event',
  REMINDER: 'reminder',
  CAPTURE: 'capture',
  PROJECT: 'project',
}

export function TodayPage() {
  const { timeZone } = useTimeZone()
  const [params, setParams] = useSearchParams()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const requested = params.get('date')
  const todayKey = localDateKey(new Date(), timeZone)
  const invalidDate = requested !== null && !isValidDateKey(requested)
  const dateKey = requested && !invalidDate ? requested : todayKey
  const isToday = dateKey === todayKey

  const [data, setData] = useState<BriefingResponseDto | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<unknown>(null)
  const [reload, setReload] = useState(0)
  const moved = useRef(false)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    briefingApi
      .get(isToday ? undefined : dateKey)
      .then((result) => {
        if (cancelled) return
        setData(result)
        setStatus('ready')
        if (moved.current) {
          moved.current = false
          headingRef.current?.focus()
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err)
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [dateKey, isToday, reload])

  const goTo = (key: string) => {
    moved.current = true
    const next = new URLSearchParams(params)
    if (key === todayKey) next.delete('date')
    else next.set('date', key)
    setParams(next)
  }

  const briefing = data?.briefing
  const zone = briefing?.timeZone ?? timeZone
  const nowMs = Date.now()

  return (
    <div>
      <PageHeader
        ref={headingRef}
        title={longDateLabel(dateKey, todayKey)}
        sub={
          briefing
            ? `${zone} · ${briefing.itemCount} item${briefing.itemCount === 1 ? '' : 's'} in ${briefing.sections.length} section${briefing.sections.length === 1 ? '' : 's'}${isToday ? ` · now ${clockTime(new Date(nowMs).toISOString(), zone)}` : ''}`
            : zone
        }
        actions={
          <div className="today-nav">
            <Button variant="secondary" size="sm" onClick={() => goTo(addDays(dateKey, -1))}>
              <span aria-hidden="true">← </span>
              {shortDayLabel(addDays(dateKey, -1))}
              <span className="sr-only">, previous day, {longDateLabel(addDays(dateKey, -1), todayKey)}</span>
            </Button>
            <input
              id="today-date"
              type="date"
              aria-label="Pick a date"
              className="today-date"
              value={dateKey}
              onChange={(event) => {
                if (isValidDateKey(event.target.value)) goTo(event.target.value)
              }}
            />
            {!isToday && (
              <Button variant="secondary" size="sm" onClick={() => goTo(todayKey)}>
                Today
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => goTo(addDays(dateKey, 1))}>
              {shortDayLabel(addDays(dateKey, 1))}
              <span className="sr-only">, next day, {longDateLabel(addDays(dateKey, 1), todayKey)}</span>
              <span aria-hidden="true"> →</span>
            </Button>
          </div>
        }
      />

      {invalidDate && (
        <div className="offline-banner" role="status">
          “{requested}” isn’t a date Recall can read, so this is today.
        </div>
      )}

      {status === 'error' && (
        <ErrorState
          title="Couldn’t load the briefing"
          message={describeError(error, 'Loading the briefing').message}
          code={describeError(error, 'Loading the briefing').code}
          onRetry={() => setReload((n) => n + 1)}
        />
      )}
      {status === 'loading' && !briefing && <LoadingState label="Loading the briefing…" />}

      {briefing && status !== 'error' && (
        <div aria-busy={status === 'loading'}>
          {briefing.sections.map((section) => {
            const showNow = isToday && section.id === 'today'
            const marker = showNow ? nowMarkerIndex(section.items.map((i) => i.timestamp), nowMs) : -1
            return (
              <section key={section.id} aria-labelledby={`section-${section.id}`}>
                <h2 className="section-title" id={`section-${section.id}`}>
                  {section.title}
                </h2>
                {section.items.length === 0 && !showNow ? (
                  <p className="page-header-sub">{EMPTY_SECTION_TEXT[section.id] ?? 'Nothing here.'}</p>
                ) : (
                  <ol className="rail">
                    {section.items.map((item, index) => (
                      <RailItem
                        key={`${item.type}-${item.id}`}
                        item={item}
                        sectionId={section.id}
                        dayKey={dateKey}
                        todayKey={todayKey}
                        zone={zone}
                        past={showNow && index < marker}
                        nowBefore={showNow && index === marker}
                        nowMs={nowMs}
                      />
                    ))}
                    {showNow && marker === section.items.length && <NowMarker nowMs={nowMs} zone={zone} />}
                  </ol>
                )}
                {section.items.length === 0 && showNow && (
                  <p className="page-header-sub">{EMPTY_SECTION_TEXT.today}</p>
                )}
              </section>
            )
          })}
          <p className="page-header-sub" style={{ marginTop: 16 }}>
            Sections and their order come from <Link to="/settings">Settings → Briefing</Link>.
          </p>
        </div>
      )}
    </div>
  )
}

function NowMarker({ nowMs, zone }: { nowMs: number; zone: string }) {
  return (
    <li className="rail-row rail-now">
      <span className="time-col now">{clockTime(new Date(nowMs).toISOString(), zone)}</span>
      <span className="rail-item">
        <span className="kind-label rail-now-label">Now</span>
      </span>
    </li>
  )
}

function RailItem({
  item,
  sectionId,
  dayKey,
  todayKey,
  zone,
  past,
  nowBefore,
  nowMs,
}: {
  item: BriefingItemDto
  sectionId: string
  dayKey: string
  todayKey: string
  zone: string
  past: boolean
  nowBefore: boolean
  nowMs: number
}) {
  const overdueDays = sectionId === 'overdue' ? daysOverdue(item.timestamp, todayKey, zone) : 0
  const kind = item.type.charAt(0) + item.type.slice(1).toLowerCase()
  return (
    <>
      {nowBefore && <NowMarker nowMs={nowMs} zone={zone} />}
      <li className={`rail-row${past ? ' past' : ''}`}>
        <span className="time-col">{timeColumnLabel(item.timestamp, dayKey, zone)}</span>
        <span className="rail-item">
          <span className="kind-label">
            {kind}
            {past ? ' · earlier today' : ''}
          </span>
          <Link to={detailPath(DETAIL_TYPES[item.type], item.id)} className="rail-title">
            {item.title}
          </Link>
          {overdueDays > 0 && (
            <span className="chip chip-bad">
              {overdueDays} day{overdueDays === 1 ? '' : 's'} overdue
            </span>
          )}
          {sectionId === 'today' && item.type === 'TASK' && <span className="chip chip-warn">Due today</span>}
        </span>
      </li>
    </>
  )
}
