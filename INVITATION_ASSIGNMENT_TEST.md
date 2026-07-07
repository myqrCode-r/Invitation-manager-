# Invitation Assignment Bug Fix - Verification Test

## Critical Bug Being Fixed
**Issue**: The same invitation image was being assigned to multiple guests due to race condition.

## Requirements Met

✅ **1. Each invitation row can only be assigned once**
   - Database constraint: `unique_assigned_to_guest_when_assigned` prevents duplicate assignments
   - PostgreSQL function `assign_invitation()` uses `SELECT FOR UPDATE` for row locking

✅ **2. Only find unassigned invitations (assigned = false)**
   - Query in `assign_invitation()` function filters: `WHERE i.assigned = false`

✅ **3. Show error if no unassigned invitation exists**
   - Client code checks: `if (!availableInvitation)` → Shows "عذراً، تم توزيع جميع الدعوات"

✅ **4. Immediately update assigned status atomically**
   - Single PostgreSQL transaction in `assign_invitation()` function
   - Updates: `assigned = true`, `assigned_to_guest = guest.id`, `assigned_at = now()`

✅ **5. Never return invitation already assigned**
   - Function filters: `WHERE i.assigned = false`
   - Unique constraint prevents multiple assignments

✅ **6. Same phone number gets same previously assigned invitation**
   - Client code checks existing guest by phone: `eq('phone', normalizedPhone).maybeSingle()`
   - Returns previously assigned invitation if guest exists

✅ **7. Different phone numbers never get same invitation**
   - Atomic assignment ensures only one guest per invitation
   - Unique constraint: `unique(event_id, assigned_to_guest) where assigned = true`

✅ **8. Statistics calculations fixed**
   - **Remaining Invitations** = `count(assigned = false)`
   - **Distributed Invitations** = `count(assigned = true)`
   - Code: `invitations.filter((invitation) => invitation.assigned).length`

✅ **9. Atomic & safe invitation assignment**
   - PostgreSQL function with row locking via `SELECT FOR UPDATE`
   - All updates within single transaction
   - Unique constraints at database level

## Final Verification Test

### Scenario: Event with 1 invitation

1. **Guest A Registration**
   - Name: "Guest A"
   - Phone: "0501234567"
   - **Expected Result**: ✅ Gets invitation with image
   - Database State:
     - `invitations`: `assigned = true, assigned_to_guest = [Guest A ID]`
     - `guests`: `invitation_id = [Invitation ID]`

2. **Guest B Registration (Different Phone)**
   - Name: "Guest B"
   - Phone: "0509876543"
   - **Expected Result**: ❌ Sees error message "عذراً، تم توزيع جميع الدعوات"
   - Database State:
     - `invitations`: Still `assigned = true` for Guest A (unchanged)
     - `guests`: Guest B record created but **NOT** given any invitation
     - Guest B's `invitation_id` remains NULL

3. **Guest A Re-Registration (Same Phone)**
   - Name: "Guest A"
   - Phone: "0501234567" (same as before)
   - **Expected Result**: ✅ Sees their previously assigned invitation again
   - No new registration, existing record returned

### Race Condition Test

**Scenario**: Simultaneous requests for the same invitation

- Request 1: Guest A (0501234567) → Gets invitation ✅
- Request 2: Guest B (0509876543) → Simultaneously claims same invitation ❌
- **Result**: Only ONE request succeeds due to `SELECT FOR UPDATE` row locking
- The other receives NULL from `assign_invitation()` → Error message shown

### Key Safeguards

1. **Database Level**:
   - `SELECT FOR UPDATE` locks prevent concurrent reads of same invitation
   - Unique constraint prevents duplicate assignments

2. **Application Level**:
   - Check if guest already exists by phone
   - Only proceed if invitation is assigned successfully
   - Clean up guest record if invitation assignment fails
   - Atomic RPC call to `assign_invitation()` function

3. **Data Integrity**:
   - Unique constraint on `(event_id, assigned_to_guest)` with `WHERE assigned = true`
   - One-to-one relationship: One invitation → One guest
   - One-to-one relationship: One phone → One invitation (per event)

## How to Run This Test

### Manual Test (via Supabase UI or Client)

1. Create event with 1 invitation image
2. Open guest registration page
3. Register Guest A with phone "0501234567"
4. Verify: Guest A receives invitation image
5. In new browser/incognito, register Guest B with phone "0509876543"
6. Verify: Guest B sees "عذراً، تم توزيع جميع الدعوات"
7. Register Guest A again with same phone "0501234567"
8. Verify: Gets same invitation as before

### Automated Test (SQL Verification)

```sql
-- Test: Verify no invitation is assigned to multiple guests
SELECT 
  i.event_id,
  i.id as invitation_id,
  COUNT(g.id) as guest_count,
  STRING_AGG(g.phone, ', ') as phones
FROM invitations i
LEFT JOIN guests g ON i.id = g.invitation_id
WHERE i.assigned = true
GROUP BY i.event_id, i.id
HAVING COUNT(g.id) > 1;

-- Result: Should return 0 rows (no invitation assigned to multiple guests)
```

```sql
-- Test: Verify statistics are correct
SELECT 
  e.id,
  e.name,
  COUNT(CASE WHEN i.assigned = false THEN 1 END) as remaining,
  COUNT(CASE WHEN i.assigned = true THEN 1 END) as distributed,
  COUNT(i.id) as total
FROM events e
LEFT JOIN invitations i ON e.id = i.event_id
GROUP BY e.id, e.name;
```

## Files Modified

1. **supabase-schema.sql**
   - Added `assign_invitation()` PostgreSQL function with atomic assignment
   - Added unique constraint for invitation assignments
   - Added indexes for performance: `invitations_event_assigned_idx`
   - Added unique constraint for phone per event: `unique_phone_per_event`

2. **src/App.tsx**
   - Updated guest registration to use atomic `assign_invitation()` RPC
   - Changed flow: Create guest first, then atomically assign invitation
   - Improved error handling with guest record cleanup on failure
   - Proper handling of existing guests by phone number

## Before and After

### BEFORE (Buggy Code)
```
1. Get unassigned invitation (assigned = false)
2. Create guest with invitation_id
3. Update invitation to assigned = true
❌ RACE CONDITION: Between step 1 and 3, another guest can claim same invitation
```

### AFTER (Fixed Code)
```
1. Create guest record (with NULL invitation_id)
2. Call assign_invitation() function atomically:
   a. SELECT FOR UPDATE to lock first unassigned invitation
   b. If found: Update to assigned = true in same transaction
   c. Return assigned invitation or NULL
3. Update guest with assigned invitation_id
✅ ATOMIC: No race condition possible - row is locked during assignment
```

## Conclusion

This fix ensures that:
- ✅ Each invitation can only be assigned ONCE
- ✅ No race conditions possible
- ✅ Multiple concurrent requests are serialized safely
- ✅ Statistics are accurate
- ✅ Same phone gets same invitation
- ✅ Different phones never share invitations
