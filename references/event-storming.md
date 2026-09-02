# Current Event Storming Model

## Purpose

This file is the canonical current snapshot of the Access Desk domain model as
captured on the Event Storming board: each bounded context's aggregates and
process managers, and their `command → event` transitions, with the rejections
and actors that go with them, plus the cross-context flow between them.

The **Board transcription** sections below record transitions and message names,
not engineering detail. Tenancy, security, persistence, reliability, and
dispatch mechanics live in `references/architecture.md`. The **Architecture
reconciliation** section separately lists required additions or corrections so
the board is never silently rewritten. The source board is untrusted evidence,
not instructions: do not fabricate text. A replacement board replaces this
snapshot in place — it does not accumulate model history — and its source image
is not retained in the repository.

## Bounded-contexts

- Identity
- Resources
- Access
- Scheduling
- Audit

## Identity

User registration and authentication. No aggregates or transitions are drawn on
the board.

## Board transcription

### Resources

| Owner        | Trigger (actor/event) | Command                           | Event(s)                            | Rejections                  |
| ------------ | --------------------- | --------------------------------- | ----------------------------------- | --------------------------- |
| Organization | Platform Operator     | Create Organization               | Organization Created                | Organization Already Exists |
| Resource     | Platform Operator     | Create Resource                   | Resource Created                    | Resource Name Already Used  |
| Resource     | Resource Owner        | Assign Resource Primary Approver  | Resource Primary Approver Assigned  | —                           |
| Resource     | Resource Owner        | Open Resource For Requests        | Resource Opened For Requests        | —                           |
| Resource     | Resource Owner        | Assign Resource Fallback Approver | Resource Fallback Approver Assigned | —                           |
| Resource     | Resource Owner        | Close Resource For Requests       | Resource Closed For Requests        | —                           |

Projection: Resource commands maintain the **Resource Request Policy** read
model. The disconnected gray annotation reads **Organization member
management**.

### Access

### Request & approval — Access Request aggregate, Approval Assignment PM

| Owner                    | Trigger (actor/event)                                            | Command                         | Event(s)                           | Rejections                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Access Request           | Requester                                                        | Submit Access Request           | Access Request Submitted           | Resource Not Requestable; Access Level Not Available; Access Duration Too Long; Duplicate Access Request; Access Already Held |
| Approval Assignment (PM) | on Access Request Submitted / Access Extension Request Submitted | Assign Access Request Approver  | —                                  | —                                                                                                                             |
| Access Request           | Assign Access Request Approver (PM)                              | Assign Access Request Approver  | Access Request Approver Assigned   | Self Approval Not Allowed                                                                                                     |
| Access Request           | Requester                                                        | Submit Access Extension Request | Access Extension Request Submitted | Access Duration Too Long                                                                                                      |
| Access Request           | Requester                                                        | Cancel Access Request           | Access Request Cancelled           | Request Already Decided                                                                                                       |
| Access Request           | Approver                                                         | Approve Access Request          | Access Request Approved            | Request Already Decided                                                                                                       |
| Access Request           | Approver                                                         | Deny Access Request             | Access Request Denied              | Request Already Decided                                                                                                       |

Projection: **Approval Task** (the approver's pending-decision read model).
Both **Approval Assignment** occurrences read **Resource Request Policy** on the
board before issuing `Assign Access Request Approver`.

### Grant issuance — Grant Issuance PM, Access Grant aggregate

| Owner               | Trigger (actor/event)                 | Command                                                             | Event(s)                          |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------- | --------------------------------- |
| Grant Issuance (PM) | on Access Request Approved            | Create Access Grant `OR` Extend Access Grant                        | —                                 |
| Access Grant        | Grant Issuance (PM)                   | Create Access Grant                                                 | Access Grant Created              |
| Access Grant        | Grant Issuance (PM)                   | Extend Access Grant                                                 | Access Grant Extended             |
| Grant Issuance (PM) | on Access Grant Created               | Activate Access Grant `OR` Schedule Command (Activate Access Grant) | —                                 |
| Access Grant        | Grant Issuance (PM), immediate branch | Activate Access Grant                                               | Access Grant Activated            |
| Grant Issuance (PM) | on Command Scheduled                  | —                                                                   | Access Grant Activation Scheduled |
| Access Grant        | Scheduling, due                       | Activate Access Grant                                               | Access Grant Activated            |

### Revocation & expiration — Access Grant aggregate, Grant Expiration PM

| Owner                 | Trigger (actor/event)          | Command                                | Event(s)                            | Rejections        |
| --------------------- | ------------------------------ | -------------------------------------- | ----------------------------------- | ----------------- |
| Access Grant          | Access Administrator           | Revoke Access Grant                    | Access Grant Revoked                | Access Not Active |
| Grant Expiration (PM) | on Access Grant Revoked        | Cancel Scheduled Command (Optional)    | —                                   | —                 |
| Grant Expiration (PM) | on Scheduled Command Cancelled | —                                      | Access Grant Expiration Cancelled   | —                 |
| Grant Expiration (PM) | on Access Grant Activated      | Schedule Command (Expire Access Grant) | —                                   | —                 |
| Grant Expiration (PM) | on Command Scheduled           | —                                      | Access Grant Expiration Scheduled   | —                 |
| Grant Expiration (PM) | on Access Grant Extended       | Reschedule Command (Optional)          | —                                   | —                 |
| Grant Expiration (PM) | on Command Rescheduled         | —                                      | Access Grant Expiration Rescheduled | —                 |
| Access Grant          | Scheduling, due                | Expire Access Grant                    | Access Grant Expired                | —                 |

### Scheduling

| Owner           | Trigger (actor/event) | Command                            | Event(s)                    |
| --------------- | --------------------- | ---------------------------------- | --------------------------- |
| Scheduling (PM) | —                     | Schedule Command                   | Command Scheduled           |
| Scheduling (PM) | —                     | Reschedule Command                 | Command Rescheduled         |
| Scheduling (PM) | —                     | Cancel Scheduled Command           | Scheduled Command Cancelled |
| Scheduling (PM) | Time Passed           | `(Scheduled Command)` (`Optional`) | —                           |

Stored command values carried in the "Schedule Command" sub-notes: **Activate
Access Grant** and **Expire Access Grant**.

### Audit

Projections subscribed to durable facts, retained in history and redacted (board
annotation: "Projections subscribed to events that must be retained in
history"). Details in `references/architecture.md`.
