# Manual Testing Checklist - Invitation Assignment Bug Fix

## Pre-Test Setup

- [ ] Deploy updated `supabase-schema.sql` to your Supabase project
  - This adds the `assign_invitation()` function and constraints
- [ ] Deploy updated `src/App.tsx` (or build and deploy the app)
- [ ] Clear any existing test data from the database if needed

---

## Test 1: Basic Invitation Assignment ✅

**Objective**: Verify a single guest can get an invitation

### Steps
1. [ ] Create a new event with the name "Test Event - Single Invitation"
2. [ ] Upload 1 invitation image
3. [ ] Open the guest registration page (copy the guest link)
4. [ ] Register Guest A:
   - Name: "Guest A"
   - Phone: "0501234567"
5. [ ] Submit registration

### Expected Results
- [ ] Guest A sees the invitation image displayed
- [ ] Message shows: "أهلاً Guest A، تم تأكيد دعوتك بنجاح"
- [ ] Invitation number shows: "1"
- [ ] In statistics page:
  - [ ] Total Invitations: 1
  - [ ] Distributed: 1
  - [ ] Remaining: 0
  - [ ] Guest A appears in the list

### Verification Query
```sql
-- In Supabase SQL editor, run:
SELECT 
  g.name,
  g.phone,
  i.assigned,
  i.assigned_to_guest,
  COUNT(*) over (partition by i.id) as assignments_count
FROM guests g
LEFT JOIN invitations i ON g.invitation_id = i.id
WHERE g.event_id = 'YOUR_EVENT_ID';
-- Should show: 1 row, with i.assigned = true
```

---

## Test 2: Second Guest Gets Error (THE CRITICAL TEST) ⚠️

**Objective**: Verify the bug is fixed - second guest CANNOT get same invitation

### Steps
1. [ ] From the same event as Test 1, open a NEW browser tab/window
   - **Important**: Use incognito/private browsing or different browser to ensure fresh session
2. [ ] Visit the same guest registration link
3. [ ] Register Guest B:
   - Name: "Guest B"
   - Phone: "0509876543" (DIFFERENT phone than Guest A)
4. [ ] Submit registration

### Expected Results
- ✅ **Guest B DOES NOT receive an invitation image**
- ✅ Guest B sees error message: "عذراً، تم توزيع جميع الدعوات"
- ✅ No form reset, form stays visible
- ✅ In statistics page:
  - [ ] Total Invitations: Still 1
  - [ ] Distributed: Still 1
  - [ ] Remaining: Still 0
  - [ ] Guest B is **NOT** in the guest list (or has NULL invitation_id if created)

### Verification Query
```sql
-- Verify Guest B did NOT get an invitation:
SELECT 
  name,
  phone,
  invitation_id
FROM guests
WHERE phone = '0509876543' AND event_id = 'YOUR_EVENT_ID';
-- Should show: invitation_id = NULL (or guest record not present)

-- Verify only 1 guest got the invitation:
SELECT COUNT(*) as guest_count
FROM guests
WHERE event_id = 'YOUR_EVENT_ID' AND invitation_id IS NOT NULL;
-- Should show: 1
```

---

## Test 3: Same Phone Gets Same Invitation ✅

**Objective**: Verify that the same phone number can retrieve their previous invitation

### Steps
1. [ ] From guest registration page, register with Guest A's details again:
   - Name: "Guest A" (or different name)
   - Phone: "0501234567" (SAME as Test 1)
2. [ ] Submit registration

### Expected Results
- [ ] System recognizes existing guest
- [ ] Message shows: "أهلاً Guest A، تم عرض دعوتك السابقة"
- [ ] Same invitation image is displayed
- [ ] Same invitation number: "1"
- [ ] In statistics page:
  - [ ] Still only 1 guest listed
  - [ ] No duplicate entries

### Verification Query
```sql
-- Verify only one guest record exists for this phone:
SELECT COUNT(*) as record_count
FROM guests
WHERE phone = '0501234567' AND event_id = 'YOUR_EVENT_ID';
-- Should show: 1
```

---

## Test 4: Multiple Invitations Work Correctly ✅

**Objective**: Verify normal flow works with multiple invitations

### Steps
1. [ ] Create new event "Test Event - 3 Invitations"
2. [ ] Upload 3 different invitation images
3. [ ] Register Guest A:
   - Phone: "0501111111"
4. [ ] In new browser tab, register Guest B:
   - Phone: "0502222222"
5. [ ] In new browser tab, register Guest C:
   - Phone: "0503333333"
6. [ ] Try to register Guest D in new browser tab:
   - Phone: "0504444444"

### Expected Results
- [ ] Guest A: Gets invitation #1 ✅
- [ ] Guest B: Gets invitation #2 (different image) ✅
- [ ] Guest C: Gets invitation #3 (different image) ✅
- [ ] Guest D: Sees error "عذراً، تم توزيع جميع الدعوات" ✅
- [ ] In statistics page:
  - [ ] Total: 3
  - [ ] Distributed: 3
  - [ ] Remaining: 0
  - [ ] All 3 guests listed

