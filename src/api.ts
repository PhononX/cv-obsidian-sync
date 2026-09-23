import { requestUrl } from 'obsidian'
import type {
  CarbonVoiceUser,
  CarbonVoiceMessage,
  CarbonVoiceMessageV5,
  CarbonVoiceMessageV6,
  CarbonVoiceAiResponse,
  CarbonVoicePrompt,
  CarbonVoiceAudioModel,
  CarbonVoiceTextModel,
  CarbonVoiceAttachment,
  CarbonVoiceChannel,
  GetWorkspacesResponse,
  CarbonVoiceFolder,
  ListFoldersResponse,
  FolderType,
  MessageDirection,
  WorkspaceType,
  WorkspaceRole,
} from './types'

const BASE_URL = 'https://api.carbonvoice.app'

export interface MessageQueryParams {
  date: string
  direction: MessageDirection
  use_last_updated: boolean
  channel_id?: string
  limit?: number
}

export interface RecentChannelsFilter {
  limit?: number
  direction?: MessageDirection
  date?: string
  includeDeleted?: boolean
}

export interface GetMessageOptions {
  language?: string
  presigned_url?: boolean
  fresh?: boolean
}

export interface ResponsesQueryParams {
  date: string
  direction: MessageDirection
  limit?: number
}

// Query for the keyset-paginated v6 message endpoints (GET /v6/messages and /v6/messages/updates).
// First page: pass `date` + `direction`. Subsequent pages: pass `cursor` (the previous page's
// next_cursor) + the SAME `direction`, and omit `date` — the cursor supersedes it. `limit` defaults
// to, and is capped at, 200 server-side.
export interface MessagesV6QueryParams {
  direction: MessageDirection
  date?: string
  cursor?: string
  limit?: number
  conversation_id?: string
  language?: string
  presigned_url?: boolean
}

// One keyset page of v6 messages. Keep paging while `hasMore` is true, re-issuing with
// `cursor: nextCursor`; never infer end-of-results from a short `messages` array. With
// direction=newer the final page still carries `nextCursor` (the newest message seen), which is
// what incremental sync stores to resume from; it is null only on an empty date-anchored page.
export interface MessagePageV6 {
  messages: CarbonVoiceMessage[]
  hasMore: boolean
  nextCursor: string | null
}

export interface WorkspaceQueryParams {
  direction?: MessageDirection
  limit?: number
  date?: string
  starting_after?: string
  ending_before?: string
  roles?: WorkspaceRole[]
  types?: WorkspaceType[]
  include_total?: boolean
}

export interface FolderQueryParams {
  type: FolderType
  include_all_tree?: boolean
  workspace_id?: string
  sort_direction?: 'ASC' | 'DESC'
  sort_by?: string
}

