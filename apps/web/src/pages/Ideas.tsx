import { ideasApi } from '../lib/api'
import { useTimeZone } from '../hooks/useTimeZone'
import { ListPage } from '../components/ListPage'
import { ideaFormSpec } from '../components/record-forms'
import { IdeaRow } from '../components/record-rows'
import { IdeasIcon } from '../components/Layout'

export function IdeasPage() {
  const { timeZone } = useTimeZone()
  return (
    <ListPage
      title="Ideas"
      noun="ideas"
      icon={<IdeasIcon />}
      emptyTitle="No ideas yet"
      emptyText="Capture your thoughts and inspirations."
      spec={ideaFormSpec}
      fetchPage={(page) => ideasApi.list({ sort: 'createdAt', order: 'desc', ...page })}
      renderRows={(ideas) => ideas.map((idea) => <IdeaRow key={idea.id} idea={idea} timeZone={timeZone} />)}
    />
  )
}
