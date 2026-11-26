import { notesApi } from "../lib/api";
import { useTimeZone } from "../hooks/useTimeZone";
import { ListPage } from "../components/ListPage";
import { noteFormSpec } from "../components/record-forms";
import { NoteRow } from "../components/record-rows";
import { NotesIcon } from "../components/Layout";

export function NotesPage() {
  const { timeZone } = useTimeZone();
  return (
    <ListPage
      title="Notes"
      noun="notes"
      icon={<NotesIcon />}
      emptyTitle="No notes yet"
      emptyText="Create a note to save information, links, or references."
      spec={noteFormSpec}
      fetchPage={(page) => notesApi.list({ sort: "createdAt", order: "desc", ...page })}
      renderRows={(notes) =>
        notes.map((note) => <NoteRow key={note.id} note={note} timeZone={timeZone} />)
      }
    />
  );
}
