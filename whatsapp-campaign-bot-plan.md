# Plan: WhatsApp Campaign Bot

**Generated**: 2026-10-05  
**Estimated Complexity**: Medium

## Overview

Build a small, single-process Node.js 20 + TypeScript application for a Raspberry Pi. `config.json` remains the source of truth for contacts and campaigns; the only other persistent files are Baileys authentication files under `auth/`.

The runtime has four deliberately small modules:

```text
config.json ──> config.ts ──> scheduler.ts ──> whatsapp.ts ──> WhatsApp
                    ▲               │
              safe reload      in-memory successful-send keys
```

The scheduler runs immediately, then through one `setInterval`. It computes the latest applicable occurrence using the configured IANA timezone, sends to each recipient independently, and records an occurrence only after a successful send. A failed recipient is retried on the next scheduler check for that same occurrence.

## Confirmed Decisions

- Runtime: Node.js 20 LTS; native `node:test` test runner.
- Campaign interval windows may cross midnight, such as `22:00` to `02:00`.
- `config.json` reloads while the process runs. Invalid updates do not stop a healthy bot: retain the last known-good configuration and log the validation failure.
- A failed recipient send is not marked complete and is retried in the next check.
- The account is a personal WhatsApp account paired by QR code.

## Prerequisites

- Raspberry Pi with Node.js 20 LTS and systemd.
- A WhatsApp account available to pair from the mobile app on the first run.
- A writable project directory; `auth/` must survive service restarts.
- Package versions must be resolved at implementation time. The current Baileys documentation supports `useMultiFileAuthState`, `creds.update`, `connection.update`, `DisconnectReason`, `printQRInTerminal`, and `sock.sendMessage(jid, { text })`.

## Sprint 1: Bootstrap a Runnable TypeScript Project

**Goal**: A minimal project builds, starts, and has safe repository defaults.

**Demo/Validation**:

- `npm install`, `npm run build`, and `npm test` succeed.
- `npm run dev` runs TypeScript directly with `tsx`.

### Task 1.1: Create the package and compiler configuration

- **Location**: `package.json`, `tsconfig.json`
- **Description**: Add Node 20-compatible ESM/CommonJS settings selected to match the installed Baileys release; add production dependencies only for `@whiskeysockets/baileys` and the selected logger/QR support required by that release. Add development dependencies for TypeScript, `tsx`, Node type definitions, and no external test framework.
- **Dependencies**: None.
- **Acceptance Criteria**:
  - Scripts: `dev`, `build`, `start`, and `test`.
  - `start` runs `dist/index.js`; `test` runs compiled or TypeScript tests consistently.
  - No database, web server, cron, queue, or Docker dependency is added.
- **Validation**: Run `npm install`, `npm run build`, and `npm test`.

### Task 1.2: Add ignored local state and example configuration

- **Location**: `.gitignore`, `config.example.json`, `config.json`
- **Description**: Ignore `node_modules/`, `dist/`, `auth/`, and the real `config.json`; commit a complete safe example. Create a local `config.json` from the example for development but do not commit it.
- **Dependencies**: Task 1.1.
- **Acceptance Criteria**:
  - The example includes two interval/time-list campaigns and valid placeholder Brazilian-format phone numbers.
  - Auth material and personal phone numbers cannot be committed accidentally.
- **Validation**: Check `git status --ignored` and parse the example JSON.

### Task 1.3: Define small shared domain types

- **Location**: `src/config.ts` (exported types)
- **Description**: Define `Contact`, `Campaign`, `IntervalSchedule`, `TimesSchedule`, discriminated `Schedule`, and `BotConfig`. Keep types adjacent to configuration code rather than creating a domain layer.
- **Dependencies**: Task 1.1.
- **Acceptance Criteria**:
  - Interval schedules have only `start`, `end`, and `intervalMinutes`.
  - Specific-time schedules have only `times`.
  - Campaigns refer to recipient contact IDs, never raw phone numbers.
- **Validation**: Type-check with `npm run build`.

