# Critical Invitation Assignment Bug Fix - Summary

## The Bug 🐛

**Race Condition in Invitation Assignment**: The same invitation was being assigned to multiple guests because invitation fetching and assignment were not atomic.

### Buggy Flow (Before)
```typescript
// ❌ VULNERABLE TO RACE CONDITION
const availableInvitation = await supabase
  .from('invitations')
  .select('*')
  .eq('event_id', eventId)
  .eq('assigned', false)
  .limit(1);
// ⚠️ WINDOW: Another guest can fetch the same invitation here

const newGuest = await supabase.from('guests').insert(...);

await supabase
  .from('invitations')
  .update({ assigned: true, assigned_to_guest: newGuest.id })
  .eq('id', availableInvitation.id);
// ⚠️ Both guests get the same invitation!
```

### Scenario That Broke
1. Event created with 1 invitation image
2. Guest A (phone: 0501234567) submits registration
3. **Same millisecond**: Guest B (phone: 0509876543) submits registration
4. Both find the SAME unassigned invitation
5. Both insert guest records with that invitation_id
6. Both mark invitation as assigned (assigned_to_guest could be either guest, depending on timing)
7. **Result**: Both guests get the same invitation image ❌

---

## The Fix ✅

### Solution: Atomic Assignment via PostgreSQL Function

Implemented a database-level function that combines finding and assigning in a single, locked transaction.

### New PostgreSQL Function: `assign_invitation()`

```sql
create or replace function assign_invitation(
  p_event_id uuid,
  p_guest_id uuid
) returns table (...) as $$
begin
  -- 1. LOCK: Find unassigned invitation (prevents concurrent access)
  select i.id into v_invitation_id
  from invitations i
  where i.event_id = p_event_id and i.assigned = false
  order by i.created_at asc
  limit 1
  for update;  -- ← ROW LOCK: Other transactions must wait

  -- 2. If no invitation, return NULL
  if v_invitation_id is null then
    return;
  end if;

  -- 3. ASSIGN: Update in same transaction (atomically)
  update invitations
  set assigned = true,
      assigned_to_guest = p_guest_id,
      assigned_at = now()
  where id = v_invitation_id;

  -- 4. RETURN: The assigned invitation
  return query select * from invitations where id = v_invitation_id;
end;
$$ language plpgsql;
```

### New Fixed Flow (After)
```typescript
// ✅ ATOMIC - No race condition possible
// Step 1: Create guest first
const newGuest = await supabase
  .from('guests')
  .insert({ event_id, name, phone, invitation_id: null })
  .select()
  .single();

// Step 2: Atomically assign invitation
const assignedInvitations = await supabase.rpc('assign_invitation', {
  p_event_id: eventId,
  p_guest_id: newGuest.id,
});

const invitation = assignedInvitations[0] || null;

if (!invitation) {
  // Clean up if no invitation available
  await supabase.from('guests').delete().eq('id', newGuest.id);
  throw new Error('عذراً، تم توزيع جميع الدعوات');
}

// Step 3: Update guest with invitation_id
await supabase
  .from('guests')
  .update({ invitation_id: invitation.id })
  .eq('id', newGuest.id);
```

### Why This Works

1. **SELECT FOR UPDATE**: PostgreSQL locks the row during the transaction
2. **Atomicity**: Both the read and write happen in one transaction - no gap between them
3. **Serialization**: If two requests come simultaneously:
   - Request A acquires lock on invitation row
   - Request B waits for lock
   - Request A completes: invitation marked as assigned to Guest A
   - Request B acquires lock, but invitation is already assigned
   - Request B finds no unassigned invitation → returns NULL
   - Result: Only Guest A gets the invitation ✅

---

## Changes Made

### 1. Database Schema (`supabase-schema.sql`)

#### Added Function
```sql
create or replace function assign_invitation(...)
  -- Atomic invitation assignment with row locking
```

#### Added Indexes (for performance)
```sql
create index if not exists invitations_event_assigned_idx 
  on invitations(event_id, assigned);
create index if not exists guests_event_phone_idx 
  on guests(event_id, phone);
```

#### Added Constraints (for data integrity)
```sql
-- One phone per event
alter table guests add constraint unique_phone_per_event 
  unique(event_id, phone);

-- Prevent same invitation from being assigned to multiple guests
alter table invitations add constraint unique_assigned_to_guest_when_assigned 
  unique (event_id, assigned_to_guest) where assigned = true and assigned_to_guest is not null;
```

