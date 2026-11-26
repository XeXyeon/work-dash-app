// 학습 노트 탭 API (WEB-35). 모양은 server/notes.js를 따른다.
import { useQuery } from '@tanstack/react-query';
import { getJson } from './api';

export interface NoteEntry { item: string; cardTitle: string; date: number; body: string }
export interface Note { key: string; name: string; latest: number; entries: NoteEntry[] }
export interface NotesDoc { project: string; cards: number; notes: Note[] }

// SSE changed(kind: 'cards', project)가 오면 무효화한다 (useLiveEvents)
export const noteKeys = {
  project: (project: string) => ['notes', project] as const,
};

export const useNotes = (project: string) =>
  useQuery({ queryKey: noteKeys.project(project), queryFn: () => getJson<NotesDoc>(`/api/notes/${encodeURIComponent(project)}`) });
