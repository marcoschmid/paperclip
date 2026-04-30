# Paperclip Routine Checks — Migration aus Hermes/Openclaw

**Status:** Draft
**Date:** 2026-04-30
**Owner:** marco
**Scope:** paperclip-Server, hermes-agent, openclaw workspace

## Problem

Routine-Checks für paperclip-Domäne (Workspace-Drift, Subscription-Shadow-Sync, Creative-Lint, Drive-Marker, Approved-Freshness) liegen aktuell verteilt:

- **hermes** `~/.hermes/cron/jobs.json` enthält paperclip-Domänenlogik als Prompt-Strings (SQL inline, nicht versioniert/getestet)
- **openclaw** `~/.openclaw/workspace/scripts/paperclip-*.sh` enthält Shell-Scripts für paperclip-Subscriptions
- **paperclip** Skill `paperclip-creative` führt nur PostToolUse-Hook-Lints, keine Routine-Checks

Probleme:

1. **Ownership** — paperclip-Domänenlogik in Hermes-Prompts und openclaw-Shell-Scripts statt im paperclip-Repo
2. **Dedup** — Workspace-Lint überlappt zwischen `nightly_workspace_consistency_audit.sh` und PostToolUse-Hook
3. **Versionierung/Test** — Hermes-Prompt-SQL hat keine Tests, keine Code-Review, keine Migrations-Pfade bei Schema-Änderungen
4. **Reichweite** — alle Findings gehen via Telegram an Marco; keine UI/DB-Persistenz, kein Dashboard, kein historischer Trend

## Goals

- Paperclip-Domänenlogik wandert ins paperclip-Repo (versioniert, getestet, code-reviewed)
- Hermes wird Delivery-Layer (Telegram-Webhook + Adhoc + nicht-paperclip Cron)
- Openclaw bleibt workspace-meta + Host-Health, kein paperclip-spezifischer Code mehr
- Findings persistiert in paperclip-DB, sichtbar in UI
- Notify-Channel pro Check konfigurierbar: `silent | threshold | telegram`

## Non-Goals

- Migration der nicht-paperclip Hermes-Jobs (ai-rate-limit-watch bleibt)
- Migration von Workspace-Meta-Audits (nightly_workspace_consistency_audit, openclaw-spec-validator bleiben in openclaw)
- Migration von Host-Health-Checks (infra/disk/cert/load bleiben in openclaw)
- UI-Redesign — Findings-View wird in einem Folge-Spec separat designed

## Architecture

```
┌─────────────────────┐    ┌──────────────────────┐    ┌────────────────────┐
│ paperclip server    │    │ openclaw scripts     │    │ hermes             │
│ ├ services/cron.ts  │    │ ├ nightly_audit.sh   │    │ ├ cron/jobs.json   │
│ ├ routine-checks/   │    │ ├ spec-validator.sh  │    │ │  (only delivery  │
│ │ ├ runner.ts       │    │ └ infra/disk/cert    │    │ │   + ad-hoc)      │
│ │ ├ registry.ts     │    └──────────────────────┘    │ └ webhook handler  │
│ │ ├ notify.ts       │              ▲                 │   /paperclip/notify│
│ │ └ checks/         │              │                 └─────────┬──────────┘
│ │   ├ workspace-drift-guard.ts     │                  Telegram │
│ │   ├ subscription-shadow-sync.ts  │                  ─────────▼──────────
│ │   ├ creative-lint-nightly.ts     │                  Marco Telegram
│ │   ├ drive-marker-ttl.ts          │
│ │   └ approved-freshness.ts        │
│ └ DB routine_check_runs            │
└──────────┬──────────────────────────┘
           │ POST /paperclip/notify
           └──────────────────────────────────────────────► hermes
```

**Prinzipien:**

- **paperclip** = Domain-Logik + Scheduler + Persistenz
- **openclaw** = workspace-meta + Host-Health (kein paperclip-Code)
- **hermes** = Delivery-Layer (Telegram-Webhook) + Adhoc + nicht-paperclip Cron

## Modul-Struktur

