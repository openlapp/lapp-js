# LAPP User Agreement and Risk Disclosure

Agreement version: 1.0  
Last updated: 2026-07-15

> Notice to distributors: this is a jurisdiction-neutral distribution template,
> not legal advice. Before relying on it as a binding agreement, the Distributor
> must identify its legal name, contact details, effective date, governing law,
> dispute forum, controlling language, and any required consumer and privacy
> terms in the installer or storefront. If those details are not supplied, this
> document operates as a risk disclosure only.

## 1. Parties, scope, and acceptance

In this Agreement:

- “LAPP Software” means the official OpenLAPP SDK or CLI, or another
  LAPP-compatible application that expressly incorporates this Agreement.
- “Distributor” means the person or entity that presents this Agreement and
  distributes that LAPP Software to you.
- “Provider” means an upstream AI service or local model server selected by a
  LAPP Profile.
- “Profile” means the local LAPP files that describe Providers, models,
  endpoints, authentication, and defaults.
- “Vault” means the optional current-user operating-system credential storage
  used by compatible LAPP Software for credentials referenced by a Profile.
- “you” means the individual or entity installing or using the LAPP Software.

A Distributor that seeks contractual acceptance must present this Agreement
before installation or first use, provide the full text, offer a genuine
decline or cancel option, and obtain affirmative consent where required by law.
Merely placing this file in a package does not by itself prove consent.

By affirmatively accepting, you acknowledge the risks below and agree with the
Distributor to the extent permitted by applicable law. If you do not accept,
you may cancel the Distributor's installation or services. Your independent
rights under the MIT License are not withdrawn by this Agreement.

This Agreement does not automatically govern third-party LAPP-compatible
applications. A third party is responsible for its own terms, privacy notice,
security, support, and legal compliance unless it expressly incorporates this
Agreement as its Distributor.

## 2. Open-source license remains controlling

The LAPP Software and related materials are licensed under the MIT License and
may include components under other open-source licenses. Those licenses govern
the rights granted by the relevant copyright holders to copy, modify, and
redistribute the relevant software.

Nothing in this Agreement narrows rights granted by the MIT License, prohibits
reverse engineering or modification that the applicable license permits, or
restricts a lawful field of use. If this Agreement conflicts with an
open-source license about software licensing rights, the open-source license
controls.

## 3. What LAPP does and does not do

LAPP is a local Provider and model registry. An application reads a Profile,
resolves a model, endpoint, and credential, and then communicates directly with
the selected Provider.

LAPP is not:

- an AI model or Provider;
- a proxy, gateway, firewall, credential-isolation broker, or security sandbox;
- malware protection or isolation between applications running as the same
  operating-system user;
- an identity, access-control, quota, billing, refund, or audit system;
- a content moderation, fact-checking, legal-compliance, or human-review
  service;
- a backup, high-availability, multi-user, or production secret-management
  system.

Compatible LAPP Software may provide Vault-backed encrypted-at-rest credential
storage. Vault does not prevent a compatible application running as the same
operating-system user from obtaining plaintext credentials for direct Provider
requests. A Distributor may add features outside the LAPP specification. Those
features are the Distributor's responsibility and require separate disclosure
where appropriate.

## 4. Key risks you expressly acknowledge

By accepting this Agreement, you acknowledge all of the following:

1. **Credential access.** An application that can resolve a usable Profile or
   shared Vault reference can obtain and use the referenced Provider
   credential. LAPP v1 assumes applications running as the same
   operating-system user are trusted; Vault is not a per-application access
   boundary or a non-exportable credential mechanism.
2. **Destination control.** A Profile controls both the credential reference
   and the destination. A malicious or incorrect Profile can send credentials
   and content to an unintended Provider. Validation reduces some mistakes but
   does not prove that a configured destination is trustworthy.
3. **Third-party data processing.** Prompts, messages, system instructions,
   conversation history, tool definitions and results, and other submitted
   content go directly to the selected Provider. The Provider's retention,
   training, moderation, location, cross-border transfer, and privacy practices
   may apply.
4. **Charges and account effects.** Real Provider requests consume your
   account's quota and may create fees, taxes, rate limits, suspension, or other
   account consequences. LAPP does not enforce a spending limit.
