# Carbon Voice Sync

Sync your [Carbon Voice](https://getcarbon.app) conversations and voice memos
into your Obsidian vault as Markdown notes.

> **Desktop and mobile.** The plugin talks to the Carbon Voice API over the
> network and runs on both Obsidian desktop and mobile.

## Use cases

- **Async meeting notes in your vault.** Just as people pull meeting recordings
  and transcriptions into Obsidian, this brings your Carbon Voice async
  conversations in automatically — so the discussion, decisions, and transcripts
  live alongside the rest of your notes and are there to refer back to later.
- **Feed your second brain by voice.** Drop a quick thought into a Carbon Voice
  voice memo and it gets transcribed and synced into Obsidian on its own — no
  typing, no copy-paste. Capture ideas the moment they happen and let them flow
  straight into your knowledge base.

## Features

- **Connect your Carbon Voice account** with a Personal Access Token — the token
  is stored locally in your vault and only ever sent to the Carbon Voice API.
- **Choose what syncs:**
  - _Conversations_ — all of them, only those in selected workspaces, or a
    hand-picked set of conversations.
  - _Voice memos_ — all of them, only those in selected workspaces, or specific
    folders.
- **Import history** per category, with a configurable window (last 7 / 30 / 90 /
  365 days, or all time).
- **Background sync** on a configurable interval, and optional sync on startup.
- **Optional transcripts** — include or omit message transcripts in your notes.
- **Linked knowledge graph** — participants, message senders and workspaces become
  `[[wiki links]]` to auto-generated **People** and **Workspace** notes, so the
  Obsidian graph and backlinks connect every conversation and memo. Those stub notes
  are created once and never overwritten, so you can annotate them freely.
- **AI summaries** — a voice memo's Carbon Voice summary is written into a `## Summary`
  section at the top of its note.
- **Audio playback in your notes** — listen right next to the transcript. Choose how:
  - _Embed player_ (default) — inline Carbon Voice player, nothing stored in your vault;
    private messages show their own locked state.
  - _Download for offline_ — save each message's audio into a `Media` folder and embed a
    native player, so playback works offline (and for private audio).
  - _Off_ — no player, just the "Open in Carbon Voice" link.

> **Status:** `0.1.1` — an early but working release. Account connection, all
> sync configuration (scopes, folders, workspaces, history windows), forward
> sync, and historical import are functional. As an early release, the note
> format and settings may still change between versions, so consider a test
> vault or a backup if that matters to you.

## Installation

### From the Community Plugins browser (coming soon)

> **Not yet available.** Carbon Voice Sync has not been listed in the Obsidian
> community store yet, so it will not appear under **Browse**. Until it is,
> install it with BRAT (below). Once listed, this will be: **Settings →
> Community plugins → Browse → search "Carbon Voice Sync" → Install → Enable**.

### Beta install via BRAT (available now)

Before the plugin is listed in the community store, you can install and
auto-update it with [BRAT](https://github.com/TfTHacker/obsidian42-brat) — this
works on both desktop and mobile:

1. Install the **BRAT** community plugin and enable it.
2. In BRAT's settings, choose **Add Beta Plugin** and enter
   `phononx/cv-obsidian-sync`.
3. Enable **Carbon Voice Sync** under Community plugins.

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/phononx/cv-obsidian-sync/releases).
2. Create a folder named `carbon-voice-sync` in your vault's
   `.obsidian/plugins/` directory.
3. Copy the three files into that folder.
4. Reload Obsidian and enable **Carbon Voice Sync** under Community plugins.

## Setup

1. Generate a **Personal Access Token** in the Carbon Voice app: open the
   **Profile** menu, select **Integrations → Integration Credentials**, and
   create a token.
2. In Obsidian, open **Settings → Carbon Voice Sync** and click **Add token**.
3. Paste your token and click **Connect**. Once validated, your account name and
   email appear at the top of the settings.
4. Configure your **sync folder**, **interval**, and the **conversation** and
   **voice memo** scopes to control exactly what gets pulled into your vault.

## Development

Requires Node.js 20+.

```bash
npm install      # install dependencies
npm run dev      # rebuild main.js on change (esbuild watch)
npm run build    # production build
```

The build bundles `src/main.ts` into `main.js` at the repo root. `main.js` is
git-ignored — it is produced by the build and attached to GitHub releases rather
than committed.

## Releasing

Releases are automated by `.github/workflows/release.yml`. To cut one:

```bash
npm version <patch|minor|major>   # bumps package.json, manifest.json, versions.json
git push --follow-tags            # pushes the branch and the version tag
```

Pushing the tag triggers a build and creates a **draft** GitHub release with
`main.js` and `manifest.json` attached as assets. Review it and publish. The
`npm version` step keeps `manifest.json` and `versions.json` in sync with the
tag, so the release name always matches the plugin version (no `v` prefix), as
Obsidian requires.

## License

[MIT](LICENSE) © Phonon X, Inc.