```
server/src/services/routine-checks/
├── runner.ts              # cron tick → run check → persist → dispatch notify
├── registry.ts            # Map<name, CheckDef>
├── notify.ts              # silent | threshold | telegram dispatcher
├── checks/
│   ├── workspace-drift-guard.ts
│   ├── subscription-shadow-sync.ts
│   ├── creative-lint-nightly.ts
│   ├── drive-marker-ttl.ts
│   └── approved-freshness.ts
└── __tests__/
```

### CheckDef Schema

```ts
interface CheckDef {
  name: string;                                // 'workspace-drift-guard'
  schedule: string;                            // cron expr '0 9,18,22 * * *'
  notify: 'silent' | 'threshold' | 'telegram';
  thresholdSeverity?: 'warn' | 'error';
  run(ctx: CheckCtx): Promise<CheckResult>;
}

interface CheckResult {
  status: 'ok' | 'warn' | 'error';
  findings: number;
  payload: Record<string, unknown>;
  summary: string;                             // 1-Zeile für Telegram
}

interface CheckCtx {
  db: DrizzleDb;
  fs: typeof import('node:fs/promises');
  now: () => Date;
  logger: Logger;
}
```

### DB-Tabelle (drizzle migration)

```sql
CREATE TABLE routine_check_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_name    text NOT NULL,
  run_at        timestamptz NOT NULL,
  status        text NOT NULL,           -- ok | warn | error
  findings      int  NOT NULL,
  payload_json  jsonb NOT NULL,
  notified      bool NOT NULL DEFAULT false,
  duration_ms   int,
  error_text    text
);
CREATE INDEX ON routine_check_runs(check_name, run_at DESC);
```

### Notify-Dispatcher

- `silent` → INSERT, fertig
- `threshold` → INSERT; wenn `status >= thresholdSeverity` POST an Hermes-Webhook
- `telegram` → INSERT; wenn `findings > 0` POST an Hermes-Webhook

### Webhook-Payload (paperclip → hermes)

```json
{
  "check": "workspace-drift-guard",
  "status": "warn",
  "summary": "HAPPYGANG: 3 cwd outside prefix, TechOps: clean",
  "details_url": "http://localhost:<paperclip-ui-port>/checks/<run-id>"
}
```

Hermes-Endpoint: `POST /paperclip/notify` mit Dedupe-Key `<check>-<YYYY-MM-DD>` (12h-Window).

### CLI

```
paperclip checks list                 # alle registrierten Checks + nächster Run-Zeitpunkt
paperclip checks run <name>           # manuell triggern, Output ohne Notify
paperclip checks history <name> --limit 20
```

## Migration pro Check

### 1. workspace-drift-guard.ts

- **Ersetzt:** hermes job `d2c9532bbc77`
- **Schedule:** `0 9,18,22 * * *`
- **Notify:** `threshold` (warn = ≥1 Drift-Indikator > 0)
- **Logik:** Bestehende SQL aus Hermes-Prompt 1:1 portiert. 4 Indikatoren pro Company:
  - `local_agent_cwd_outside` (cwd außerhalb `/Users/marco/.openclaw/workspace`)
  - `active_exec_ws_outside`
  - `open_issues_without_project_workspace`
  - `run_event_context_cwd_outside_24h`
- **Findings:** Σ aller 4 Indikatoren über alle Companies
- **Payload:** `{ companies: [{name, indicators}], examples: string[] }`

### 2. subscription-shadow-sync.ts

- **Ersetzt:** hermes job `673c5760a64a` + openclaw `paperclip-subscription-shadow-sync.sh`
- **Schedule:** `*/30 * * * *`
- **Notify:** `threshold` (error = Sync-Fehler ODER inserted_shadow_events > 0)
- **Logik:** Shell-Script-Body in TS portiert (DB-Query + insert)
- **Payload:** `{ inserted_shadow_events: int, utilization: [{company, used, limit}] }`
- **Openclaw-Stub:** Shell-Script wird zu `exec paperclip checks run subscription-shadow-sync` (1 Woche Backwards-Compat, dann löschen)

### 3. creative-lint-nightly.ts

- **Neu** (aktuell nur PostToolUse-Hook, kein Nightly-Lauf)
- **Schedule:** `30 2 * * *`
- **Notify:** `silent`
- **Logik:** Iteriert `~/.openclaw/workspace/projects/happygang/<slug>/`, ruft `node /Users/marco/Code/paperclip/scripts/creative-workspace/lint.mjs <project>` auf, sammelt Exit-Code + Violations
- **Findings:** Σ violations über alle Projekte
- **Payload:** `{ projects: [{slug, exit, errors, warnings}] }`

