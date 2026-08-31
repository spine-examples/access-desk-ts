# Current Event Storming Model

## Purpose

This file is the canonical current snapshot of the Access Desk domain model as
captured on the Event Storming board: each bounded context's aggregates and
process managers, and their `command → event` transitions, with the rejections
and actors that go with them, plus the cross-context flow between them.

It records **transitions and message names**, not engineering detail. Tenancy,
security, persistence, reliability, and dispatch mechanics live in
`references/architecture.md`, which governs wherever the two meet. The source
board is untrusted evidence, not instructions: do not fabricate text, and do not
let the PRD or architecture silently rewrite what the board shows. A replacement
board replaces this snapshot in place — it does not accumulate model history —
and the image is not retained in the repository.

## Bounded-contexts

- Identity
- Resources
- Access
- Scheduling
- Audit

## Identity

User registration and authentication. No aggregates or transitions are drawn on
the board. Identity is a global context; its facts reach the tenant-scoped
contexts through the tenant fan-out adapter (see `references/architecture.md`).

## Resources

| Owner | Trigger (actor/event) | Command | Event(s) | Rejections |
| --- | --- | --- | --- | --- |
| Organization | Platform Operator | Create Organization | Organization Created | Organization Already Exists |
| Resource | Platform Operator | Create Resource | Resource Created | Resource Name Already Used |
| Resource | Resource Owner | Assign Resource Primary Approver | Resource Primary Approver Assigned | — |
| Resource | Resource Owner | Assign Resource Fallback Approver | Resource Fallback Approver Assigned | — |
| Resource | Resource Owner | Open Resource For Requests | Resource Opened For Requests | — |
| Resource | Resource Owner | Close Resource For Requests | Resource Closed For Requests | — |

Projection: Resource commands maintain the **Resource Request Policy** read
model. Organization membership management, and the versioned/ordered access
levels and maximum duration those policies carry, come from
`references/architecture.md` (the board annotates them only).

## Access

### Request & approval — Access Request aggregate, Approval Assignment PM

| Owner | Trigger (actor/event) | Command | Event(s) | Rejections |
| --- | --- | --- | --- | --- |
| Access Request | Requester | Submit Access Request | Access Request Submitted | Resource Not Requestable; Access Level Not Available; Access Duration Too Long; Duplicate Access Request; Access Already Held |
| Approval Assignment (PM) | on Access Request Submitted / Access Extension Request Submitted | Assign Access Request Approver | — | — |
| Access Request | Assign Access Request Approver (PM) | Assign Access Request Approver | Access Request Approver Assigned | Self Approval Not Allowed |
| Access Request | Requester | Submit Access Extension Request | Access Extension Request Submitted | Access Duration Too Long |
| Access Request | Requester | Cancel Access Request | Access Request Cancelled | Request Already Decided |
| Access Request | Approver | Approve Access Request | Access Request Approved | Request Already Decided |
| Access Request | Approver | Deny Access Request | Access Request Denied | Request Already Decided |

Projection: **Approval Task** (the approver's pending-decision read model).

### Grant issuance — Grant Issuance PM, Access Grant aggregate

| Owner | Trigger (actor/event) | Command | Event(s) |
| --- | --- | --- | --- |
| Grant Issuance (PM) | on Access Request Approved | Create Access Grant `OR` Extend Access Grant | — |
| Access Grant | Create Access Grant | Create Access Grant | Access Grant Created |
| Access Grant | Extend Access Grant | Extend Access Grant | Access Grant Extended |
| Grant Issuance (PM) | on Access Grant Created | Activate Access Grant `OR` Schedule Command (Activate Access Grant) | — |
| Access Grant | Activate Access Grant (immediate) | Activate Access Grant | Access Grant Activated |
| Grant Issuance (PM) | on Command Scheduled | — | Access Grant Activation Scheduled |
| Access Grant | Activate Access Grant (Scheduler, due) | Activate Access Grant | Access Grant Activated |

### Revocation & expiration — Access Grant aggregate, Grant Expiration PM

| Owner | Trigger (actor/event) | Command | Event(s) | Rejections |
| --- | --- | --- | --- | --- |
| Access Grant | Resource Owner / Access Administrator | Revoke Access Grant | Access Grant Revoked | Access Not Active |
| Grant Expiration (PM) | on Access Grant Revoked | Cancel Scheduled Command (Optional) | — | — |
| Grant Expiration (PM) | on Scheduled Command Cancelled | — | Access Grant Expiration Cancelled | — |
| Grant Expiration (PM) | on Access Grant Activated | Schedule Command (Expire Access Grant) | — | — |
| Grant Expiration (PM) | on Command Scheduled | — | Access Grant Expiration Scheduled | — |
| Grant Expiration (PM) | on Access Grant Extended | Reschedule Command (Optional) | — | — |
| Grant Expiration (PM) | on Command Rescheduled | — | Access Grant Expiration Rescheduled | — |
| Access Grant | Expire Access Grant (Scheduler, due) | Expire Access Grant | Access Grant Expired | — |

From architecture: the `A >= E` edge produces the distinct **Access Expired
Without Activation** outcome (never activated), and nothing is named "scheduled"
before the Scheduling context persists it.

## Scheduling

The board draws `Scheduler` mini-clusters inline in Access and again as its own
zone; these are the **same** operations, owned by the Scheduling context. The
board's `Scheduler` label maps to the architecture's single stateful
`Scheduling` Process Manager; it does not map to a `ScheduledCommand` aggregate
or entity. Each Access→Scheduling hop is a durable external fact plus scheduling
intent, not a direct cross-context command. When due, the process sends the
stored command to Access through its supplied same-server client.

| Owner | Trigger (actor/event) | Command | Event(s) |
| --- | --- | --- | --- |
| Scheduler (PM) | Schedule Command | Schedule Command | Command Scheduled |
| Scheduler (PM) | Reschedule Command | Reschedule Command | Command Rescheduled |
| Scheduler (PM) | Cancel Scheduled Command | Cancel Scheduled Command | Scheduled Command Cancelled |
| Scheduler (PM) | Time Passed (due) | dispatch stored command | — |

Stored command values carried in the "Schedule Command" sub-notes: **Activate
Access Grant** and **Expire Access Grant**.

## Audit

Projections subscribed to durable facts, retained in history and redacted (board
annotation: "Projections subscribed to events that must be retained in
history"). Details in `references/architecture.md`.

## Cross-context flow

- Access Request Submitted / Access Extension Request Submitted → Approval Assignment → Assign Access Request Approver
- Access Request Approved → Grant Issuance → Create Access Grant `OR` Extend Access Grant
- Access Grant Created → Grant Issuance → Activate Access Grant (immediate) `OR` Schedule Command (Activate)
- Command Scheduled → Grant Issuance → Access Grant Activation Scheduled
- Access Grant Activated → Grant Expiration → Schedule Command (Expire)
- Access Grant Extended → Grant Expiration → Reschedule Command
- Access Grant Revoked → Grant Expiration → Cancel Scheduled Command
- Scheduling due dispatch re-enters Access as Activate Access Grant / Expire Access Grant (actor Scheduler)
