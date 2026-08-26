<p align="center">
  <img src="assets/icon.png" alt="MailPilot" width="96" height="96" style="border-radius: 20px;" />
</p>

<h1 align="center">MailPilot</h1>

<p align="center">
  <strong>Turn your inbox from a to-do list into an AI co-pilot cockpit.</strong>
</p>

<p align="center">
  An AI-first, keyboard-driven desktop email client built with Tauri, React, and Rust.<br />
  Local-first. Privacy-focused. Built for professionals who process 100+ emails a day.
</p>

<p align="center">
  <a href="#features">Features</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;
  <a href="#installation">Installation</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;
  <a href="docs/keyboard-shortcuts.md">Shortcuts</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;
  <a href="docs/architecture.md">Architecture</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;
  <a href="docs/development.md">Development</a>&nbsp;&nbsp;&bull;&nbsp;&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="assets/screenshots/app.png" alt="MailPilot inbox with sidebar, email list, and reading pane" width="900" />
</p>

---

## Why MailPilot?

Email is still the tool knowledge workers open most often — but three problems remain unsolved:

| Pain point | What MailPilot does |
| --- | --- |
| **Information overload** | AI auto-sorts incoming mail into action tiers so you scan in minutes, not hours |
| **Context switching** | One client for Gmail, Outlook, and IMAP — switch accounts without switching apps |
| **Broken AI workflows** | AI lives inside your inbox — summarize, draft, and search without copy-pasting to a browser tab |

MailPilot is a local-first, keyboard-driven email client where AI assists every step — but never sends on your behalf.

---

## Features

### AI Co-Pilot (Core)

MailPilot's four pillar AI capabilities:

| Capability | What it does |
| --- | --- |
| **Smart classification** | Auto-sorts mail into *Needs Reply*, *Notifications*, and *Follow Up* |
| **One-click draft replies** | AI generates 1–3 reply variants from thread context; pick one, tweak, and send |
| **Thread summaries** | Long threads get a short summary: topic, decisions, open items |
| **Natural language search** | Search like *"find the contract my boss sent last quarter"* |

Eight AI backends — cloud APIs and local Ollama:

