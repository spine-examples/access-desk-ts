# Current Event Storming Model

## Purpose

This file records the current bounded contexts, actors, commands, events, and
rejections from the Event Storming board. Architecture details belong in
`references/architecture.md`.

## Bounded-contexts

- Identity
- Resources
- Audit

Resources owns organizations, membership, resources, policies, requests,
decisions, grants, and scheduling.

## Identity

User registration and authentication. No aggregates or transitions are drawn on
the board.

## Board transcription

### Resources

| Owner                      | Trigger (actor/event)              | Command                     | Event(s)                        | Rejections                           |
| -------------------------- | ---------------------------------- | --------------------------- | ------------------------------- | ------------------------------------ |
| Organization               | Platform Operator                  | Create Organization         | Organization Created            | Organization Already Exists          |
| Organization               | Platform Operator                  | Add Organization Member     | Organization Member Added       | Organization Member Already Added    |
| Resource Registration (PM) | Platform Operator                  | Register Resource           | Resource Registration Requested | —                                    |
| Resource Registration (PM) | on Resource Registration Requested | Create Resource             | —                               | —                                    |
| Resource                   | Resource Registration (PM)         | Create Resource             | Resource Created                | Resource Already Exists              |
| Resource Registration (PM) | on Resource Already Exists         | —                           | Resource Registration Failed    | —                                    |
| Resource Registration (PM) | on Resource Created                | Add Resource                | —                               | —                                    |
| Organization               | Resource Registration (PM)         | Add Resource                | Resource Added                  | Resource Name Already Used           |
| Resource Registration (PM) | on Resource Name Already Used      | Delete Resource             | —                               | —                                    |
| Resource                   | Resource Registration (PM)         | Delete Resource             | Resource Deleted                | —                                    |
| Resource Registration (PM) | on Resource Added                  | —                           | Resource Registered             | —                                    |
| Resource Registration (PM) | on Resource Deleted                | —                           | Resource Registration Failed    | —                                    |
| Resource                   | Resource Manager                   | Open Resource For Requests  | Resource Opened For Requests    | Resource Already Open For Requests   |
| Resource                   | Resource Manager                   | Close Resource For Requests | Resource Closed For Requests    | Resource Already Closed For Requests |

Process: **Resource Registration** runs `Register Resource → Resource
Registration Requested → Create Resource → Resource Created → Add Resource →
Resource Added → Resource Registered`, then completes on `Resource Registered`.
If `Add Resource` rejects `Resource Name Already Used`, it runs `Delete Resource
→ Resource Deleted → Resource Registration Failed`, then completes.

Projections: **Organization View** receives Organization Created, Organization
Member Added, and Resource Added. **Resource Catalog Item** receives Resource
Created, Resource Deleted, Resource Opened For Requests, and Resource Closed For
Requests. The request-and-approval process reads the resource catalog directly
for policy; there is no separate request-policy mirror projection.

#### Request & approval

| Owner               | Trigger (actor/event) | Command                         | Event(s)                           | Rejections                                                                                               |
| ------------------- | --------------------- | ------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Access Request (PM) | Requester             | Submit Access Request           | Access Request Submitted           | Resource Not Requestable; Access Level Not Available; Access Duration Too Long; Duplicate Access Request |
| Access Request (PM) | Requester             | Submit Access Extension Request | Access Extension Request Submitted | Resource Not Requestable; Access Duration Too Long; Duplicate Access Request                             |
| Access Request (PM) | Manager               | Approve Access Request          | Access Request Approved            | Request Already Decided; Manager Not Eligible                                                            |
| Access Request (PM) | Manager               | Deny Access Request             | Access Request Denied              | Request Already Decided; Manager Not Eligible                                                            |
| Access Request (PM) | Requester             | Cancel Access Request           | Access Request Canceled            | Request Already Decided                                                                                  |

Submission captures managers in policy order and removes duplicates. A
requester who is also a manager may decide the request.

Projection inputs and outputs drawn on the board:

- **Access Request View** receives Access Request Submitted, Access Extension
  Request Submitted, Access Request Approved, Access Request Denied, and Access
  Request Canceled — the requester's read model of each request and its status.
- **Access Decision Assignment** receives Access Request Submitted, Access
  Extension Request Submitted, Access Request Approved, Access Request Denied,
  and Access Request Canceled.

#### Grant issuance — Grant Issuance PM, Access Grant aggregate (forward design)

| Owner               | Trigger (actor/event)                 | Command                                                             | Event(s)                          |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------- | --------------------------------- |
| Grant Issuance (PM) | on Access Request Approved            | Create Access Grant `OR` Extend Access Grant                        | —                                 |
| Access Grant        | Grant Issuance (PM)                   | Create Access Grant                                                 | Access Grant Created              |
| Access Grant        | Grant Issuance (PM)                   | Extend Access Grant                                                 | Access Grant Extended             |
| Grant Issuance (PM) | on Access Grant Created               | Activate Access Grant `OR` Schedule Command (Activate Access Grant) | —                                 |
| Access Grant        | Grant Issuance (PM), immediate branch | Activate Access Grant                                               | Access Grant Activated            |
| Grant Issuance (PM) | on Command Scheduled                  | —                                                                   | Access Grant Activation Scheduled |
| Access Grant        | Scheduling, due                       | Activate Access Grant                                               | Access Grant Activated            |

#### Revocation & expiration (forward design)

| Owner                 | Trigger (actor/event)         | Command                                | Event(s)                            | Rejections        |
| --------------------- | ----------------------------- | -------------------------------------- | ----------------------------------- | ----------------- |
| Access Grant          | Resource Manager              | Revoke Access Grant                    | Access Grant Revoked                | Access Not Active |
| Grant Expiration (PM) | on Access Grant Revoked       | Cancel Scheduled Command (Optional)    | —                                   | —                 |
| Grant Expiration (PM) | on Scheduled Command Canceled | —                                      | Access Grant Expiration Canceled    | —                 |
| Grant Expiration (PM) | on Access Grant Activated     | Schedule Command (Expire Access Grant) | —                                   | —                 |
| Grant Expiration (PM) | on Command Scheduled          | —                                      | Access Grant Expiration Scheduled   | —                 |
| Grant Expiration (PM) | on Access Grant Extended      | Reschedule Command (Optional)          | —                                   | —                 |
| Grant Expiration (PM) | on Command Rescheduled        | —                                      | Access Grant Expiration Rescheduled | —                 |
| Access Grant          | Scheduling, due               | Expire Access Grant                    | Access Grant Expired                | —                 |

#### Scheduling (internal Resources component, forward design)

| Owner           | Trigger (actor/event) | Command                            | Event(s)                   |
| --------------- | --------------------- | ---------------------------------- | -------------------------- |
| Scheduling (PM) | —                     | Schedule Command                   | Command Scheduled          |
| Scheduling (PM) | —                     | Reschedule Command                 | Command Rescheduled        |
| Scheduling (PM) | —                     | Cancel Scheduled Command           | Scheduled Command Canceled |
| Scheduling (PM) | Time Passed           | `(Scheduled Command)` (`Optional`) | —                          |

Stored command values carried in the "Schedule Command" sub-notes: **Activate
Access Grant** and **Expire Access Grant**.

### Audit

Projections over durable facts, retained in history and redacted. Details in
`references/architecture.md`.
