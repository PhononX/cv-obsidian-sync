import { requestUrl } from 'obsidian'
import type {
  CarbonVoiceUser,
  CarbonVoiceMessage,
  CarbonVoiceMessageV5,
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

  // Returns messages across all channels (or one channel via channel_id).
  // Voice memos have type === 'voicememo' and a folder_id.
  async getRecentMessages(params: MessageQueryParams): Promise<CarbonVoiceMessage[]> {
    return this.post<CarbonVoiceMessage[]>('/v3/messages/recent', params)
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
