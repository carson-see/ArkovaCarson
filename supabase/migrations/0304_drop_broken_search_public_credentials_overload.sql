-- Drop the broken 3-argument overload of search_public_credentials.
-- This overload references nonexistent columns (a.title, o.is_public)
-- and causes "function is not unique" errors when calling with (text, integer).
-- The working 2-argument overload (text, integer DEFAULT 10) is preserved.
--
-- ROLLBACK: Re-create the 3-arg overload — but it never worked, so rollback
-- is effectively a no-op. The function body referenced columns that don't exist.

DROP FUNCTION IF EXISTS public.search_public_credentials(text, integer, integer);