| Provider | Models | Notes |
| --- | --- | --- |
| **Anthropic Claude** | Haiku 4.5, Sonnet 4, Opus 4 | [Anthropic API](https://console.anthropic.com/) |
| **OpenAI** | GPT-4o Mini, GPT-4o, GPT-4.1 Nano, GPT-4.1 Mini, GPT-4.1 | [OpenAI API](https://platform.openai.com/) |
| **Google Gemini** | 2.5 Flash, 2.5 Pro | [Google AI Studio](https://aistudio.google.com/) |
| **DeepSeek** | V4 Flash, V4 Pro | [DeepSeek API](https://platform.deepseek.com/) |
| **Kimi (Moonshot)** | K2.6, K3 | [Moonshot API](https://platform.moonshot.cn/) |
| **GLM (Zhipu AI)** | GLM-5.3, GLM-5.2, GLM-5.1 | [Zhipu API](https://open.bigmodel.cn/) |
| **GitHub Copilot** | GPT-4o Mini, GPT-4.1 Nano/Mini, GPT-4o, GPT-4.1 | GitHub Personal Access Token → [models.github.ai](https://github.com/marketplace/models) |
| **Local (Ollama)** | Any installed model (default: Llama 3.2) | Data stays on your machine |

Per-feature provider selection, automatic or manual AI triggers, and output language (English / Chinese / Russian). Writing-style learning, Ask My Inbox, smart replies, and AI compose. All results cached locally.

> AI never sends on your behalf — every draft requires you to press Send.

### Email

- Multi-account support: Gmail (OAuth/API) and IMAP/SMTP (Outlook, Yahoo, iCloud, Fastmail, Yandex, and more)
- IMAP delta sync with batched folder search, header-only background fetch, and on-demand body loading (cached locally after first read)
- Configurable auto-refresh interval (default 120s) plus manual sync (`F5` or header refresh button)
- Threaded conversations with collapsible messages
- Full-text search with Gmail-style operators (`from:`, `to:`, `subject:`, `has:attachment`, `label:`, etc.)
- Command palette (`/` or `Ctrl+K`) for quick actions
- Drag-and-drop labels, multi-select, pin threads, mute threads, context menus
- Split inbox with category tabs (Primary, Updates, Promotions, Social, Newsletters)
- Inline reply, contact sidebar with Gravatar

### Composer

- TipTap v3 rich text editor (bold, italic, lists, code, links, images)
- Undo send, schedule send, auto-save drafts
- Multiple signatures, reusable templates with variables
- Send-as email aliases with from-address selector
- Drag-and-drop attachments with inline preview
- Frequency-ranked contact autocomplete

### Smart Inbox

- Snooze threads with presets or custom date/time — with follow-up reminders when no reply arrives
- Filters to auto-label, archive, trash, star, or mark read
- AI + rule-based auto-categorization
- One-click unsubscribe (RFC 8058) and subscription manager
- Newsletter bundling with delivery schedules
- Smart folders / saved searches with dynamic query tokens
- Quick steps — custom action chains for batch thread processing

### UI & Design

- Glassmorphism with animated gradient background
- Dark / light / system theme with 8 accent color presets
- Flexible reading pane (right, bottom, hidden), resizable panels
- Configurable density and font scaling
- Pop-out thread windows, custom titlebar, splash screen
- System tray with taskbar badge count

### Privacy & Security

- **Local-first** — emails stored in encrypted SQLite; read mail offline
- OAuth PKCE for Gmail — no client secret, no backend servers
- Encrypted password/app-password storage for IMAP accounts (AES-256-GCM)
- Remote image blocking with per-sender allowlist
- Phishing link detection with 10 heuristic scoring rules
- SPF/DKIM/DMARC authentication display with badges and warnings
- DOMPurify + sandboxed iframe rendering

### System Integration

- In-app auto-update — checks GitHub Releases every 4 hours; install from the toast or Settings → Developer
- `mailto:` deep links, global compose shortcut
- Autostart (hidden in tray), single instance
- [Customizable keyboard shortcuts](docs/keyboard-shortcuts.md) — `j/k` navigate, `r` reply, `s` star, `e` archive

---

## Installation

Download the latest release for your platform:

**[Download MailPilot](https://github.com/brucefengmm/MailPilot/releases/latest)** — Windows `.msi` / `.exe` &bull; macOS `.dmg` &bull; Linux `.deb` / `.AppImage`

No build tools required — download, install, and run. Installed builds check [GitHub Releases](https://github.com/brucefengmm/MailPilot/releases) for signed updates automatically.

### Account setup

**Gmail:** Create OAuth credentials in [Google Cloud Console](https://console.cloud.google.com/) (enable Gmail API), then enter your Client ID in MailPilot Settings. No client secret needed (PKCE).

**IMAP/SMTP:** Click "Add IMAP Account" in the account switcher. MailPilot auto-discovers settings for Outlook, Yahoo, iCloud, Fastmail, and more. Complete the first manual sync to enable background IMAP auto-sync.

**AI (optional):** In Settings → AI, pick a provider and add an API key. Supported backends:

| Provider | Get an API key |
| --- | --- |
| Anthropic Claude | [console.anthropic.com](https://console.anthropic.com/) |
| OpenAI | [platform.openai.com](https://platform.openai.com/) |
| Google Gemini | [aistudio.google.com](https://aistudio.google.com/) |
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com/) |
| Kimi (Moonshot) | [platform.moonshot.cn](https://platform.moonshot.cn/) |
| GLM (Zhipu AI) | [open.bigmodel.cn](https://open.bigmodel.cn/) |
| GitHub Copilot | [GitHub PAT](https://github.com/settings/tokens) with models access |
| Ollama (local) | [ollama.com](https://ollama.com/) — no key; set base URL in Settings |

### Building from source

```bash
git clone https://github.com/brucefengmm/MailPilot.git
cd MailPilot
npm install
npm run tauri dev
```

**Prerequisites:** [Node.js](https://nodejs.org/) v18+, [Rust](https://www.rust-lang.org/tools/install), [Tauri v2 deps](https://v2.tauri.app/start/prerequisites/)

See [Development Guide](docs/development.md) for all commands, testing, and build instructions.

---

## Tech Stack

| | |
| --- | --- |
| **Framework** | Tauri v2 (Rust) + React 19 + TypeScript |
| **Styling** | Tailwind CSS v4 |
| **State** | Zustand 5 (9 stores) |
| **Editor** | TipTap v3 |
| **Email** | Gmail API, IMAP/SMTP (async-imap + lettre) |
| **Database** | SQLite + FTS5 (37 tables) |
| **AI** | Claude, GPT, Gemini, DeepSeek, Kimi, GLM, GitHub Copilot, Ollama |
| **Testing** | Vitest + Testing Library |

See [Architecture](docs/architecture.md) for detailed design, data flow, and project structure.

---

## Building

```bash
npm run tauri build
```

**Windows** `.msi` / `.exe` &bull; **macOS** `.dmg` / `.app` &bull; **Linux** `.deb` / `.AppImage`

## License

MailPilot is licensed under the [Apache License 2.0](LICENSE). See also [NOTICE](NOTICE) for third-party and upstream attribution.

## Acknowledgments

MailPilot is a derivative work of [Velo](https://github.com/avihaymenahem/velo) (Copyright 2025 Velo Mail), an open-source desktop email client by Avihay Menahem. Velo is licensed under Apache-2.0. We thank the Velo project and its contributors for the foundation this project builds upon.

MailPilot is an independent project and is not affiliated with, endorsed by, or sponsored by Velo or its original authors. **Velo** and **Velo Mail** are trademarks of their respective owners; MailPilot does not claim those names.

---

Built with Rust and React.
