/**
 * Ask (R2-01, refinement 7).
 *
 * The question travels only in the request body: it is never put in the URL
 * and the dashboard does not store it. The answer is plain text. Sources are
 * exactly the records the API returned as supporting the answer, numbered and
 * linked; the UI never adds its own and shows no inline citation marks (the
 * API has no sentence-to-source mapping). A period answer shows the period and
 * zone exactly as returned.
 */
import { useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { askApi, type AskResponse, type SearchResultItem } from '../lib/api'
import { useTimeZone } from '../hooks/useTimeZone'
import { useOnline } from '../hooks/useOnline'
import { describeError } from '../lib/errors'
import { formatLocalDateTime } from '../lib/date'
import { detailPath, type RecordDetailType } from '../lib/routes'
import { Button, Card } from '../components/ui'
import { PageHeader } from '../components/patterns'

const EXAMPLES = ['What do I have tomorrow?', 'What did I note about the boiler?', 'What is overdue?']

const DETAIL_TYPES: Record<SearchResultItem['type'], RecordDetailType> = {
  TASK: 'task',
  NOTE: 'note',
  IDEA: 'idea',
  EVENT: 'event',
  CAPTURE: 'capture',
  PROJECT: 'project',
  REMINDER: 'reminder',
}

type AskState =
  | { status: 'idle' }
  | { status: 'asking' }
  | { status: 'answered'; question: string; result: AskResponse }
  | { status: 'error'; message: string; code?: string }

export function AskPage() {
  const { timeZone } = useTimeZone()
  const { online } = useOnline()
  const [question, setQuestion] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [state, setState] = useState<AskState>({ status: 'idle' })
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const ask = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) {
      setFieldError('Type a question first.')
      inputRef.current?.focus()
      return
    }
    setFieldError('')
    setState({ status: 'asking' })
    try {
      const result = await askApi.ask(trimmed)
      setState({ status: 'answered', question: trimmed, result })
    } catch (error) {
      const described = describeError(error, 'Asking')
      setState({ status: 'error', message: `${described.message} Your question is still in the box.`, code: described.code })
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (state.status === 'asking' || !online) return
    void ask(question)
  }

  return (
    <div>
      <PageHeader title="Ask" sub="Answers come only from your records. Questions are not saved." />

      <Card style={{ marginBottom: 16 }}>
        <div className="card-content">
          <form onSubmit={submit} noValidate className="ask-form">
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="ask-question" className="form-label">
                Your question
              </label>
              <textarea
                id="ask-question"
                ref={inputRef}
                className="form-textarea"
                rows={2}
                maxLength={500}
                value={question}
                aria-invalid={fieldError ? 'true' : 'false'}
                aria-describedby={fieldError ? 'ask-question-error' : undefined}
                onChange={(event) => {
                  setQuestion(event.target.value)
                  if (fieldError) setFieldError('')
                }}
                onKeyDown={(event) => {
                  // Enter asks; Shift+Enter adds a line.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
              />
              {fieldError && (
                <div id="ask-question-error" className="form-error" role="alert">
                  {fieldError}
                </div>
              )}
            </div>
            <div>
              <Button type="submit" loading={state.status === 'asking'} disabled={!online}>
                Ask
              </Button>
            </div>
          </form>
        </div>
      </Card>

      <div aria-live="polite" className="ask-output">
        {state.status === 'idle' && (
          <div className="ask-examples">
            <p className="page-header-sub">Ask anything you’ve told Recall. Try one of these:</p>
            <div className="inbox-actions">
              {EXAMPLES.map((example) => (
                <Button
                  key={example}
                  variant="secondary"
                  size="sm"
                  disabled={!online}
                  onClick={() => {
                    setQuestion(example)
                    void ask(example)
                  }}
                >
                  {example}
                </Button>
              ))}
            </div>
          </div>
        )}
        {state.status === 'asking' && <p role="status">Searching your records…</p>}
        {state.status === 'error' && (
          <div className="state-view state-error" role="alert">
            <strong>Couldn’t get an answer</strong>
            <span>{state.message}</span>
            {state.code && <span className="state-code">Code: {state.code}</span>}
            <div>
              <Button variant="secondary" size="sm" onClick={() => void ask(question)} disabled={!online}>
                Try again
              </Button>
            </div>
          </div>
        )}
        {state.status === 'answered' && <AskAnswer question={state.question} result={state.result} timeZone={timeZone} />}
      </div>
    </div>
  )
}

function AskAnswer({ question, result, timeZone }: { question: string; result: AskResponse; timeZone: string }) {
  const sources = result.grounded ? result.evidence : []
  return (
    <div className="ask-grid">
      <Card>
        <div className="card-content ask-answer">
          <div className="kind-label">
            Answer
            {result.period ? ` · ${result.period.label} · ${result.period.timeZone}` : ''}
          </div>
          <p className="ask-answer-text">{result.answer}</p>
          <div className="inbox-actions">
            {result.grounded ? (
              <span className="chip chip-ok">
                Based on {sources.length} record{sources.length === 1 ? '' : 's'}
              </span>
            ) : (
              <span className="chip chip-warn">Not grounded: no matching records</span>
            )}
            <span className="chip">
              Written by {result.deterministic ? 'Recall’s built-in rules' : result.provider}
            </span>
          </div>
        </div>
      </Card>
      <Card>
        <div className="card-content">
          <h2 className="section-title" style={{ marginTop: 0 }}>
            Sources
          </h2>
          {sources.length > 0 ? (
            <ol className="ask-sources">
              {sources.map((source, index) => (
                <li key={`${source.type}-${source.id}`} className="ask-source">
                  <span className="ask-source-n" aria-hidden="true">
                    {index + 1}
                  </span>
                  <Link to={detailPath(DETAIL_TYPES[source.type], source.id)}>
                    <span className="sr-only">Source {index + 1}: </span>
                    <span className="kind-label">{source.type.charAt(0) + source.type.slice(1).toLowerCase()}</span>
                    <br />
                    {source.title}
                  </Link>
                  <span className="page-header-sub tabular">{formatLocalDateTime(source.timestamp, timeZone)}</span>
                </li>
              ))}
            </ol>
          ) : result.period ? (
            <p className="page-header-sub">
              No records fall in {result.period.label} ({result.period.timeZone}).
            </p>
          ) : (
            <p className="page-header-sub">
              No records matched “{question}”. Searched: tasks, notes, ideas, events, reminders, projects and
              captures. Try other words.
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}
