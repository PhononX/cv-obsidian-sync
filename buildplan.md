# Build Plan: Carbon Voice Sync — Obsidian Community Plugin

> **Status:** Draft — endpoints strategy needs revision before implementation begins.

---

## Overview

Build a fully functional Obsidian community plugin that syncs conversations from the Carbon Voice API into markdown notes in the user's vault. The plugin follows all Obsidian plugin conventions and is ready to install locally for testing.

---

## Tech Stack

- TypeScript (strict mode)
- Obsidian Plugin API (`obsidian` npm package), targeting v1.4.0+
- Bundled with esbuild (standard Obsidian plugin toolchain)
- No unnecessary external dependencies
- Desktop only (`isDesktopOnly: true`)

---

## Repository Structure

```
carbon-voice-sync/
  src/
    main.ts          # Plugin entry point
    api.ts           # Carbon Voice API client
    sync.ts          # Sync logic and note generation
    settings.ts      # Settings tab UI
    types.ts         # TypeScript interfaces
  manifest.json
  package.json
  tsconfig.json
  esbuild.config.mjs
  .gitignore
  README.md
```

---

## manifest.json

```json
{
  "id": "carbon-voice-sync",
  "name": "Carbon Voice Sync",
  "version": "1.0.0",
  "minAppVersion": "1.4.0",
  "description": "Sync Carbon Voice async voice conversations into your Obsidian vault",
  "author": "Carbon Voice",
  "authorUrl": "https://getcarbon.app",
  "isDesktopOnly": true
}
```

---

## Settings

Exposed under **Obsidian Settings > Carbon Voice Sync**.

### General

| Setting | Type | Default | Notes |
|---|---|---|---|
| API Token | Text (masked) | — | Helper: "Generate a token at developer.carbonvoice.app/" |
| Sync Folder | Text | `Carbon Voice` | Root vault folder for all synced content |
| Sync Interval | Dropdown | Every 15 minutes | Options: 5 min / 15 min / 30 min / 1 hour / Manual only |
| Include Transcripts | Toggle | On | When off, Messages/Transcript sections are omitted |
| Sync on Startup | Toggle | On | Run sync when Obsidian opens |
| Last Synced | Read-only display | — | Timestamp of last successful sync |
| Sync Now | Button | — | Triggers immediate manual sync + shows status Notice |

### Conversation Sync Scope

| Setting | Type | Default | Notes |
|---|---|---|---|
| Scope | Radio | All Conversations | Options: All / By Workspace / By Conversation |
| Workspaces | Multi-select | — | Visible when scope = By Workspace; options fetched from API |
| Conversations | Multi-select | — | Visible when scope = By Conversation; options fetched from API |

### Voice Memo Sync Scope

| Setting | Type | Default | Notes |
|---|---|---|---|
| Scope | Radio | All Voice Memos | Options: All / By Workspace / By Folder |
| Workspaces | Multi-select | — | Visible when scope = By Workspace; options fetched from API |
| Folders | Multi-select | — | Visible when scope = By Folder; options fetched from API |

Multi-select options are fetched from the API when the settings tab opens (requires a valid token). If the token is missing or invalid, a notice is shown and scope defaults to All.

### Historical Import

| Setting | Type | Default | Notes |
|---|---|---|---|
| Import history | Dropdown + Button | Last 30 days | Options: Last 7 days / 30 days / 90 days / 1 year / All time |

- First run syncs forward from the current timestamp — no historical data is fetched automatically
- Historical import is a separate, explicit user action
- Runs as a one-time bulk operation with a progress notice: *"Carbon Voice: Importing history, this may take a moment…"*
- Does not reset `lastSyncTimestamp` — additive only
- Respects the active Conversation and Voice Memo scope settings

Persisted via `this.loadData()` / `this.saveData()`.

---

## Carbon Voice API Client (`api.ts`)

> **⚠ ENDPOINTS NEED REVISION** — The endpoint paths and response shapes below are modeled/assumed. Review against actual API spec before implementing.

### Base URL

```
https://api.carbonvoice.app
```

### Auth

Every request includes:
```
Authorization: Bearer <token>
```

### Endpoints

#### `GET /v1/conversations`

Query params:
- `updated_after` — ISO 8601 timestamp (optional, used for incremental sync)
- `limit` — number, default 50
- `offset` — number, default 0

Assumed response:
```json
{
  "conversations": [ ...Conversation[] ],
  "total": 100,
  "has_more": true
}
```