## Sprint 2: Configuration Loading, Validation, and Safe Reloading

**Goal**: The process has an atomically valid configuration at all times.

**Demo/Validation**:

- Invalid initial configuration exits before WhatsApp connects.
- Editing to a valid configuration changes the next check without restart; invalid edits leave the previous valid configuration active.

### Task 2.1: Implement strict configuration loading and validation

- **Location**: `src/config.ts`, `test/config.test.ts`
- **Description**: Read and parse `config.json`, validate it manually with clear path/campaign-specific errors, and return a typed immutable snapshot plus a contact-ID lookup map. Avoid a schema-validation dependency for this small fixed schema.
- **Dependencies**: Task 1.3.
- **Acceptance Criteria**:
  - Reject malformed JSON, invalid IANA timezone, invalid/non-positive `checkIntervalSeconds`, duplicate or empty contact/campaign IDs, missing phone/name, unknown recipients, blank messages, invalid `HH:mm`, invalid/zero interval, duplicate specific times, and schedules mixing/omitting forms.
  - Require `start`, `end`, and `intervalMinutes` together for interval schedules.
  - Permit crossing-midnight windows; do not require `start <= end`.
  - Error examples identify the campaign and field, such as `Invalid campaign "water-reminder": recipient "carlos" does not exist.`
- **Validation**: Native tests cover every required invalid-config case.

### Task 2.2: Add a last-known-good reload controller

- **Location**: `src/config.ts`, `src/index.ts`, `test/config.test.ts`
- **Description**: Watch the configuration file with `fs.watch`, debounce editor-generated event bursts, reload/validate into a new snapshot, then swap the snapshot only on success. Log the reload result. Treat file replacement/rename events robustly by re-establishing the watcher if needed.
- **Dependencies**: Task 2.1.
- **Acceptance Criteria**:
  - Initial load failures terminate startup.
  - Reload failures preserve the currently active snapshot.
  - A scheduler check reads one captured snapshot for its full run, preventing a partial config change from affecting one campaign check.
- **Validation**: Tests for successful replacement and invalid replacement; manual edit test while `npm run dev` is running.

## Sprint 3: WhatsApp Transport and Authentication

**Goal**: A narrow transport wrapper pairs once, restores its session, sends text, and reconnects.

**Demo/Validation**:

- The first run displays a scannable QR code and creates `auth/`.
- A restart reconnects without QR while credentials are valid.
- The scheduler only uses a transport interface, not Baileys types.

### Task 3.1: Implement the small WhatsApp client wrapper

- **Location**: `src/whatsapp.ts`
- **Description**: Export the conceptual `WhatsAppClient` interface and its Baileys implementation. Load authentication with `useMultiFileAuthState('auth')`, create the socket, subscribe to `creds.update` and call `saveCreds`, and expose `connect`, `sendMessage`, `isConnected`, and `disconnect` for shutdown.
- **Dependencies**: Task 1.1.
- **Acceptance Criteria**:
  - `sendMessage(phone, message)` normalizes the configured digits to a WhatsApp user JID (`<phone>@s.whatsapp.net`) internally and calls `sock.sendMessage(jid, { text: message })`.
  - Baileys details do not leak into scheduler/config modules.
  - Sensitive credential values are never logged.
- **Validation**: Unit test JID normalization and mock the interface in scheduler tests; manually pair an account.

### Task 3.2: Implement QR, connection state, and reconnection behavior

- **Location**: `src/whatsapp.ts`, `src/index.ts`
- **Description**: Handle `connection.update`: let the current Baileys terminal QR option render the first-login QR, mark connection open/closed, and reconnect after unexpected closes. Do not retry after `DisconnectReason.loggedOut`; log an explicit instruction to remove/re-pair `auth/` only when the operator chooses to do so.
- **Dependencies**: Task 3.1.
- **Acceptance Criteria**:
  - Temporary connection loss does not exit the process.
  - Concurrent reconnect attempts are coalesced; shutdown suppresses reconnects.
  - Initial application startup waits for a connected client before its first campaign check.
