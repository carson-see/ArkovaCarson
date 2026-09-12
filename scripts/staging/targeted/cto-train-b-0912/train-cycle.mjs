// cto-train-b-0912 train driver — probe families are filled per PR from the
// reviewers' probe specs (report-<PR>.md §I). Skeleton committed so the rig
// admission records a tracked driver path; the sha256 in evidence is the
// final file's.
export const PROBES = [];
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify({ cycle_pass: false, reason: 'skeleton — probes not yet installed', probes: PROBES.length }));
  process.exit(3);
}