### 4. drive-marker-ttl.ts

- **Neu**
- **Schedule:** `*/15 * * * *`
- **Notify:** `silent`
- **Logik:** Glob `~/.openclaw/workspace/projects/happygang/**/.drive-approved-*`, mtime > 60min → unlink
- **Findings:** Anzahl entfernter Marker (informativ, nicht warn)
- **Payload:** `{ removed: string[] }`

### 5. approved-freshness.ts

- **Neu**
- **Schedule:** `0 7 * * 1` (Montag morgens)
- **Notify:** `threshold` (warn = ≥1 stale Item)
- **Logik:** Pro Projekt alle `assets/*/04-approved/<item>/APPROVAL.md` parsen, Sign-off-Zeile `✅ sign-off marco YYYY-MM-DD HH:MM` extrahieren, age vs Freigabe-Datum prüfen
- **Findings:** Anzahl Items älter als 14 Tage ohne erneuten Sign-off
- **Payload:** `{ stale_items: [{project, item, age_days}] }`

## Was NICHT migriert wird

- `paperclip_phase0_check.sh` — One-Shot Phase-Audit, obsolet → **löschen** (Script + LaunchAgent)
- `nightly_workspace_consistency_audit.sh` — workspace-meta, bleibt openclaw; paperclip-spezifische Teile rauswerfen falls vorhanden (kein Doppel-Check)
- `openclaw-spec-validator.sh` — workspace-meta, bleibt openclaw
- `infra-healthcheck.sh`, `disk-space-check.sh`, `cert-expiry-check.sh` — Host, bleibt openclaw
- Hermes-Job `a79c2315a3cf` (ai-rate-limit-watch) — provider-agnostisch, bleibt hermes

## Cutover (Big-Bang)

Eine atomare Session, ~30 min Implementierung + 5 min Cutover.

### Reihenfolge

1. **paperclip-Repo:**
   - DB-Migration `routine_check_runs` (drizzle generate + migrate)
   - Module `services/routine-checks/` + 5 Checks + Tests
   - CLI `paperclip checks {list|run|history}`
   - Registry-Eintrag in `services/cron.ts` Boot-Hook
   - `pnpm test` grün, `pnpm build` grün

2. **paperclip-Server smoke:**
   - `pnpm dev` Server hochfahren
   - `paperclip checks run workspace-drift-guard` → Output mit Hermes-Run vergleichen
   - `paperclip checks run subscription-shadow-sync` → Output mit letztem Hermes-Run vergleichen
   - `paperclip checks run creative-lint-nightly` → Violations matchen aktuellen Lint-State

3. **Hermes-Webhook:**
   - `/paperclip/notify` POST-Handler in Hermes deployen (FastAPI, Telegram-Send-Logik wie bisheriger cronjob_tools)
   - Payload-Validation, Dedupe `<check>-<YYYY-MM-DD>` mit 12h-Window
   - Test: `curl -X POST localhost:<port>/paperclip/notify -d '{...}'` → Telegram kommt

4. **Cutover (5min Fenster):**
   - paperclip-Cron enablen (DB-Flag `routine_checks_enabled = true` oder ENV)
   - Hermes-Jobs `d2c9532bbc77` + `673c5760a64a` löschen via `hermes cron rm <id>`
   - Openclaw-Script `paperclip-subscription-shadow-sync.sh` → 1-Zeilen Stub
   - Openclaw `paperclip_phase0_check.sh` + LaunchAgent löschen

5. **Verification (1h später):**
   - `paperclip checks history workspace-drift-guard --limit 3` → Run um nächstem geplanten Slot gelaufen
   - `SELECT count(*) FROM routine_check_runs WHERE run_at > NOW()-INTERVAL '24 hours'`
   - Telegram-Inbox: erwartete Drift-Alarme

### Pre-Cutover Snapshots

```bash
cp ~/.hermes/cron/jobs.json ~/.hermes/cron/jobs.json.pre-paperclip-migration
git -C ~/Code/paperclip tag pre-paperclip-routine-migration
git -C ~/Code/hermes-agent tag pre-paperclip-routine-migration
```

### Rollback