#### `GET /v1/conversations/:id/messages`

Assumed response:
```json
{
  "messages": [ ...Message[] ]
}
```

#### Connection test

A `testConnection()` method that hits `/v1/me` (or equivalent) and returns `true`/`false`. Used to validate token in the settings UI.

### Class interface

```typescript
class CarbonVoiceAPI {
  constructor(token: string) {}
  async getConversations(params: { updated_after?: string; limit?: number; offset?: number }): Promise<ConversationsResponse> {}
  async getMessages(conversationId: string): Promise<MessagesResponse> {}
  async testConnection(): Promise<boolean> {}
}
```

All methods are async. Any non-2xx response throws a descriptive error.

---

## TypeScript Interfaces (`types.ts`)

> **Note:** These are modeled interfaces. Field names may not match the actual API response. Keep them isolated so mappings can be updated without rewriting sync logic.

```typescript
interface Conversation {
  id: string
  title: string | null
  created_at: string        // ISO 8601
  updated_at: string        // ISO 8601
  last_message_at: string   // ISO 8601
  participant_count: number
  participants: Participant[]
  message_count: number
  summary: string | null    // AI-generated summary
  status: 'active' | 'dormant' | 'closed'
  folder?: string           // CV workspace folder name, if any
  tags?: string[]
}

interface Participant {
  id: string
  name: string
  email?: string
}

interface Message {
  id: string
  conversation_id: string
  sender: Participant
  created_at: string        // ISO 8601
  duration_seconds: number
  transcript: string | null
  audio_url?: string
}

interface ConversationsResponse {
  conversations: Conversation[]
  total: number
  has_more: boolean
}

interface MessagesResponse {
  messages: Message[]
}

type SyncScope = 'all' | 'by_workspace' | 'by_conversation' | 'by_folder'

type HistoryWindow = 7 | 30 | 90 | 365 | 'all'

interface CarbonVoiceSettings {
  apiToken: string
  syncFolder: string
  syncInterval: number            // minutes, 0 = manual
  includeTranscripts: boolean
  syncOnStartup: boolean
  lastSyncTimestamp: string | null  // null = first run, sync forward from now

  conversationScope: SyncScope    // 'all' | 'by_workspace' | 'by_conversation'
  conversationWorkspaceIds: string[]
  conversationIds: string[]

  voiceMemoScope: SyncScope       // 'all' | 'by_workspace' | 'by_folder'
  voiceMemoWorkspaceIds: string[]
  voiceMemoFolderIds: string[]

  historyWindow: HistoryWindow    // selected window for manual historical import
}
```

---

## Vault Structure

```
/{syncFolder}
  /Conversations
    /{Conversation Title}
      2026-10.md
      2026-09.md
  /Voice Memos
    /{Folder Name}
      {Voice Memo Title}.md
```

- `syncFolder` defaults to `Carbon Voice`
- Conversation subfolders use the conversation title (fallback: `Conversation {id.slice(0, 8)}`)
- Monthly files named `YYYY-MM.md`, containing all messages from that month
- Voice memo files named after the memo title

---

## Note Generation (`sync.ts`)

### Conversations — grouped by workspace, one folder per conversation, one file per month

**Folder path:** `{syncFolder}/Conversations/{workspace}/{title}/`
**File path:** `{syncFolder}/Conversations/{workspace}/{title}/YYYY-MM Messages.md`
- Month derived from each message's `created_at`
- Messages are grouped by month and written into their respective file
- On upsert, regenerate the full month file from all known messages for that month

### Conversation monthly file — frontmatter

```yaml
---
cv_conversation_id: {conversation.id}
cv_status: active | dormant | closed
title: {title}
month: {YYYY-MM}
participants: [Name One, Name Two]
tags: [carbon-voice, {any cv tags}]
---
```

### Conversation monthly file — body

```markdown
# {title} — {Month YYYY}

## Messages

### {sender.name} · {MMM D} · {duration}s
{transcript text, or "_[No transcript available]_" if null}

---

### {sender.name} · {MMM D} · {duration}s
{transcript}

---

## Metadata
- **Synced:** {current timestamp}
```

If `includeTranscripts` is `false`, the **Messages** section is omitted entirely.

---

### Voice Memos — one note per memo

**File path:** `{syncFolder}/Voice Memos/{folder name}/{memo title}.md`
- Folder name comes from the CV folder the memo belongs to
- Memo title falls back to `{YYYY-MM-DD} Voice Memo` if untitled

