# agents.md — src/data

`thirdPartyNotices.generated.json` is generated from installed, locked dependencies and `scripts/security/third-party-notices.pinned.json`. Run `npm run license:notices:generate`; never hand-edit package entries.

PR #2951 refreshes the exact production dependency versions and preserves JSZip 3.10.2 attribution under the existing MIT election.
Generate `thirdPartyNotices.generated.json` with `npm run license:notices:generate` from the installed locked tree. PR #2948 refreshes the Zod version after aligning root and worker validators; do not hand-edit package entries.