5. **Unreliable AI output.** Model output can be false, fabricated, incomplete,
   outdated, biased, harmful, insecure, or legally restricted. It can contain
   incorrect code, false citations, personal data, or material that infringes
   third-party rights.
6. **Tool and automation effects.** If an application enables tools or
   automated actions, a model may trigger handlers that change files, call
   services, send messages, make purchases, or cause other side effects.
   Structural argument validation does not prove that an action is safe or
   intended.
7. **Local and development boundary.** LAPP v1 is designed primarily for
   personal local and development use. It is not a substitute for production
   workload identity, a managed secret store, scoped authorization, rotation,
   audit, or multi-tenant isolation.

## 5. Credentials and Profile security

Plaintext credentials remain in Profile files on disk. An environment or Vault
reference keeps the value out of the Profile, but the resolved value still
enters the application's process memory. Vault records are stored in the
current user's operating-system credential store and may be read by compatible
applications running as that user. Query authentication can place a credential
in a request URL that may appear in Provider, proxy, diagnostic, or request
logs.

The official SDK binds a Vault record to a Provider identifier, normalized
origin, and authentication shape. This reduces accidental credential forwarding
after a Profile change, but a malicious same-user application can bypass that
SDK check and access the shared record directly. A missing, corrupted, denied,
or mismatched Vault record fails without falling back to plaintext, environment
variables, or files.

LAPP does not synchronize or back up Vault records. Reinstalling the operating
system, resetting the account or credential store, changing devices, or losing
the upstream key may make a credential unavailable. You remain responsible for
an independent Provider-side recovery or rotation path.

Transport and validation controls cannot protect a compromised device, a
malicious local application, an untrusted Profile root, a malicious configured
endpoint, screen capture, shell history, backups, or logs produced outside the
LAPP Software.

You are responsible for:

- installing only applications you trust with Provider access;
- reviewing the Profile root, Provider origin, authentication type, and model
  before use;
- preferring Vault storage or externally managed environment references over
  plaintext credentials;
- using restricted, scoped credentials and Provider-side budgets where
  available;
- protecting Profile files, Vault records, environment variables, process
  output, logs, and backups with appropriate operating-system permissions;
- rotating or revoking credentials after suspected disclosure; and
- treating any revealed connection or credential as secret.

Uninstalling LAPP Software does not necessarily delete Profiles, Vault records,
environment variables, shell output, Provider-side data, or credentials.
Remove retained data and revoke credentials separately when needed.

## 6. Data, privacy, and third-party Providers

The official LAPP architecture does not operate a central LAPP intermediary.
This does not mean that submitted data stays on your device: the selected
Provider receives the content and credential needed for the request. A
Distributor or third-party application may also process data outside the LAPP
specification.

Before sending personal, confidential, regulated, export-controlled, or
third-party data, review the Distributor's and Provider's current terms and
privacy notices, including retention, model-training use, human review, data
location, sub-processors, security, deletion, and cross-border transfer. Obtain
all permissions, notices, consents, and other legal bases required for the data
you submit.

Minimize submitted data. Do not place credentials or unnecessary personal data
in prompts, model metadata, tool results, logs, or bug reports.

This Agreement is not a privacy notice. A Distributor that collects or controls
personal data must provide its own legally sufficient privacy notice and
consent mechanism where required.

## 7. AI output, tools, and important decisions

Treat all model output as untrusted input. Verify important facts, citations,
calculations, code, commands, and recommendations with independent sources and
qualified people before relying on them.

The LAPP Software is not designed or validated to be the sole basis for
medical, legal, financial, employment, credit, education, public-safety,
critical-infrastructure, or other decisions that can materially affect a
person's rights, health, safety, livelihood, or access to essential services.
Where you use it in such a context, apply appropriate expert review, testing,
human oversight, authorization, recordkeeping, and appeal processes.

If tools or automated actions are enabled, use least-privilege handlers,
sandboxing where practical, previews, confirmation for consequential actions,
spending limits, and audit logs. The person or application that registers and
runs a handler remains responsible for its effects.

Provider terms and applicable law determine whether output may be owned, used,
published, or protected. No output is guaranteed to be unique, copyrightable,
accurate, confidential, or non-infringing.

