# Archived Migration Notes

This directory holds the historical 0000..0289 migration chain retired by the Path C baseline.

- Do not run these files manually for a fresh DB. Fresh stand-ups should use `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql` plus newer migrations.
- Keep these SQL files immutable; they are audit history. Use `git log --follow` when tracing why an object exists.
- Keep this archive coupled with the baseline PR. Moving one without the other breaks the migration-history story.