- **Validation**: Simulated `connection.update` tests/mocks and manual network interruption test.

## Sprint 4: Timezone-Aware Scheduler

**Goal**: Campaign occurrences are selected deterministically, including restart behavior and midnight-crossing windows.

**Demo/Validation**:

- A campaign due at the latest valid occurrence sends once per recipient.
- A 22:00–02:00 interval campaign selects its correct overnight occurrences.
- Repeated scheduler checks do not duplicate successful sends.

### Task 4.1: Build pure schedule-occurrence helpers

- **Location**: `src/scheduler.ts`, `test/scheduler.test.ts`
- **Description**: Use `Intl.DateTimeFormat(..., { timeZone })` to obtain the current local date and time. Given a campaign and "now", return either no occurrence or its most recent applicable local occurrence key. Keep this pure and independent of WhatsApp.
- **Dependencies**: Task 2.1.
- **Acceptance Criteria**:
  - Interval windows include both endpoints and generate `start + n * intervalMinutes` only while within the window.
  - Normal windows are eligible only from `start` through `end`; a process beginning after `end` does not send an old occurrence.
  - Crossing-midnight windows are treated as one anchored window: after midnight through `end` belongs to the prior calendar date; before `start` and after `end` has no occurrence.
  - Specific-time schedules select the latest listed time at or before the current local time, never backfilling a prior calendar day.
  - Keys include campaign ID, contact ID, timezone-local schedule date, and `HH:mm`, preventing duplicates across days and supporting same campaign IDs after config reload.
- **Validation**: Tests cover `08:00`, `08:01`, `08:30`, `09:00`, `09:01`, `21:59`, `22:00`, `22:01`, plus an overnight window before/after midnight.

### Task 4.2: Implement isolated campaign delivery and retry semantics

- **Location**: `src/scheduler.ts`, `test/scheduler.test.ts`
- **Description**: Implement `checkCampaigns(snapshot, client)`. Skip disabled/not-due campaigns; resolve recipients from the snapshot; send each recipient independently. Maintain a process-local `Set` of successful occurrence keys.
- **Dependencies**: Task 4.1, Task 3.1.
- **Acceptance Criteria**:
  - A key is added only after the corresponding `sendMessage` resolves.
  - A failure is logged and that recipient is retried in the next interval; other recipients/campaigns continue.
  - Successful sends remain deduplicated after a config reload in the same process.
  - A process restart has an empty set and sends at most the latest applicable current occurrence, not every missed occurrence.
- **Validation**: Mock client tests for disabled/out-of-window campaigns, 60/30-minute intervals, specific times, recipient fan-out, one-recipient failure, and deduplication.

### Task 4.3: Add scheduler loop and overlap protection

- **Location**: `src/scheduler.ts`, `src/index.ts`
- **Description**: Add a small `startScheduler`/`stopScheduler` wrapper with a single `running` guard. Invoke the first check after WhatsApp is connected, then create one interval using the active config's `checkIntervalSeconds`. When reload changes the interval, replace the timer after the current check completes or safely before the next tick.
- **Dependencies**: Tasks 2.2 and 4.2.
- **Acceptance Criteria**:
  - No cron or `node-cron` usage.
  - An overlapping tick logs/skips rather than starting a second send pass.
  - Reloading `checkIntervalSeconds` changes future cadence without restarting the process.
- **Validation**: Fake-timer or controlled test verifies immediate check, no overlap, clean stop, and interval reconfiguration.

## Sprint 5: Application Lifecycle, Operations, and Documentation

**Goal**: The bot can run unattended as a maintainable systemd service.

**Demo/Validation**:

- `npm start` produces concise lifecycle logs.
- SIGTERM stops future scheduling, closes WhatsApp, and exits cleanly.
- The README takes an operator from install through service logs.

### Task 5.1: Compose the process entry point and graceful shutdown