export class CarbonVoiceAPI {
  constructor(private token: string) {}

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  // Single request path so every failure names the endpoint that produced it. `throw: false` keeps
  // Obsidian from raising a bare "Request failed, status N" before we can attach the method + path,
  // which is otherwise impossible to trace across a large import. On error we also log the response
  // body to the developer console (Ctrl/Cmd+Shift+I) — it usually explains *why* (e.g. a 403).
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await requestUrl({
      url: `${BASE_URL}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      throw: false,
    })
    if (res.status === 401) throw new Error(`Invalid API token (${method} ${path})`)
    if (res.status < 200 || res.status >= 300) {
      console.error(`Carbon Voice API error ${res.status} on ${method} ${path}`, res.text)
      throw new Error(`API error ${res.status} on ${method} ${path}`)
    }
    return res.json as T
  }

  // ── Workspaces ────────────────────────────────────────────────────────────

  async getWorkspaces(params: WorkspaceQueryParams = {}): Promise<GetWorkspacesResponse> {
    const qs = new URLSearchParams()
    if (params.direction) qs.set('direction', params.direction)
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.date) qs.set('date', params.date)
    if (params.starting_after) qs.set('starting_after', params.starting_after)
    if (params.ending_before) qs.set('ending_before', params.ending_before)
    if (params.roles) params.roles.forEach(r => qs.append('roles', r))
    if (params.types) params.types.forEach(t => qs.append('types', t))
    if (params.include_total) qs.set('include_total', 'true')
    const query = qs.toString() ? `?${qs.toString()}` : ''
    return this.get<GetWorkspacesResponse>(`/v5/workspaces${query}`)
  }

  // ── Folders ───────────────────────────────────────────────────────────────

  // Root folders for a given type. Pass include_all_tree to get the full nested tree in one
  // call; subfolders are then available via each folder's `subfolders` / `path`.
  async getFolders(params: FolderQueryParams): Promise<CarbonVoiceFolder[]> {
    const qs = new URLSearchParams()
    qs.set('type', params.type)
    if (params.include_all_tree) qs.set('include_all_tree', 'true')
    if (params.workspace_id) qs.set('workspace_id', params.workspace_id)
    if (params.sort_direction) qs.set('sort_direction', params.sort_direction)
    if (params.sort_by) qs.set('sort_by', params.sort_by)
    const data = await this.get<ListFoldersResponse>(`/folders?${qs.toString()}`)
    return data.results
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async getCurrentUser(): Promise<CarbonVoiceUser> {
    const data = await this.get<{ success: boolean; user: CarbonVoiceUser }>('/whoami')
    return data.user
  }

  // ── Channels (Conversations) ──────────────────────────────────────────────

  // Returns channels ordered by recent activity. Omit filter to get all.
  async getRecentChannels(filter: RecentChannelsFilter = {}): Promise<CarbonVoiceChannel[]> {
    return this.post<CarbonVoiceChannel[]>('/channels/recent', filter)
  }

  // V2 includes all collaborators in json_collaborators.
  async getChannel(channelGuid: string): Promise<CarbonVoiceChannel> {
    return this.get<CarbonVoiceChannel>(`/v2/channel/${channelGuid}`)
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  // POST /v3/messages/recent — the previous message feed. Sync now uses the v6 endpoints below;
  // this is kept as a fallback for easy rollback and is currently unused.
  async getRecentMessages(params: MessageQueryParams): Promise<CarbonVoiceMessage[]> {
    return this.post<CarbonVoiceMessage[]>('/v3/messages/recent', params)
  }

  // The v6 message endpoints (GET) — the live feeds sync uses. Both are keyset-paginated: the
  // caller pages with `date`+`direction`, then `cursor`+`direction` while `hasMore`. The server
  // shifts a first `newer` page's `date` back 4s to avoid missing just-written rows. A stored
  // resume cursor may also re-deliver up to 4s of already-seen messages, so callers de-duplicate
  // by id. Each row is normalised via mapMessageV6.

  // GET /v6/messages — messages ordered by created_at. This is the history-import feed.
  async getMessagesV6(params: MessagesV6QueryParams): Promise<MessagePageV6> {
    return this.pageMessagesV6('/v6/messages', params)
  }

  // GET /v6/messages/updates — messages ordered by last_updated_at, surfacing edits / status /
  // label changes as well as new messages. This is the incremental-sync feed. We leave
  // include_unchanged_content at its default (true): notes are rebuilt from the full message, so
  // every row must carry its content.
  async getMessageUpdatesV6(params: MessagesV6QueryParams): Promise<MessagePageV6> {
    return this.pageMessagesV6('/v6/messages/updates', params)
  }

  // Shared query + normalisation for the two v6 message feeds — identical params and envelope, they
  // differ only in ordering (created_at vs last_updated_at) server-side. Each row is mapped back
  // into the CarbonVoiceMessage the sync engine consumes.
  private async pageMessagesV6(
    path: string,
    params: MessagesV6QueryParams
  ): Promise<MessagePageV6> {
    const qs = new URLSearchParams()
    qs.set('direction', params.direction)
    // A cursor supersedes date; send exactly one anchor so the two never conflict.
    if (params.cursor) qs.set('cursor', params.cursor)
    else if (params.date) qs.set('date', params.date)
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.conversation_id) qs.set('conversation_id', params.conversation_id)
    if (params.language) qs.set('language', params.language)
    if (params.presigned_url) qs.set('presigned_url', 'true')
    const res = await this.get<{
      data: CarbonVoiceMessageV6[]
      has_more: boolean
      next_cursor: string | null
    }>(`${path}?${qs.toString()}`)
    return {
      messages: (res.data ?? []).map(mapMessageV6),
      hasMore: Boolean(res.has_more),
      nextCursor: res.next_cursor ?? null,
    }
  }

  // ── AI responses & prompts ────────────────────────────────────────────────

  // A page of AI responses across the account, ordered by date — the feed used to sync artifacts
  // in bulk. Paged like the message scans (date cursor + direction).
  async getResponses(params: ResponsesQueryParams): Promise<CarbonVoiceAiResponse[]> {
    const qs = new URLSearchParams()
    qs.set('date', params.date)
    qs.set('direction', params.direction)
    if (params.limit != null) qs.set('limit', String(params.limit))
    return this.get<CarbonVoiceAiResponse[]>(`/responses?${qs.toString()}`)
  }

  // A single AI response by id (fallback for a message-referenced response not in the feed window).
  async getResponse(id: string): Promise<CarbonVoiceAiResponse> {
    return this.get<CarbonVoiceAiResponse>(`/responses/${id}`)
  }

  // All prompts the account can see, used to label a response by the prompt that produced it.
  async getPrompts(): Promise<CarbonVoicePrompt[]> {
    return this.get<CarbonVoicePrompt[]>('/prompts')
  }

  // Downloads a binary asset (e.g. message audio) by URL. No Authorization header: the Carbon
  // Voice audio URLs are presigned S3 links, and S3 rejects requests that carry both a
  // query-string signature and a bearer token ("only one auth mechanism allowed").
  async downloadBinary(url: string): Promise<ArrayBuffer> {
    const res = await requestUrl({ url, method: 'GET' })
    if (res.status < 200 || res.status >= 300) throw new Error(`Download failed ${res.status}`)
    return res.arrayBuffer
  }

  // V5 has transcript and ai_summary as direct fields — prefer this for sync.
  async getMessage(id: string, options: GetMessageOptions = {}): Promise<CarbonVoiceMessageV5> {
    const params = new URLSearchParams()
    if (options.language) params.set('language', options.language)
    if (options.presigned_url) params.set('presigned_url', 'true')
    if (options.fresh) params.set('fresh', 'true')
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await this.get<{ message: CarbonVoiceMessageV5 }>(`/v5/messages/${id}${qs}`)
    return data.message
  }
}

// Normalises a v6 message row (from /v6/messages or /v6/messages/updates) into the
// CarbonVoiceMessage the sync engine consumes. In v6 the transcript, AI summary, time codes,
// language and audio all live under `content` (omitted when the message has neither audio nor
// text). They're re-expressed here as the `transcript` / `summary` text models and a one-entry
// audio_models list the engine reads. Scope is single-valued (wrapped back into arrays), and
// `thread_id` stands in for parent_message_id. v6 has no `name`, so a voice memo's title falls
// back to its summary/transcript. The message's `ai_response_ids` are kept for AI-artifact sync.
function mapMessageV6(r: CarbonVoiceMessageV6): CarbonVoiceMessage {
  const c = r.content ?? {}
  const language = c.language ?? ''

  // Prefer the transcript string; fall back to joining the per-word time codes (audio messages can
  // carry the words there with an empty transcript), matching v3 handling.
  const transcript =
    c.transcript?.trim() ||
    (c.time_codes ?? [])
      .map(tc => tc.t)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

  const textModels: CarbonVoiceTextModel[] = []
  if (transcript) {
    textModels.push({ type: 'transcript', audio_id: null, language_id: language, value: transcript })
  }
  if (c.ai_summary && c.ai_summary.trim()) {
    textModels.push({ type: 'summary', audio_id: null, language_id: language, value: c.ai_summary })
  }

  const audioModels: CarbonVoiceAudioModel[] = []
  const audioUrl = c.presigned_url || c.url || c.streaming_url || ''
  if (audioUrl) {
    audioModels.push({
      _id: r.id,
      url: audioUrl,
      extension: null,
      streaming: false,
      language,
      duration_ms: c.duration_ms ?? 0,
      // v6 sends the waveform as a compact base-36 string; the plugin never renders it.
      waveform_percentages: [],
      is_original_audio: true,
    })
  }

  const attachments: CarbonVoiceAttachment[] = (r.attachments ?? []).map(a => ({
    _id: a.id,
    creator_id: a.creator_id,
    created_at: a.created_at,
    type: a.type,
    link: a.url,
    filename: a.filename,
    mime_type: a.mime_type,
    length_in_bytes: a.length_in_bytes,
  }))

  return {
    message_id: r.id,
    creator_id: r.creator_id,
    created_at: r.created_at,
    deleted_at: r.deleted_at ?? null,
    last_updated_at: r.updated_at || r.created_at,
    workspace_ids: r.workspace_id ? [r.workspace_id] : [],
    channel_ids: r.conversation_id ? [r.conversation_id] : [],
    // A message is a reply exactly when its thread differs from its own id.
    parent_message_id: r.thread_id && r.thread_id !== r.id ? r.thread_id : null,
    name: null,
    // Only an `audio` kind is an audio message; everything else (text, ai-*, action items…) is
    // rendered as text so it never shows a phantom duration or audio player. `kind` is optional in
    // v6, so when it's missing, fall back to whether the message actually has audio.
    is_text_message: r.kind ? r.kind !== 'audio' : !audioUrl,
    status: r.status,
    type: r.type,
    folder_id: r.folder_id ?? null,
    duration_ms: c.duration_ms ?? 0,
    audio_models: audioModels,
    text_models: textModels,
    attachments,
    notes: r.notes ?? '',
    ai_response_ids: r.ai_response_ids ?? [],
  }
}
