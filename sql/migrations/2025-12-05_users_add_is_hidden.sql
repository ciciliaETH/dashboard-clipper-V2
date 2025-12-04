-- Add is_hidden column to users table for soft delete/hide functionality
-- Date: 2025-12-05

BEGIN;

-- 1. Add is_hidden column (default false = visible)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT FALSE;

-- 2. Create index for faster filtering
CREATE INDEX IF NOT EXISTS idx_users_is_hidden ON public.users(is_hidden) WHERE is_hidden = FALSE;

-- 3. Update existing 'umum' role users to be hidden by default
UPDATE public.users
SET is_hidden = TRUE
WHERE role = 'umum';

COMMIT;

-- Verify
SELECT role, is_hidden, COUNT(*) 
FROM public.users 
GROUP BY role, is_hidden 
ORDER BY role, is_hidden;