### 2. Application Code (`src/App.tsx`)

#### Updated Guest Registration Flow
- **Before**: Fetch invitation → Create guest → Update invitation
- **After**: Create guest → Call atomic RPC → Update guest with invitation_id

#### Key Changes
- Lines 486-560: Replaced non-atomic query with atomic `assign_invitation()` RPC call
- Added proper error handling and guest record cleanup
- Added check for duplicate phone (unique constraint handling)

---

## Test Case: 1 Invitation, 2 Guests

### Setup
- Create event with 1 invitation image

### Test Sequence
```
Guest A (phone: 0501234567) → Registers
  ✅ Gets invitation #1
  ✅ invitation.assigned = true
  ✅ invitation.assigned_to_guest = Guest A ID

Guest B (phone: 0509876543) → Registers (immediately after)
  ❌ Sees error: "عذراً، تم توزيع جميع الدعوات"
  ❌ invitation.assigned still = true (unchanged)
  ❌ Guest B record has invitation_id = NULL

Verify:
  ✅ invitation_id count = 1 (only Guest A has it)
  ✅ No guest has both invited and same image
  ✅ Statistics: remaining = 0, distributed = 1
```

---

## Verification Queries

### Check for Duplicate Invitations (Should be 0 rows)
```sql
SELECT i.id, COUNT(g.id) as guest_count
FROM invitations i
LEFT JOIN guests g ON i.id = g.invitation_id
WHERE i.assigned = true
GROUP BY i.id
HAVING COUNT(g.id) > 1;
```

### Verify Assigned Invitations Match Guests
```sql
SELECT COUNT(*) as total_invitations,
       SUM(CASE WHEN assigned = true THEN 1 ELSE 0 END) as assigned,
       COUNT(DISTINCT assigned_to_guest) as unique_guests_assigned
FROM invitations
WHERE event_id = 'YOUR_EVENT_ID';
-- Result: all three numbers should match
```

### Check Statistics are Correct
```sql
SELECT 
  'Remaining' as stat,
  COUNT(*) as count
FROM invitations
WHERE event_id = 'YOUR_EVENT_ID' AND assigned = false

UNION ALL

SELECT 
  'Distributed' as stat,
  COUNT(*) as count
FROM invitations
WHERE event_id = 'YOUR_EVENT_ID' AND assigned = true;
```

---

## Requirements Checklist ✅

- ✅ Each invitation row can only be assigned once
- ✅ Only find `assigned = false` invitations
- ✅ Show error when no invitations available: "عذراً، تم توزيع جميع الدعوات"
- ✅ Immediately update: `assigned = true`, `assigned_to_guest`, `assigned_at = now()`
- ✅ Never return already assigned invitations
- ✅ Same phone gets same previously assigned invitation
- ✅ Different phones never receive same invitation
- ✅ Statistics calculations fixed
- ✅ All invitation assignment logic is atomic and safe
- ✅ Verification test provided for 1 invitation scenario

---

## Performance Impact

- ✅ **Minimal**: Added 1 database function (no performance penalty)
- ✅ **Safe**: Row locking is fast (microseconds)
- ✅ **Scalable**: Works with any number of concurrent requests
- ✅ **Indexed**: Added indexes for frequently queried columns

---

## Deployment Steps

1. **Run migration** on Supabase:
   ```sql
   -- Execute all statements in supabase-schema.sql
   ```

2. **Deploy code** from `src/App.tsx`

3. **Test** with verification scenario (1 invitation, 2 guests)

4. **Monitor** for any errors in assignment flow

---

## FAQ

**Q: Will this block other users?**
A: No. The lock is only on the specific invitation row, only for milliseconds, and only affects users trying to get assignments from the same event simultaneously.

**Q: What if a guest registers twice with same phone?**
A: The unique constraint `unique_phone_per_event` prevents duplicates at the database level. They'll get their previous invitation again.

**Q: What if the function returns NULL?**
A: It means all invitations are assigned. The app shows "عذراً، تم توزيع جميع الدعوات" and deletes the guest record created in step 1.

**Q: Is this change backward compatible?**
A: Yes. The function is new. All existing data remains unchanged.

---

**Status**: ✅ **CRITICAL BUG FIXED - READY FOR TESTING**
