# Northstar — CEO Agent Chat (Design)

> Reference: xrehpicx/vector (cloned to /Users/zex/Others/Prod/vector, 2026-04-24).

## One-line summary

Per-company chat where the user talks to a single CEO agent. The CEO speaks in first person *as* the company's chief executive, knows everything about the selected company, coordinates sub-agents, and acts via tools — it is the product's identity layer, not an assistant-on-the-side.

## Key Vector patterns we adopt

1. **Identity, not agency.** Vector's system prompt says "You ARE the Vector platform, not a separate AI." Northstar's CEO prompt says "You ARE the CEO of {company}, not an assistant." First-person voice; the agent acts, then reports.
2. **Fresh context injection every turn.** Vector recomputes page/user/device context per message and stuffs it into the system prompt. No RAG, no embeddings. Northstar does the same with company/agent-roster/approvals/goals/issues state.
3. **One agent per thread, flat tool registry.** Vector has a single `assistantAgent` with ~26 tools; no sub-agent dispatch mechanism — tools are the delegation layer. Northstar ships with `send-to-agent` as a tool rather than routing between multiple agent runtimes.
4. **Streaming with mid-stream persistence.** Vector saves deltas as they stream. We use SSE via Cloudflare Workers and persist the final assistant message atomically at stream-end (D1 doesn't have ergonomic partial-row updates; a crash mid-stream drops the turn — acceptable for v1).
5. **Side-effects decoupled from the agent.** Vector pends destructive actions in `assistantActions` and lets the client poll + confirm. TaskCenter already does this via `assistant_pending_actions` — we piggyback on it.

## Where Northstar diverges from Vector

| Concern | Vector | Northstar |
|---|---|---|
| Org model | one workspace = one agent | one **company** = one CEO agent (user may have many) |
| Agent routing | single `assistantAgent` | single `ceoAgent` per company, **plus** sub-agents (executor/operator/reviewer/planner from `company_agents`) that can post into the CEO thread |
| Transport | Convex real-time subscriptions | Cloudflare SSE |
| Persistence | Convex agent SDK tables | existing `assistant_threads` + `assistant_messages` + `assistant_message_parts` |
| Tool runtime | `@convex-dev/agent` tools | Vercel AI SDK `tools` arg to `streamText` (via existing `streamTenantAiText`) |

## The thread model

- **One canonical Northstar thread per (user, company)**. Resolved by `SELECT id FROM assistant_threads WHERE tenant_id=? AND company_id=? AND owner_user_id=? AND title='Northstar' LIMIT 1`; created on first access via `createAssistantThread({title:'Northstar', companyId, visibility:'private'})`.
- Singleton for v1. A later phase can add "new conversation" / history browsing.
- Switching the selected company in the sidebar changes which thread is loaded. Thread state lives on the server — the UI just resolves `GET /api/northstar/:companyId/thread`.

## The CEO system prompt

Composed fresh every turn by `buildCeoSystemPrompt(env, tenantId, companyId)`:

```
You ARE the Chief Executive Officer of {companyName}. Not an assistant.
Not a chatbot. You ARE the person responsible for this company.

You answer directly to the founder (the user you are talking to).
When they ask about priorities, shipping, blockers — speak in first person:
"I'm prioritizing X" not "The company prioritizes X."

Your team:
{agentRoster — role/title/description for each company_agents row except the CEO row itself}

When a message is tagged [Agent Report · {role}], it is a sub-agent reporting
up to you. Fold it into your next response — do not re-quote it verbatim.

Current state:
- Active projects: {name, status, progress%}
- Open goals: {title, status}
- Pending approvals (awaiting your call): {title, kind}
- Recent activity (last 10): {timestamp · type · subject}

Act, don't narrate. If the user asks you to create an issue, assign work,
or spin up an execution — use the available tools. Report what you did in
one sentence. When you don't have the authority or the evidence, say so
and name the missing piece.
```

**Not injected** (v1): full project READMEs, repo file trees, vector-memory retrieval. The prompt stays under ~2k tokens.

## Sub-agents → CEO

A new endpoint `POST /api/northstar/:companyId/agent-report` lets any agent post into the CEO thread as a sub-agent message:

```json
{ "agentRoleKey": "operator", "agentName": "Repo Ops", "message": "Landing-page PR merged." }
```

The backend inserts a row into `assistant_messages` with `role='assistant'`, `content` prefixed `[Agent Report · operator] ...`, and metadata `{reportedBy: agentId}`. On the next user turn, the CEO agent sees the tagged message in history context and can reference it.

**v1 scope**: only authenticated tenant users can call this endpoint (auth via existing session). A "service-account token" for headless sub-agent runners is deferred.

## Tool set for v1

Reuse the existing `chat-tools.ts` registry (createTask, assignTask, createEpic, startExecution, retrieveMemory, searchProject, listTasks, getIssue, checkIntegrations) unchanged. The CEO agent has the same tools as the current assistant — the difference is persona + scoping.

Explicitly **not** in v1:
- Slash commands (`/issue`, `/goal`, etc.) — Vector demonstrates natural language suffices.
- Confirmation modals — inline cards for pending actions are enough for v1.
- Multi-turn tool-use with branching — existing `assistant_pending_actions` covers the destructive case.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/northstar/:companyId/thread` | resolve (or create) the CEO thread; return `{thread, messages}` |
| POST | `/api/northstar/:companyId/thread/messages` | post user message, stream CEO reply as SSE |
| POST | `/api/northstar/:companyId/agent-report` | sub-agent posts report into CEO thread |

All three require tenant session; all enforce `companyId` belongs to the tenant via `ensureCompanyExists`.

## UI surface

- New company-scoped route `/:companyPrefix/northstar` in `App.tsx` `boardRoutes()`.
- New page `ui/src/pages/Northstar.tsx` — full-screen layout, reads `selectedCompanyId` from `useCompany()`, calls `GET /thread` on mount, renders messages via `MarkdownBody`, streams new replies via `fetch` + `ReadableStream` reader (no `EventSource` — `EventSource` can't send cookies cross-origin reliably; we use `fetch` with `credentials:'include'`).
- New sidebar entry `<SidebarNavItem to="/northstar" icon={Sparkles} label="Northstar" />` at the top of `Sidebar.tsx`.
- New API client `ui/src/api/northstar.ts` with `getThread(companyId)`, `sendMessage(companyId, message, onDelta)`, `postAgentReport(companyId, payload)`.

## Non-goals (v1)

- Compact-mode toggle (Phase 6 — separate).
- Thread history / "new conversation" — singleton for now.
- Sub-agent service accounts / headless callers.
- Rich tool-call cards (proposal diff viewer, approval modals) — reuse existing Paperclip renderers where they exist; fall back to plain text otherwise.
- Voice input.

## Risks

1. **Singleton thread grows unbounded.** Context-window bloat as the thread ages. Mitigation: existing `summarizeNorthstarHistory` compresses recent history; the CEO prompt sends last N turns explicitly.
2. **Stream interruption drops the assistant turn.** D1 lacks partial-row append; we persist only at stream completion. A client-side "resend on resume" is a follow-up.
3. **CEO persona bleed.** If the CEO prompt leaks into other assistant threads (non-Northstar ones), responses drift. Mitigation: CEO persona is opt-in only through `routes/northstar.ts` — the default assistant pipeline is untouched.

## Verification checklist

1. Sign in → create a company → open Northstar from sidebar → thread auto-creates.
2. Send "What should I prioritize today?" → receive first-person CEO answer referencing the company's active projects.
3. Switch selected company in sidebar → Northstar loads a different thread with different context.
4. POST to `/agent-report` with a fake sub-agent message → next user turn, the CEO answer folds it in.
5. Send "Create an issue called X for project Y" → existing tool pipeline creates it; CEO confirms in one sentence.
