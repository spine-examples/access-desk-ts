# Current Event Storming Model

## Purpose

This file records the current bounded contexts, actors, commands, events, and
rejections from the Event Storming board. Architecture details belong in
`references/architecture.md`.

## Bounded-contexts

- Identity
- Resources

## Identity

| Owner                  | Trigger (actor/event)                                 | Command                | Event(s)                          | Rejections                      |
| ---------------------- | ----------------------------------------------------- | ---------------------- | --------------------------------- | ------------------------------- |
| External Identity (PM) | Application, when an account it has not seen signs in | Link External Identity | External Identity Linking Started | External Identity Already Known |
| External Identity (PM) | on External Identity Linking Started                  | Register Person Email  | —                                 | —                               |
| Person Email           | External Identity (PM)                                | Register Person Email  | Person Email Registered           | Person Email Already Registered |
| External Identity (PM) | on Person Email Registered                            | Register Person        | —                                 | —                               |
| Person                 | External Identity (PM)                                | Register Person        | Person Registered                 | —                               |
| External Identity (PM) | on Person Email Already Registered                    | Add Sign-In Account    | —                                 | —                               |
| Person                 | External Identity (PM)                                | Add Sign-In Account    | Sign-In Account Added             | —                               |
| External Identity (PM) | on Person Registered                                  | —                      | External Identity Linked          | —                               |
| External Identity (PM) | on Sign-In Account Added                              | —                      | External Identity Linked          | —                               |

Projections: **External Identity View** receives External Identity Linked and
tells which person an account belongs to. **Person View** receives Person
Registered and Sign-In Account Added.

## Board transcription

### Resources

| Owner                      | Trigger (actor/event)                 | Command                     | Event(s)                        | Rejections                           |
| -------------------------- |---------------------------------------| --------------------------- | ------------------------------- | ------------------------------------ |
| Organization               | Developer, at assembly                | Create Organization         | Organization Created            | Organization Already Exists          |
| Invitation (PM)            | Organization Administrator            | Invite Member               | Member Invited                  | Member Already Invited               |
| Invitation (PM)            | Organization Administrator            | Revoke Invitation           | Invitation Revoked              | Invitation Not Pending               |
| Invitation (PM)            | Invited person, signed in             | Accept Invitation           | Invitation Accepted             | Invitation Not Pending               |
| Invitation (PM)            | Invited person, signed in             | Decline Invitation          | Invitation Declined             | Invitation Not Pending               |
| Invitation (PM)            | on Invitation Accepted                | Add Organization Member     | —                               | —                                    |
| Organization               | Invitation (PM)                       | Add Organization Member     | Organization Member Added       | —                                    |
| Resource Registration (PM) | Organization Administrator            | Register Resource           | Resource Registration Requested | —                                    |
| Resource Registration (PM) | on Resource Registration Requested    | Create Resource             | —                               | —                                    |
| Resource                   | Resource Registration (PM)            | Create Resource             | Resource Created                | Resource Already Exists              |
| Resource Registration (PM) | on Resource Already Exists            | —                           | Resource Registration Failed    | —                                    |
| Resource Registration (PM) | on Resource Created                   | Add Resource                | —                               | —                                    |
| Organization               | Resource Registration (PM)            | Add Resource                | Resource Added                  | Resource Name Already Used           |
| Resource Registration (PM) | on Resource Name Already Used         | Delete Resource             | —                               | —                                    |
| Resource                   | Resource Registration (PM)            | Delete Resource             | Resource Deleted                | —                                    |
| Resource Registration (PM) | on Resource Added                     | —                           | Resource Registered             | —                                    |
| Resource Registration (PM) | on Resource Deleted                   | —                           | Resource Registration Failed    | —                                    |
| Resource                   | Resource Manager                      | Open Resource For Requests  | Resource Opened For Requests    | Resource Already Open For Requests   |
| Resource                   | Resource Manager                      | Close Resource For Requests | Resource Closed For Requests    | Resource Already Closed For Requests |

Process: **Resource Registration** runs `Register Resource → Resource
Registration Requested → Create Resource → Resource Created → Add Resource →
Resource Added → Resource Registered`, then completes on `Resource Registered`.
If `Add Resource` rejects `Resource Name Already Used`, it runs `Delete Resource
→ Resource Deleted → Resource Registration Failed`, then completes.