### Voice memo file — frontmatter

```yaml
---
cv_memo_id: {memo.id}
cv_folder: {folder name}
title: {memo title}
date: {created_at as YYYY-MM-DD}
duration: {duration_seconds}
tags: [carbon-voice, voice-memo]
---
```

### Voice memo file — body

```markdown
# {memo title}

## Transcript
{transcript, or "> No transcript available yet." if null}

## Metadata
- **Date:** {created_at formatted}
- **Duration:** {duration_seconds}s
- **Synced:** {current timestamp}
```

---

### Upsert logic

**Conversations:**
1. Derive the expected folder path from conversation title
2. Derive the expected monthly file path from message `created_at`
3. If file exists: regenerate full content for that month and overwrite
4. If file does not exist: create folder if needed, then create file

**Voice Memos:**
1. Derive path from folder name + memo title
2. If file exists: overwrite with fresh content
3. If not: create folder if needed, then create file

Never use `app.vault.adapter` directly — use `app.vault` methods.

### Incremental sync

- On first run (`lastSyncTimestamp` is null): set `lastSyncTimestamp` to now and sync forward — no historical data is fetched
- On each subsequent sync pass: pass `updated_after: lastSyncTimestamp` to the API, then update `lastSyncTimestamp` to current time on success
- Paginate using `has_more` / `offset` until all results are fetched

### Historical import

- Triggered explicitly by the user via the Import History button in settings
- Computes `import_after` from the selected window (e.g. 30 days ago from now)
- Fetches all conversations/memos updated after `import_after`, paginating to completion
- Does not modify `lastSyncTimestamp`
- Respects active scope settings (workspace / conversation / folder filters)
- Shows a persistent Notice during import; updates to *"Carbon Voice: Imported X conversations, Y memos"* on completion

---

## Plugin Entry Point (`main.ts`)

```typescript
export default class CarbonVoiceSyncPlugin extends Plugin {
  settings: CarbonVoiceSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CarbonVoiceSettingTab(this.app, this));

    this.addRibbonIcon('microphone', 'Sync Carbon Voice', async () => {
      await this.runSync();
    });

    this.addCommand({
      id: 'sync-carbon-voice',
      name: 'Sync Carbon Voice conversations',
      callback: () => this.runSync(),
    });

    if (this.settings.syncOnStartup && this.settings.apiToken) {
      await this.runSync();
    }

    this.registerSyncInterval();
  }

  registerSyncInterval() {
    // Clear any existing interval, register fresh based on current settings
    // Skip if syncInterval === 0 (manual only)
  }

  async runSync() {
    // Notice: "Carbon Voice: Syncing..."
    // Call sync logic
    // Notice: "Carbon Voice: Synced X conversations" or surface error
  }
}
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| API token missing/empty | `new Notice(...)` pointing to settings; abort sync |
| API returns 401 | `new Notice("Carbon Voice: Invalid API token — check Settings")` |
| API returns other error | `new Notice(...)` with status code + message |
| Network error | `new Notice("Carbon Voice: Could not reach API")` |

All errors caught and surfaced as Notices. Plugin must never crash silently.

---

## Build Config

Standard Obsidian esbuild setup from the sample plugin:

- `npm run dev` — watch mode
- `npm run build` — production build
- Output: `main.js` in repo root

---

## README Contents

1. What the plugin does
2. Manual installation instructions (not yet in community catalog)
3. How to generate an API token in Carbon Voice
4. Settings reference
5. Known limitations (desktop only; polling, not webhooks)

---

## Open Questions / Revision Needed

- [ ] **Endpoints** — Confirm actual API paths, query param names, and response shapes against live API spec. `updated_after`, `has_more`, `/v1/me`, and the conversations/messages paths are all assumed.
- [ ] **Auth mechanism** — Confirm `Authorization: Bearer` is correct; check if token scoping is needed.
- [ ] **Pagination strategy** — Confirm whether offset-based or cursor-based.
- [ ] **`testConnection()` target** — Identify a stable lightweight endpoint to ping for token validation.
- [ ] **Message fetch strategy** — Currently fetches messages for every conversation individually. May want to revisit if the API supports bulk message fetching or embeds messages in the conversation list response.
- [ ] **Sync folder path** — Decide whether to support nested paths (e.g. `Notes/Carbon Voice`) or flat only.
