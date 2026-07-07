create extension if not exists pgcrypto;

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null,
  slug text not null,
  created_at timestamp with time zone default now()
);

create table if not exists guests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  name text,
  phone text,
  invitation_id uuid,
  attendance_status text not null default 'pending',
  created_at timestamp with time zone default now()
);

create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  image_url text not null,
  assigned boolean not null default false,
  assigned_to_guest uuid,
  assigned_at timestamp with time zone,
  created_at timestamp with time zone default now()
);

create index if not exists guests_event_id_idx on guests(event_id);
create index if not exists guests_phone_idx on guests(phone);
create index if not exists guests_event_phone_idx on guests(event_id, phone);
create index if not exists invitations_event_id_idx on invitations(event_id);
create index if not exists invitations_assigned_idx on invitations(assigned);
create index if not exists invitations_event_assigned_idx on invitations(event_id, assigned);
create index if not exists events_slug_idx on events(slug);

-- One guest per phone per event
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_phone_per_event'
  ) THEN
    ALTER TABLE guests ADD CONSTRAINT unique_phone_per_event UNIQUE (event_id, phone);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'guests' AND column_name = 'attendance_status'
  ) THEN
    ALTER TABLE guests ADD COLUMN attendance_status text NOT NULL DEFAULT 'pending';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'guests' AND column_name = 'name' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE guests ALTER COLUMN name DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'guests' AND column_name = 'phone' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE guests ALTER COLUMN phone DROP NOT NULL;
  END IF;
END $$;

-- Remove the old RPC function if it exists
DROP FUNCTION IF EXISTS public.assign_invitation(uuid, uuid);

-- Enable RLS
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE guests ENABLE ROW LEVEL SECURITY;

-- Prevent the same invitation from being assigned twice
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'unique_assigned_to_guest_when_assigned'
  ) THEN
    ALTER TABLE invitations
      ADD CONSTRAINT unique_assigned_to_guest_when_assigned
      UNIQUE (event_id, assigned_to_guest)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- Public read access for the event pages
DROP POLICY IF EXISTS "Enable read for all" ON events;
CREATE POLICY "Enable read for all" ON events FOR SELECT USING (true);

DROP POLICY IF EXISTS "Enable read for all" ON invitations;
CREATE POLICY "Enable read for all" ON invitations FOR SELECT USING (true);

DROP POLICY IF EXISTS "Enable read for all" ON guests;
CREATE POLICY "Enable read for all" ON guests FOR SELECT USING (true);

-- Allow event creation and guest registration from the app
DROP POLICY IF EXISTS "Enable insert for event creation" ON events;
CREATE POLICY "Enable insert for event creation" ON events FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Enable insert for guest registration" ON guests;
CREATE POLICY "Enable insert for guest registration" ON guests FOR INSERT WITH CHECK (true);

-- Allow updates and deletes required by the management UI
DROP POLICY IF EXISTS "Enable update for invitation assignment" ON invitations;
CREATE POLICY "Enable update for invitation assignment" ON invitations FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Enable delete for event deletion" ON invitations;
CREATE POLICY "Enable delete for event deletion" ON invitations FOR DELETE USING (true);

DROP POLICY IF EXISTS "Enable delete for event deletion" ON guests;
CREATE POLICY "Enable delete for event deletion" ON guests FOR DELETE USING (true);

DROP POLICY IF EXISTS "Enable delete for event deletion" ON events;
CREATE POLICY "Enable delete for event deletion" ON events FOR DELETE USING (true);

DROP POLICY IF EXISTS "Enable update for event updates" ON events;
CREATE POLICY "Enable update for event updates" ON events FOR UPDATE USING (true) WITH CHECK (true);