Projections: **Organization View** receives Organization Created, Organization
Member Added, and Resource Added. **Invitation View** receives Member Invited, Invitation
Revoked, Invitation Accepted, and Invitation Declined. **Resource Catalog Item** receives Resource
Created, Resource Deleted, Resource Opened For Requests, and Resource Closed For
Requests. The request-and-approval process reads the resource catalog directly
for policy; there is no separate request-policy mirror projection.

#### Request & approval

| Owner               | Trigger (actor/event)                                                                                          | Command                                      | Event(s)                                    | Rejections                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| Access Request (PM) | Requester                                                                                                      | Submit Access Request                        | Access Request Submission Started           | Resource Not Open For Requests; Access Level Not Offered; Request Already Pending |
| Access Request (PM) | Requester                                                                                                      | Submit Access Extension Request              | Access Extension Request Submission Started | Resource Not Open For Requests; Request Already Pending                           |
| Access Request (PM) | on Access Request Submission Started                                                                           | Check Requested Access                       | —                                           | —                                                                                 |
| Access Request (PM) | on Access Extension Request Submission Started                                                                 | Check Requested Extension                    | —                                           | —                                                                                 |
| Access Request (PM) | on Requested Access Checked                                                                                    | —                                            | Access Request Submitted                    | —                                                                                 |
| Access Request (PM) | on Requested Extension Checked                                                                                 | —                                            | Access Extension Request Submitted          | —                                                                                 |
| Access Request (PM) | on Requested Duration Too Long `OR` Access Already Held, for a first-time request                              | —                                            | Access Request Submission Failed            | —                                                                                 |
| Access Request (PM) | on Access Grant Not Active `OR` Requested Duration Too Long `OR` Access Already Held, for an extension request | —                                            | Access Extension Request Submission Failed  | —                                                                                 |
| Access Request (PM) | Resource Manager                                                                                               | Approve Access Request                       | Access Request Approval Started             | Request Already Decided; Not An Eligible Manager                                  |
| Access Request (PM) | on Access Request Approval Started                                                                             | Create Access Grant `OR` Extend Access Grant | —                                           | —                                                                                 |
| Access Request (PM) | on Access Grant Created `OR` Access Grant Extended                                                             | —                                            | Access Request Approved                     | —                                                                                 |
| Access Request (PM) | on Access Grant Not Active, at approval                                                                        | —                                            | Access Request Approval Failed              | —                                                                                 |
| Access Request (PM) | Manager                                                                                                        | Deny Access Request                          | Access Request Denied                       | Request Already Decided; Not An Eligible Manager                                  |
| Access Request (PM) | Requester                                                                                                      | Cancel Access Request                        | Access Request Canceled                     | Request Already Decided                                                           |

Submission captures managers in policy order and removes duplicates. A
requester who is also a manager may decide the request.

Projection inputs and outputs drawn on the board:

- **Access Request View** receives Access Request Submitted, Access Extension
  Request Submitted, Access Request Approval Started, Access Request Approved,
  Access Request Approval Failed, Access Request Denied, and Access Request
  Canceled — the requester's read model of each request and its status. It
  takes who approved a request, and when, from Access Request Approval Started.
- **Access Decision Assignment** receives Access Request Submitted, Access
  Extension Request Submitted, Access Request Approved, Access Request Approval
  Failed, Access Request Denied, and Access Request Canceled; it also receives
  Access Grant Revoked, dropping pending extensions of that grant.

#### Access grant — Resource Access aggregate

| Owner           | Trigger (actor/event)              | Command                   | Event(s)                    | Rejections                                                                |
| --------------- | ---------------------------------- | ------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| Resource Access | Access Request (PM), at submission | Check Requested Access    | Requested Access Checked    | Requested Duration Too Long; Access Already Held                          |
| Resource Access | Access Request (PM), at submission | Check Requested Extension | Requested Extension Checked | Access Grant Not Active; Requested Duration Too Long; Access Already Held |
| Resource Access | Access Request (PM), at approval   | Create Access Grant       | Access Grant Created        | —                                                                         |
| Resource Access | Access Request (PM), at approval   | Extend Access Grant       | Access Grant Extended       | Access Grant Not Active                                                   |
| Resource Access | Resource Manager                   | Revoke Access Grant       | Access Grant Revoked        | Access Grant Not Active; Not Resource Manager                             |

Projection: **Access Grant View** receives Access Grant Created, Access Grant
Extended, and Access Grant Revoked.

#### Audit

Projections over durable facts, retained in history and redacted. Details in
`references/architecture.md`.
