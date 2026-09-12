# cto-train-b-0912 — targeted soak driver (T2, 4 h floor)

Isolated rig `cto-train-b-0912` for the 2026-09-12 non-migration train
(#2835 #2836 #2838 #2839 #2840 #2837 #2834 #2841 #2842 as admitted).
Driver: `train-cycle.mjs` (5-min cycles, one probe family per PR, every probe
asserts a DB delta or a read-back — never an HTTP status alone). Evidence under
`/Volumes/Extreme/offload/cto-soak-2026-09-12/train-b/`.