### Verification Query
```sql
-- Verify each guest has exactly ONE invitation and all are different:
SELECT 
  COUNT(DISTINCT g.id) as unique_guests,
  COUNT(DISTINCT i.id) as unique_invitations,
  COUNT(*) as total_assignments
FROM guests g
LEFT JOIN invitations i ON g.invitation_id = i.id
WHERE g.event_id = 'YOUR_EVENT_ID' AND i.assigned = true;
-- Should show: 3, 3, 3 (all unique)

-- Verify no invitation is assigned to multiple guests:
SELECT 
  i.id,
  COUNT(g.id) as guest_count
FROM invitations i
LEFT JOIN guests g ON i.invitation_id = i.id
WHERE i.event_id = 'YOUR_EVENT_ID' AND i.assigned = true
GROUP BY i.id
HAVING COUNT(g.id) > 1;
-- Should show: 0 rows (empty)
```

---

## Test 5: Concurrent Registration (Stress Test) 🚀

**Objective**: Verify atomic assignment under concurrent load

### Steps (Simulated Concurrency)
1. [ ] Create event "Test Event - Concurrent" with 1 invitation
2. [ ] Quickly open multiple browser tabs with the guest registration page
   - Tab 1: Guest A
   - Tab 2: Guest B
   - Tab 3: Guest C
3. [ ] Fill in forms in all tabs (without submitting yet):
   - Tab 1: Name "Guest A", Phone "0505555555"
   - Tab 2: Name "Guest B", Phone "0506666666"
   - Tab 3: Name "Guest C", Phone "0507777777"
4. [ ] Click Submit on **all tabs simultaneously** (or as fast as possible)

### Expected Results
- ✅ **Only ONE guest gets the invitation** (not all three)
- ✅ Other two guests see error: "عذراً، تم توزيع جميع الدعوات"
- ✅ Statistics show: Distributed = 1, Remaining = 0
- ✅ Exactly 1 guest in the guest list

### Why This Proves the Fix
- **Before Fix**: All 3 might get the invitation (race condition) ❌
- **After Fix**: Only 1 gets it (atomic assignment) ✅

---

## Test 6: Statistics Accuracy ✅

**Objective**: Verify all statistics are calculated correctly

### Steps
1. [ ] Go to statistics page for any event
2. [ ] Verify the calculations match database:
   - Total Invitations = sum of all invitations for this event
   - Distributed = count where assigned = true
   - Remaining = Total - Distributed
   - Confirmed Guests = count of guests

### Verification Query
```sql
-- Calculate expected statistics:
WITH stats AS (
  SELECT 
    COUNT(*) as total_invitations,
    SUM(CASE WHEN assigned = true THEN 1 ELSE 0 END) as distributed
  FROM invitations
  WHERE event_id = 'YOUR_EVENT_ID'
)
SELECT 
  total_invitations,
  distributed,
  (total_invitations - distributed) as remaining
FROM stats;
```

---

## Test 7: Error Handling ✅

**Objective**: Verify error messages are clear and helpful

### Steps
1. [ ] Try registering with invalid phone format
   - Phone: "123" (too short)
   - **Expected**: Error message about phone format

2. [ ] Try registering with missing name
   - Name: "" (empty)
   - **Expected**: Error message about required name

3. [ ] Try registering with valid data but event doesn't exist
   - **Expected**: Error about event not found

---

## Database Health Check 🏥

After all tests, run these queries to verify data integrity:

### No Duplicate Invitations
```sql
SELECT COUNT(*) as should_be_zero
FROM (
  SELECT i.id
  FROM invitations i
  LEFT JOIN guests g ON i.invitation_id = i.id
  WHERE i.assigned = true
  GROUP BY i.id
  HAVING COUNT(g.id) > 1
) t;
```

### No Orphaned Assignments
```sql
-- Verify all assigned invitations have a corresponding guest
SELECT COUNT(*) as should_be_zero
FROM invitations i
WHERE i.assigned = true
AND NOT EXISTS (
  SELECT 1 FROM guests g WHERE g.invitation_id = i.id
);
```

### Unique Phone Per Event
```sql
-- Verify no duplicate phones per event
SELECT COUNT(*) as should_be_zero
FROM (
  SELECT event_id, phone
  FROM guests
  GROUP BY event_id, phone
  HAVING COUNT(*) > 1
) t;
```

### Statistics Match Database
```sql
-- For each event, verify stats are correct
SELECT 
  e.id,
  e.name,
  COUNT(i.id) as total_invitations,
  SUM(CASE WHEN i.assigned = true THEN 1 ELSE 0 END) as distributed_count,
  COUNT(DISTINCT g.id) as guest_count
FROM events e
LEFT JOIN invitations i ON e.id = i.event_id
LEFT JOIN guests g ON i.id = g.invitation_id
GROUP BY e.id, e.name
ORDER BY e.created_at DESC;
```

---

## Test Results Summary

| Test # | Name | Status | Notes |
|--------|------|--------|-------|
| 1 | Basic Assignment | [ ] ✅ | Single guest gets invitation |
| 2 | Second Guest Blocked | [ ] ✅ | **CRITICAL** - verifies bug fix |
| 3 | Same Phone Retrieval | [ ] ✅ | Same phone gets same invitation |
| 4 | Multiple Invitations | [ ] ✅ | Each guest gets unique invitation |
| 5 | Concurrent Requests | [ ] ✅ | Atomic assignment under load |
| 6 | Statistics Accuracy | [ ] ✅ | All calculations correct |
| 7 | Error Handling | [ ] ✅ | Proper error messages |
| DB | Health Check | [ ] ✅ | No data integrity issues |

---

## Sign-Off

- [ ] All tests passed
- [ ] No data integrity issues found
- [ ] Bug fix verified and working
- [ ] Ready for production deployment

**Tested by**: _______________  
**Date**: _______________  
**Notes**: _______________