- **Location**: `src/index.ts`
- **Description**: Sequence startup: load config, report contact/campaign counts, create/connect client, run immediate check, start the scheduler, then attach `SIGINT`/`SIGTERM`. On shutdown, mark the app as stopping, stop config watcher/timer, wait for an active check to complete within a bounded policy, disconnect, and exit with a meaningful status.
- **Dependencies**: Tasks 2.2, 3.2, 4.3.
- **Acceptance Criteria**:
  - No new sends begin after shutdown starts.
  - Logs include config load/reload, connection state, check/due decisions, send success/failure, and shutdown; they omit credentials.
- **Validation**: Run locally, signal the process, and ensure no active interval remains.

### Task 5.2: Document installation, configuration, and systemd deployment

- **Location**: `README.md`
- **Description**: Explain Node 20 installation prerequisite, `npm install`, dev/build/start/test commands, first QR pairing, session persistence, editing/reloading `config.json`, logs, known retry behavior, and the full configuration example requested. Include a `whatsapp-bot.service` example using `/opt/whatsapp-bot`, `User=pi`, `Restart=always`, and `After=network-online.target`, plus `daemon-reload`, enable/start, status, and `journalctl -u whatsapp-bot -f` commands.
- **Dependencies**: Task 5.1.
- **Acceptance Criteria**:
  - The service runs compiled `dist/index.js` from a directory writable by `pi`, including `auth/`.
  - The README states that Baileys connects through WhatsApp Web and that account/platform policies may affect operation.
- **Validation**: Follow the README on a clean Raspberry Pi or equivalent Node 20 environment.

## Testing Strategy

- Use native `node:test` and `node:assert`; keep tests focused on configuration and scheduling, with the transport mocked.
- Treat scheduling helpers as pure functions using an injected `Date`, so tests never depend on the host timezone or wall clock.
- Test configuration failures: malformed JSON, duplicate contacts/campaigns, unknown recipients, invalid time/timezone, invalid interval, and mixed/empty schedules.
- Test schedule boundaries, restart selection, cross-midnight anchoring, no duplicate success, partial recipient failure/retry, and no scheduler overlap.
- Manually verify QR pairing, restored session, temporary disconnect reconnection, terminal/service shutdown, and a real text send only to opted-in personal test contacts.

## Potential Risks & Gotchas

- **WhatsApp policy/account risk**: Baileys is an unofficial WhatsApp Web protocol client; use only a personal account and opted-in recipients, avoid abusive bulk messaging, and expect platform changes can affect connectivity.
- **At-least-once retry behavior**: A network failure after WhatsApp accepted a send but before the client receives confirmation can cause a later retry and a duplicate. Without persistent delivery state, exactly-once delivery cannot be guaranteed; this is the intentional tradeoff for the requested retry behavior.
- **Reload during manual file editing**: Editors may briefly write incomplete JSON. Debounced, validate-then-swap reloading keeps the last valid campaign set active.
- **Auth storage**: Baileys documents `useMultiFileAuthState` as a simple local-file helper. It matches this personal, Raspberry Pi-only design; secure directory permissions and backups of `auth/` are still appropriate.
- **Timezone/DST**: Schedule calculations use IANA timezone local calendar parts, not UTC. On daylight-saving transitions in arbitrary configured timezones, repeated/nonexistent wall-clock times should be logged and treated according to the normal latest-occurrence/deduplication key rules.
- **Systemd permissions**: If `WorkingDirectory` or `auth/` is owned by another user, sessions cannot be saved and pairing will repeat. Create/chown the deployment directory for the service user.

## Rollback Plan

- Stop and disable the systemd unit: `sudo systemctl stop whatsapp-bot` and, if required, `sudo systemctl disable whatsapp-bot`.
- Restore a prior code release and its matching `package-lock.json`, run `npm ci` and `npm run build`, then restart the service.
- Keep `auth/` when rolling back to retain the linked session. Remove it only deliberately when re-pairing is required.
- Restore the prior valid `config.json`; the live reload controller already keeps it active when a newly edited configuration fails validation.