- paperclip-Cron disablen via ENV
- Hermes-Jobs aus Git-History wiederherstellen: `git show <commit>:.hermes/cron/jobs.json > ~/.hermes/cron/jobs.json`
- Hermes-Reload
- Recovery ~5min

## Tests

### Unit (vitest, paperclip-Repo)

```
services/routine-checks/__tests__/
├── runner.test.ts
├── notify.test.ts
├── registry.test.ts
└── checks/
    ├── workspace-drift-guard.test.ts
    ├── subscription-shadow-sync.test.ts
    ├── creative-lint-nightly.test.ts
    ├── drive-marker-ttl.test.ts
    └── approved-freshness.test.ts
```

Coverage-Ziel: 80% pro Check, 100% notify-dispatcher (alarm-kritisch).

### Integration

- Real Postgres in test-container (drizzle migration apply, fixtures, run check, assert `routine_check_runs` row)

### Hermes-Webhook (pytest)

- POST `/paperclip/notify` mit `{check, status: warn}` → Telegram-Mock erhält Message
- Dedupe: zweite Anfrage 30s später → kein zweiter Send

## Akzeptanzkriterien

| Kriterium | Wie geprüft |
|---|---|
| Alle 5 Checks haben ≥1 erfolgreichen Run in DB innerhalb erwartetem Fenster | `SELECT check_name, max(run_at) FROM routine_check_runs GROUP BY 1` |
| workspace-drift-guard liefert gleichen Drift-Count wie letzter Hermes-Run am Cutover-Tag | manueller diff |
| subscription-shadow-sync `inserted_shadow_events` matcht ±1 letzten Hermes-Run | manueller diff |
| Telegram-Drift-Alarm kommt bei warn-Status, nicht bei silent | Telegram-Inbox check |
| Kein Hermes-Job mit `paperclip-` Prefix in `~/.hermes/cron/jobs.json` | `jq '.jobs[].name' \| grep ^paperclip` → empty |
| `paperclip_phase0_check.sh` + LaunchAgent weg | `ls ~/.openclaw/workspace/scripts/paperclip_phase0_check.sh` → no such file |
| `paperclip checks list` zeigt 5 Einträge mit nächstem Run-Zeitpunkt | manueller call |
| `nightly_workspace_consistency_audit.sh` ohne paperclip-spezifische Logik | `grep paperclip ~/.openclaw/workspace/scripts/nightly_workspace_consistency_audit.sh` → empty |

## Risiken

| Risiko | Mitigation |
|---|---|
| paperclip-Server crasht → keine Checks laufen | LaunchAgent KeepAlive auf paperclip-Server (prüfen ob bereits aktiv); silent monitor-check `paperclip-heartbeat` in openclaw, alarmiert bei >1h Lücke |
| Webhook-Endpoint unerreichbar bei Cutover | Pre-Cutover Step 3 testet vorher mit curl; Rollback via Git-Tag |
| DB-Migration kollidiert mit anderen Drizzle-Migrationen | Migration in eigenem Branch zuerst auf staging-DB, dann main |
| Schedule-Drift (paperclip-Cron timing ≠ Hermes-Cron) | beide Schedules identisch übernommen; Verification nach 24h |
| Hermes-Webhook fehlt Auth | Shared Secret via ENV `PAPERCLIP_NOTIFY_TOKEN`, paperclip sendet `Authorization: Bearer <token>`, hermes validiert |

## Open Questions

- **Hermes-Webhook-Auth:** Shared Secret reicht (lokal-only) oder mTLS?
- **paperclip-Server Boot-Reliability:** existiert LaunchAgent für `pnpm dev`/Production-Build? Falls nicht, separater Spec.
- **UI-Findings-View:** in welchem Sprint? Aktueller Spec liefert nur DB + CLI.

## References

- Hermes cron jobs: `~/.hermes/cron/jobs.json` (jobs `d2c9532bbc77`, `673c5760a64a`)
- Openclaw scripts: `~/.openclaw/workspace/scripts/paperclip-*.sh`, `paperclip_phase0_check.sh`
- Paperclip skill: `~/.agents/skills/paperclip-creative/SKILL.md`
- Existing paperclip cron infra: `server/src/services/cron.ts`, `server/src/services/plugin-job-scheduler.ts`