## 8. Provider accounts, fees, and availability

You are responsible for the Provider account, subscription, credentials,
usage, taxes, geographic restrictions, acceptable-use rules, and charges
associated with your requests. Chat, streaming, retries, tests, tool loops,
model discovery, and other operations may make real network requests.

Provider prices, models, protocols, limits, and availability can change without
notice from LAPP. Providers may reject, moderate, retain, delay, rate-limit, or
stop requests under their own terms. LAPP does not promise continued access to
a Provider or model and does not issue refunds for Provider charges.

## 9. Local data and configuration integrity

The local model catalog is authoritative. Remote refresh is explicit and
append-only, so a model that an upstream Provider removes may remain listed
until you remove it. Verify model identity, capability, price, and availability
before use.

LAPP v1 assumes one writer. It does not provide profile-wide locking,
multi-file transactions, merge resolution, or automatic backup. Concurrent
writers, interrupted changes, manual edits, storage failure, or malicious local
tampering can cause inconsistency or data loss. Keep appropriate backups, avoid
simultaneous writers, validate after edits, and review changes before applying
them.

Loopback HTTP may be used for local development and is not encrypted by TLS.
Do not expose an unauthenticated local model server to untrusted users or
networks.

## 10. Your responsibilities

You are responsible for your device and account security, Profile selection,
Provider configuration, submitted data, prompts, tool permissions, use of
output, human oversight, backups, costs, and compliance with applicable law and
Provider terms.

Security validation, redaction, and safe defaults reduce risk but do not
transfer those responsibilities to the LAPP contributors or Distributor.

## 11. Updates, support, and stopping use

The Distributor may provide, change, or stop updates and support, subject to
applicable law and any separate written commitment. A material change to this
Agreement should be presented again before it applies; changes are not
retroactive unless applicable law and an express agreement permit that result.

You may stop using the LAPP Software at any time. To reduce residual risk,
uninstall the relevant application, delete Profiles and Vault records you no
longer need, remove environment references, clear exposed output and logs, and
rotate or revoke Provider credentials.

Stopping support or this Agreement does not cancel rights already granted by an
applicable open-source license.

## 12. Warranty disclaimer

To the maximum extent permitted by law, the LAPP Software is provided “as is”
and “as available.” The Distributor and contributors make no promise that it is
secure, uninterrupted, error-free, compatible with every Provider, fit for a
particular purpose, or that model output is accurate, lawful, confidential, or
non-infringing.

The warranty disclaimer in the MIT License also applies according to its terms.
Nothing in this Agreement excludes a warranty, guarantee, remedy, or consumer
right that applicable law does not allow the parties to exclude.

## 13. Limitation of liability

To the maximum extent permitted by law, the Distributor and contributors are
not liable under this Agreement for indirect, incidental, special,
consequential, exemplary, or punitive loss, or for lost profits, revenue, data,
credentials, account access, business opportunity, or goodwill arising from
the LAPP Software, a Provider, model output, tools, configuration, or third-party
conduct.

This limitation does not apply to liability that cannot lawfully be excluded or
limited, including mandatory consumer rights and, where applicable, fraud,
intentional misconduct, non-excludable gross negligence, or death or personal
injury caused by negligence. A Distributor must add any jurisdiction-specific
monetary cap or mandatory remedy before relying on one.

## 14. Mandatory law, severability, and no implied waiver

Applicable mandatory law controls over conflicting terms. If a provision is
unenforceable, it is limited or removed only to the minimum extent necessary;
the remaining provisions continue where the law permits.

Failure to enforce a provision once is not a waiver of future enforcement.
Nothing here requires arbitration, waives class or collective rights, or
selects a court unless the Distributor separately identifies a valid,
applicable dispute term before acceptance.

## 15. Distributor details, governing law, and language

The installer or storefront must identify the Distributor, contact method,
effective date, governing law, dispute forum, and any controlling language.
Mandatory conflict-of-law and consumer rules still apply.

If those details are absent, this document remains an important risk disclosure
but is not a complete Distributor-specific agreement. Do not post credentials,
private prompts, or personal data in a public support channel.

No language version takes precedence unless the Distributor clearly states one
before acceptance.
