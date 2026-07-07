import { Routes, Route, useLocation, useParams } from 'react-router-dom';
import { useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { supabase } from './lib/supabase';
import type { EventRecord, InvitationRecord, GuestRecord } from './types';

type EventFormState = {
  name: string;
  description: string;
  invitation_files: File[];
};

const emptyEvent: EventFormState = {
  name: '',
  description: '',
  invitation_files: [],
};

const createSlug = (value: string) => {
  const normalized = value
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  return `${normalized || 'event'}-${crypto.randomUUID().slice(0, 8)}`;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }

  return 'خطأ غير معروف';
};

const buildAppUrl = (path: string) => {
  const basePath = import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${window.location.origin}${basePath}${path}`;
};

const formatSupabaseError = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object') {
    const message = 'message' in error && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : null;
    const details = 'details' in error && typeof (error as { details?: unknown }).details === 'string'
      ? (error as { details: string }).details
      : null;

    return [message, details].filter(Boolean).join(' | ');
  }

  return 'خطأ غير معروف';
};

const normalizePhoneNumber = (phone: string) => phone.trim();

const extractStoragePath = (imageUrl: string) => {
  try {
    const url = new URL(imageUrl);
    const match = url.pathname.match(/\/storage\/v1\/object\/public\/invitations\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
};

const assignInvitationToGuest = async (eventId: string, guestId: string) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data: candidateInvitations, error: fetchError } = await supabase
      .from('invitations')
      .select('*')
      .eq('event_id', eventId)
      .eq('assigned', false)
      .order('created_at', { ascending: true })
      .limit(1);

    if (fetchError) {
      throw new Error(formatSupabaseError(fetchError));
    }

    const invitation = candidateInvitations?.[0];
    if (!invitation) {
      return null;
    }

    const { data: updatedInvitation, error: updateError } = await supabase
      .from('invitations')
      .update({
        assigned: true,
        assigned_to_guest: guestId,
        assigned_at: new Date().toISOString(),
      })
      .eq('id', invitation.id)
      .eq('assigned', false)
      .select('*')
      .single();

    if (updateError) {
      const updateErrorCode = typeof updateError === 'object' && updateError && 'code' in updateError
        ? (updateError as { code?: string }).code
        : undefined;

      if (updateErrorCode === 'PGRST116') {
        continue;
      }

      throw new Error(formatSupabaseError(updateError));
    }

    if (!updatedInvitation) {
      continue;
    }

    return updatedInvitation as InvitationRecord;
  }

  return null;
};

function App() {
  const [eventForm, setEventForm] = useState<EventFormState>(emptyEvent);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const location = useLocation();
  const isGuestRoute = location.pathname.startsWith('/e/');

  useEffect(() => {
    void loadEvents();
  }, []);

  const loadEvents = async () => {
    const { data, error } = await supabase.from('events').select('*').order('created_at', { ascending: false });
    if (error) {
      setMessage(getErrorMessage(error));
      return;
    }

    const { data: invitationData } = await supabase.from('invitations').select('event_id, assigned');
    const counts = new Map<string, { total: number; assigned: number }>();

    (invitationData ?? []).forEach((invitation) => {
      const current = counts.get(invitation.event_id) ?? { total: 0, assigned: 0 };
      current.total += 1;
      if (invitation.assigned) {
        current.assigned += 1;
      }
      counts.set(invitation.event_id, current);
    });

    setEvents(
      (data ?? []).map((event) => {
        const eventCounts = counts.get(event.id) ?? { total: 0, assigned: 0 };
        return {
          ...event,
          invitation_count: eventCounts.total,
          assigned_count: eventCounts.assigned,
        };
      }),
    );
  };

  const handleCreateEvent = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');

    if (!eventForm.name.trim() || !eventForm.description.trim()) {
      setMessage('يرجى إدخال اسم ووصف الحدث');
      setLoading(false);
      return;
    }

    if (eventForm.invitation_files.length === 0) {
      setMessage('يرجى اختيار صورة واحدة أو أكثر');
      setLoading(false);
      return;
    }

    const slug = createSlug(eventForm.name);
    const { data: createdEvent, error: eventError } = await supabase.from('events').insert({
      name: eventForm.name.trim(),
      description: eventForm.description.trim(),
      slug,
    }).select().single();

    if (eventError || !createdEvent) {
      const message = eventError ? `فشل إنشاء الحدث: ${getErrorMessage(eventError)}` : 'فشل إنشاء الحدث: لم يتم إرجاع بيانات الحدث';
      setMessage(message);
      setLoading(false);
      return;
    }

    const uploadedPaths: string[] = [];
    try {
      const uploadedUrls: string[] = [];
      for (const file of eventForm.invitation_files) {
        const fileName = `${createdEvent.id}/${Date.now()}-${file.name.replace(/\s+/g, '-')}`;
        const { error: uploadError } = await supabase.storage.from('invitations').upload(fileName, file, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type || 'application/octet-stream',
        });

        if (uploadError) {
          throw new Error(getErrorMessage(uploadError));
        }

        uploadedPaths.push(fileName);
        const { data: publicUrlData } = supabase.storage.from('invitations').getPublicUrl(fileName);
        uploadedUrls.push(publicUrlData.publicUrl);
      }

      const invitationRows = uploadedUrls.map((imageUrl) => ({
        event_id: createdEvent.id,
        image_url: imageUrl,
        assigned: false,
      }));

      const { error: invitationError } = await supabase.from('invitations').insert(invitationRows);
      if (invitationError) {
        throw new Error(getErrorMessage(invitationError));
      }
    } catch (err) {
      if (uploadedPaths.length > 0) {
        await supabase.storage.from('invitations').remove(uploadedPaths);
      }
      await supabase.from('events').delete().eq('id', createdEvent.id);
      setMessage(err instanceof Error ? `فشل حفظ الحدث: ${err.message}` : 'فشل حفظ الحدث');
      setLoading(false);
      return;
    }

    setMessage(`تم حفظ الحدث بنجاح مع ${eventForm.invitation_files.length} دعوة`);
    setEventForm(emptyEvent);
    await loadEvents();
    setLoading(false);
  };

  const handleDeleteEvent = async (eventId: string) => {
    if (!window.confirm('هل أنت متأكد من حذف هذا الحدث؟')) {
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const { data: invitationData, error: fetchError } = await supabase.from('invitations').select('image_url').eq('event_id', eventId);
      if (fetchError) {
        throw new Error(formatSupabaseError(fetchError));
      }

      const storagePaths = (invitationData ?? [])
        .map((record) => extractStoragePath(record.image_url))
        .filter((path): path is string => Boolean(path));

      if (storagePaths.length > 0) {
        const { error: removeError } = await supabase.storage.from('invitations').remove(storagePaths);
        if (removeError) {
          console.warn('Storage removal failed', removeError);
        }
      }

      const { error: guestsError } = await supabase.from('guests').delete().eq('event_id', eventId);
      if (guestsError) {
        throw new Error(formatSupabaseError(guestsError));
      }

      const { error: invitationsError } = await supabase.from('invitations').delete().eq('event_id', eventId);
      if (invitationsError) {
        throw new Error(formatSupabaseError(invitationsError));
      }

      const { error: eventError } = await supabase.from('events').delete().eq('id', eventId);
      if (eventError) {
        throw new Error(formatSupabaseError(eventError));
      }

      const [{ data: remainingGuests }, { data: remainingInvitations }, { data: remainingEvents }] = await Promise.all([
        supabase.from('guests').select('id').eq('event_id', eventId).limit(1),
        supabase.from('invitations').select('id').eq('event_id', eventId).limit(1),
        supabase.from('events').select('id').eq('id', eventId).limit(1),
      ]);

      if ((remainingGuests ?? []).length > 0 || (remainingInvitations ?? []).length > 0 || (remainingEvents ?? []).length > 0) {
        throw new Error('لم يتم حذف جميع الصفوف المتعلقة بالحدث من قاعدة البيانات');
      }

      setEvents((prevEvents) => prevEvents.filter((event) => event.id !== eventId));
      await loadEvents();
      setMessage('تم حذف الحدث بنجاح');
    } catch (error) {
      setMessage(`فشل حذف الحدث: ${formatSupabaseError(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyGuestLink = async (slug: string) => {
    await navigator.clipboard.writeText(buildAppUrl(`/e/${slug}`));
    setMessage('تم نسخ رابط الدعوة');
  };

  const handleCopyStatsLink = async (slug: string) => {
    await navigator.clipboard.writeText(buildAppUrl(`/stats/${slug}`));
    setMessage('تم نسخ رابط الإحصائيات');
  };

  const handleOpenGuestLink = (slug: string) => {
    window.open(buildAppUrl(`/e/${slug}`), '_blank');
  };

  const handleOpenStatsLink = (slug: string) => {
    window.open(buildAppUrl(`/stats/${slug}`), '_blank');
  };

  return (
    <div className="app-shell">
      {!isGuestRoute ? (
        <header>
          <h1>مدير الدعوات</h1>
          <p>إنشاء المناسبات وإدارة الحضور عبر Supabase</p>
        </header>
      ) : null}

      {!isGuestRoute && message ? <div className="notice">{message}</div> : null}

      <Routes>
        <Route
          path="/"
          element={
            <AdminDashboard
              events={events}
              eventForm={eventForm}
              setEventForm={setEventForm}
              handleCreateEvent={handleCreateEvent}
              loading={loading}
              onDeleteEvent={handleDeleteEvent}
              onCopyGuestLink={handleCopyGuestLink}
              onCopyStatsLink={handleCopyStatsLink}
              onOpenGuestLink={handleOpenGuestLink}
              onOpenStatsLink={handleOpenStatsLink}
            />
          }
        />
        <Route path="/e/:slug" element={<GuestPage />} />
        <Route path="/stats/:slug" element={<StatisticsPage />} />
      </Routes>
    </div>
  );
}

type AdminDashboardProps = {
  events: EventRecord[];
  eventForm: EventFormState;
  setEventForm: Dispatch<SetStateAction<EventFormState>>;
  handleCreateEvent: (event: FormEvent) => Promise<void>;
  loading: boolean;
  onDeleteEvent: (eventId: string) => Promise<void>;
  onCopyGuestLink: (slug: string) => Promise<void>;
  onCopyStatsLink: (slug: string) => Promise<void>;
  onOpenGuestLink: (slug: string) => void;
  onOpenStatsLink: (slug: string) => void;
};

function AdminDashboard({
  events,
  eventForm,
  setEventForm,
  handleCreateEvent,
  loading,
  onDeleteEvent,
  onCopyGuestLink,
  onCopyStatsLink,
  onOpenGuestLink,
  onOpenStatsLink,
}: AdminDashboardProps) {
  const totalInvitations = events.reduce((sum, event) => sum + event.invitation_count, 0);
  const distributedInvitations = events.reduce((sum, event) => sum + event.assigned_count, 0);
  const remainingInvitations = totalInvitations - distributedInvitations;

  return (
    <>
      <section className="stats-grid">
        <div className="stat-card">
          <span>إجمالي الأحداث</span>
          <strong>{events.length}</strong>
        </div>
        <div className="stat-card">
          <span>إجمالي الدعوات</span>
          <strong>{totalInvitations}</strong>
        </div>
        <div className="stat-card">
          <span>الموزعة</span>
          <strong>{distributedInvitations}</strong>
        </div>
        <div className="stat-card">
          <span>المتبقية</span>
          <strong>{remainingInvitations}</strong>
        </div>
      </section>

      <main className="grid">
        <section className="card">
          <h2>إنشاء حدث جديد</h2>
          <form onSubmit={handleCreateEvent} className="form-stack">
            <label>
              اسم الحدث
              <input value={eventForm.name} onChange={(e) => setEventForm({ ...eventForm, name: e.target.value })} required />
            </label>
            <label>
              الوصف
              <textarea value={eventForm.description} onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })} required />
            </label>
            <label>
              صور الدعوات
              <input type="file" multiple accept="image/*" onChange={(e) => setEventForm({ ...eventForm, invitation_files: Array.from(e.target.files ?? []) })} />
            </label>
            <button type="submit" disabled={loading}>{loading ? 'جاري الحفظ...' : 'حفظ الحدث'}</button>
          </form>
        </section>

        <section className="card">
          <h2>الأحداث الحالية</h2>
          {events.length === 0 ? <p>لا توجد أحداث حتى الآن.</p> : (
            <div className="event-list">
              {events.map((event) => (
                <article key={event.id} className="event-card">
                  <div className="event-card-header">
                    <div>
                      <h3>{event.name}</h3>
                      <p>{event.description}</p>
                    </div>
                    <button type="button" className="danger-button" onClick={() => void onDeleteEvent(event.id)}>
                      🗑 حذف الفعالية
                    </button>
                  </div>

                  <ul className="event-metrics">
                    <li>إجمالي الدعوات: {event.invitation_count}</li>
                    <li>الموزعة: {event.assigned_count}</li>
                    <li>المتبقية: {Math.max(event.invitation_count - event.assigned_count, 0)}</li>
                  </ul>

                  <div className="button-group">
                    <button type="button" className="secondary-button" onClick={() => void onCopyGuestLink(event.slug)}>
                      📋 نسخ رابط الدعوة
                    </button>
                    <button type="button" className="secondary-button" onClick={() => onOpenGuestLink(event.slug)}>
                      🔗 فتح رابط الدعوة
                    </button>
                    <button type="button" className="secondary-button" onClick={() => void onCopyStatsLink(event.slug)}>
                      📋 نسخ رابط الإحصائيات
                    </button>
                    <button type="button" className="secondary-button" onClick={() => onOpenStatsLink(event.slug)}>
                      🔍 فتح الإحصائيات
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  );
}

function GuestPage() {
  const { slug } = useParams();
  const [event, setEvent] = useState<EventRecord | null>(null);
  const [guestForm, setGuestForm] = useState({ name: '', phone: '' });
  const [message, setMessage] = useState('');
  const [assignedInvitation, setAssignedInvitation] = useState<InvitationRecord | null>(null);
  const [registeredGuest, setRegisteredGuest] = useState<GuestRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [eventClosed, setEventClosed] = useState(false);
  const [attendanceChoice, setAttendanceChoice] = useState<'attend' | 'decline' | null>(null);
  const [showRegistrationForm, setShowRegistrationForm] = useState(true);

  useEffect(() => {
    void loadGuestPage();
  }, [slug]);

  const getInvitationNumber = async (eventId: string, invitationId: string) => {
    const { data } = await supabase.from('invitations').select('id').eq('event_id', eventId).order('created_at', { ascending: true });
    const foundIndex = data?.findIndex((invitation) => invitation.id === invitationId);
    return foundIndex !== undefined && foundIndex >= 0 ? foundIndex + 1 : null;
  };

  const loadGuestPage = async () => {
    if (!slug) {
      setEvent(null);
      return;
    }

    const { data: eventData, error: eventError } = await supabase.from('events').select('*').eq('slug', slug).maybeSingle();
    if (eventError || !eventData) {
      setEvent(null);
      setMessage('الحدث غير متوفر');
      setEventClosed(true);
      return;
    }

    setEvent(eventData);
    setMessage('');
    const { data: invitationData, error: invitationError } = await supabase.from('invitations').select('id').eq('event_id', eventData.id).eq('assigned', false).limit(1).maybeSingle();
    if (invitationError) {
      setMessage('فشل التحقق من توفر الدعوات');
      return;
    }

    setEventClosed(!invitationData);
    setAssignedInvitation(null);
    setRegisteredGuest(null);
    setGuestForm({ name: '', phone: '' });
    setAttendanceChoice(null);
    setShowRegistrationForm(true);
  };

  const validatePhoneNumber = (phone: string) => {
    if (!phone.trim()) {
      return 'رقم الهاتف مطلوب';
    }

    if (!phone.startsWith('05')) {
      return 'يجب أن يبدأ رقم الهاتف بـ 05';
    }

    if (!/^\d+$/.test(phone)) {
      return 'يجب أن يحتوي رقم الهاتف على أرقام فقط';
    }

    if (phone.length !== 10) {
      return 'يجب أن يتكون رقم الهاتف من 10 أرقام';
    }

    return null;
  };

  const handleAttendanceChoice = async (choice: 'attend' | 'decline') => {
    if (!event) {
      return;
    }

    setLoading(true);
    setMessage('');
    setAttendanceChoice(choice);

    if (choice === 'decline') {
      const { data: existingGuest, error: existingError } = await supabase
        .from('guests')
        .select('*')
        .eq('event_id', event.id)
        .eq('phone', normalizePhoneNumber(guestForm.phone))
        .maybeSingle();

      if (existingError) {
        setMessage(`فشل حفظ الاختيار: ${formatSupabaseError(existingError)}`);
        setLoading(false);
        return;
      }

      if (existingGuest) {
        const { error: updateError } = await supabase
          .from('guests')
          .update({ attendance_status: 'declined' })
          .eq('id', existingGuest.id);

        if (updateError) {
          setMessage(`فشل حفظ الاختيار: ${formatSupabaseError(updateError)}`);
          setLoading(false);
          return;
        }

        setRegisteredGuest(existingGuest);
        setShowRegistrationForm(false);
        setMessage('نأمل لقاءكم في فرصة قادمة.');
        setLoading(false);
        return;
      }

      const { data: newGuest, error: guestError } = await supabase
        .from('guests')
        .insert({
          event_id: event.id,
          name: guestForm.name.trim() || null,
          phone: normalizePhoneNumber(guestForm.phone) || null,
          invitation_id: null,
          attendance_status: 'declined',
        })
        .select()
        .single();

      if (guestError || !newGuest) {
        setMessage(`فشل حفظ الاختيار: ${formatSupabaseError(guestError)}`);
        setLoading(false);
        return;
      }

      setRegisteredGuest(newGuest);
      setShowRegistrationForm(false);
      setMessage('نأمل لقاءكم في فرصة قادمة.');
      setLoading(false);
      return;
    }

    setShowRegistrationForm(true);
    setLoading(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!event) {
      return;
    }

    setLoading(true);
    setMessage('');

    const normalizedPhone = normalizePhoneNumber(guestForm.phone);
    const trimmedName = guestForm.name.trim();

    if (!trimmedName) {
      setMessage('يرجى إدخال الاسم');
      setLoading(false);
      return;
    }

    const phoneValidationMessage = validatePhoneNumber(normalizedPhone);
    if (phoneValidationMessage) {
      setMessage(phoneValidationMessage);
      setLoading(false);
      return;
    }

    const { data: existingGuest, error: existingError } = await supabase
      .from('guests')
      .select('*')
      .eq('event_id', event.id)
      .eq('phone', normalizedPhone)
      .maybeSingle();

    if (existingError) {
      setMessage(`فشل التحقق من رقم الهاتف: ${formatSupabaseError(existingError)}`);
      setLoading(false);
      return;
    }

    if (existingGuest) {
      let existingInvitation: InvitationRecord | null = null;

      if (existingGuest.invitation_id) {
        const { data: invitationData, error: existingInvitationError } = await supabase
          .from('invitations')
          .select('*')
          .eq('id', existingGuest.invitation_id)
          .maybeSingle();

        if (existingInvitationError) {
          setMessage(`فشل جلب الدعوة السابقة: ${formatSupabaseError(existingInvitationError)}`);
          setLoading(false);
          return;
        }

        if (invitationData) {
          existingInvitation = invitationData as InvitationRecord;
        }
      }

      if (existingInvitation) {
        const invitationNumber = await getInvitationNumber(event.id, existingInvitation.id);
        setAssignedInvitation({ ...existingInvitation, invitation_number: invitationNumber ?? undefined });
      } else {
        setAssignedInvitation(null);
      }

      const guestName = existingGuest.name ?? trimmedName;
      const guestPhone = existingGuest.phone ?? normalizedPhone;
      setRegisteredGuest({ ...existingGuest, name: guestName, phone: guestPhone });
      setEventClosed(false);
      setShowRegistrationForm(false);
      setMessage(`أهلاً ${guestName}، تم عرض دعوتك السابقة`);
      setLoading(false);
      return;
    }

    const { data: newGuest, error: guestError } = await supabase
      .from('guests')
      .insert({
        event_id: event.id,
        name: trimmedName,
        phone: normalizedPhone,
        invitation_id: null,
        attendance_status: 'attending',
      })
      .select()
      .single();

    if (guestError || !newGuest) {
      if (guestError?.message?.includes('unique') || guestError?.message?.includes('duplicate')) {
        setMessage('يرجى استخدام رقم هاتف مختلف أو تحقق من بيناتك');
      } else {
        setMessage(`فشل تسجيل الحضور: ${formatSupabaseError(guestError)}`);
      }
      setLoading(false);
      return;
    }

    try {
      const assignedInvitation = await assignInvitationToGuest(event.id, newGuest.id);

      if (!assignedInvitation) {
        await supabase.from('guests').delete().eq('id', newGuest.id);
        setMessage('عذراً، تم توزيع جميع الدعوات');
        setEventClosed(true);
        setLoading(false);
        return;
      }

      const { error: updateGuestError } = await supabase
        .from('guests')
        .update({ invitation_id: assignedInvitation.id })
        .eq('id', newGuest.id);

      if (updateGuestError) {
        await supabase
          .from('invitations')
          .update({
            assigned: false,
            assigned_to_guest: null,
            assigned_at: null,
          })
          .eq('id', assignedInvitation.id)
          .eq('assigned_to_guest', newGuest.id);
        await supabase.from('guests').delete().eq('id', newGuest.id);
        setMessage(`فشل حفظ الدعوة: ${formatSupabaseError(updateGuestError)}`);
        setLoading(false);
        return;
      }

      const invitationNumber = await getInvitationNumber(event.id, assignedInvitation.id);
      setAssignedInvitation({
        ...assignedInvitation,
        invitation_number: invitationNumber ?? undefined,
      });

      const updatedGuest = { ...newGuest, invitation_id: assignedInvitation.id, attendance_status: 'attending' };
      setRegisteredGuest(updatedGuest);
      setMessage(`أهلاً ${trimmedName}، تم تأكيد دعوتك بنجاح`);
      setGuestForm({ name: '', phone: '' });
      setEventClosed(false);
      setShowRegistrationForm(false);
    } catch (error) {
      await supabase.from('guests').delete().eq('id', newGuest.id);
      setMessage(`فشل تخصيص الدعوة: ${formatSupabaseError(error)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="guest-page card">
      <h2>{event?.name ?? 'صفحة الدعوة'}</h2>
      <p>{event?.description ?? 'يرجى تسجيل بياناتك لتأكيد الدعوة'}</p>

      {registeredGuest && assignedInvitation ? (
        <section className="guest-welcome card">
          <h3>أهلاً {registeredGuest.name ?? 'ضيفنا'}، تم تأكيد دعوتك بنجاح</h3>
          <p>الفعالية: {event?.name}</p>
          <p>الاسم: {registeredGuest.name ?? '—'}</p>
          <p>رقم الهاتف: {registeredGuest.phone ?? '—'}</p>
          <p>رقم الدعوة: {assignedInvitation.invitation_number ?? '—'}</p>
          <img src={assignedInvitation.image_url} alt="دعوة" className="invitation-image" />
        </section>
      ) : null}

      {registeredGuest && !assignedInvitation && attendanceChoice === 'decline' ? (
        <section className="guest-welcome card">
          <h3>شكرًا لردكم</h3>
          <p>{message || 'نأمل لقاءكم في فرصة قادمة.'}</p>
        </section>
      ) : null}

      {eventClosed ? <div className="notice">عذراً، تم توزيع جميع الدعوات</div> : null}
      {message && (!registeredGuest || showRegistrationForm) ? <div className="notice">{message}</div> : null}

      {!registeredGuest || showRegistrationForm ? (
        <>
          <div className="choice-card">
            <h3>هل ستحضر الفعالية؟</h3>
            <div className="attendance-buttons">
              <button type="button" className="attendance-button attendance-button--attend" onClick={() => void handleAttendanceChoice('attend')} disabled={loading}>
                ✅ سأحضر
              </button>
              <button type="button" className="attendance-button attendance-button--decline" onClick={() => void handleAttendanceChoice('decline')} disabled={loading}>
                ❌ أعتذر عن الحضور
              </button>
            </div>
          </div>

          {attendanceChoice === 'attend' ? (
            <form onSubmit={handleSubmit} className="form-stack">
              <label>
                الاسم
                <input
                  value={guestForm.name}
                  onChange={(e) => setGuestForm({ ...guestForm, name: e.target.value })}
                  required
                  placeholder="اكتب اسمك هنا"
                />
              </label>
              <label>
                رقم الهاتف
                <input
                  value={guestForm.phone}
                  onChange={(e) => setGuestForm({ ...guestForm, phone: e.target.value })}
                  required
                  placeholder="05XXXXXXXX"
                  pattern="05[0-9]{8}"
                  title="يرجى إدخال رقم جوال سعودي صالح يبدأ بـ 05 ويتكون من 10 أرقام"
                />
              </label>
              <button type="submit" disabled={loading}>{loading ? 'جاري التسجيل...' : 'تسجيل الحضور'}</button>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function StatisticsPage() {
  const { slug } = useParams();
  const [event, setEvent] = useState<EventRecord | null>(null);
  const [guests, setGuests] = useState<GuestRecord[]>([]);
  const [invitations, setInvitations] = useState<InvitationRecord[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedInvitation, setSelectedInvitation] = useState<InvitationRecord | null>(null);

  useEffect(() => {
    void loadStatistics();
  }, [slug]);

  const loadStatistics = async () => {
    if (!slug) {
      setMessage('رابط الإحصائيات غير صالح');
      setLoading(false);
      return;
    }

    setLoading(true);
    setMessage('');

    const { data: eventData, error: eventError } = await supabase.from('events').select('*').eq('slug', slug).maybeSingle();
    if (eventError || !eventData) {
      setMessage(eventError ? `فشل جلب الحدث: ${getErrorMessage(eventError)}` : 'لم يتم العثور على الحدث');
      setLoading(false);
      return;
    }

    const [invitationResult, guestResult] = await Promise.all([
      supabase.from('invitations').select('*').eq('event_id', eventData.id).order('created_at', { ascending: true }),
      supabase.from('guests').select('*').eq('event_id', eventData.id).order('created_at', { ascending: true }),
    ]);

    if (invitationResult.error) {
      setMessage(`فشل جلب الدعوات: ${getErrorMessage(invitationResult.error)}`);
      setLoading(false);
      return;
    }

    if (guestResult.error) {
      setMessage(`فشل جلب الضيوف: ${getErrorMessage(guestResult.error)}`);
      setLoading(false);
      return;
    }

    setEvent(eventData);
    setInvitations(invitationResult.data ?? []);
    setGuests(guestResult.data ?? []);
    setLoading(false);
  };

  const totalInvitations = invitations.length;
  const distributedInvitations = invitations.filter((invitation) => invitation.assigned).length;
  const remainingInvitations = totalInvitations - distributedInvitations;
  const confirmedGuests = guests.length;

  const getInvitationNumber = (invitationId: string | null) => {
    if (!invitationId) {
      return '—';
    }
    const index = invitations.findIndex((invitation) => invitation.id === invitationId);
    return index >= 0 ? index + 1 : '—';
  };

  const getInvitationImage = (invitationId: string | null) => {
    return invitations.find((invitation) => invitation.id === invitationId)?.image_url ?? '';
  };

  if (loading) {
    return <div className="card"><p>جاري جلب الإحصائيات...</p></div>;
  }

  if (message) {
    return <div className="card"><div className="notice">{message}</div></div>;
  }

  return (
    <div className="card">
      <h2>إحصائيات الحدث</h2>
      <h3>{event?.name}</h3>
      <section className="stats-grid stats-grid--small">
        <div className="stat-card">
          <span>إجمالي الدعوات</span>
          <strong>{totalInvitations}</strong>
        </div>
        <div className="stat-card">
          <span>الموزعة</span>
          <strong>{distributedInvitations}</strong>
        </div>
        <div className="stat-card">
          <span>المتبقية</span>
          <strong>{remainingInvitations}</strong>
        </div>
        <div className="stat-card">
          <span>الضيوف المؤكدين</span>
          <strong>{confirmedGuests}</strong>
        </div>
      </section>

      <div className="table-wrapper">
        <table className="stats-table">
          <thead>
            <tr>
              <th>الاسم</th>
              <th>رقم الهاتف</th>
              <th>الصورة</th>
              <th>رقم الدعوة</th>
              <th>عرض الدعوة</th>
              <th>تاريخ التسجيل</th>
            </tr>
          </thead>
          <tbody>
            {guests.length === 0 ? (
              <tr>
                <td colSpan={6}>لا توجد ضيوف مسجلين حتى الآن.</td>
              </tr>
            ) : (
              guests.map((guest) => {
                const invitation = invitations.find((item) => item.id === guest.invitation_id);
                return (
                  <tr key={guest.id}>
                    <td>{guest.name ?? '—'}</td>
                    <td>{guest.phone ?? '—'}</td>
                    <td>
                      {guest.invitation_id ? (
                        <img src={getInvitationImage(guest.invitation_id)} alt="دعوة" className="table-invitation-image" />
                      ) : '—'}
                    </td>
                    <td>{getInvitationNumber(guest.invitation_id)}</td>
                    <td>
                      {invitation ? (
                        <button type="button" className="secondary-button" onClick={() => setSelectedInvitation(invitation)}>
                          فتح الدعوة
                        </button>
                      ) : '—'}
                    </td>
                    <td>{new Date(guest.created_at).toLocaleString('ar-EG')}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {selectedInvitation ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setSelectedInvitation(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="modal-close" onClick={() => setSelectedInvitation(null)}>
              إغلاق
            </button>
            <h3>عرض الدعوة</h3>
            <p><strong>الاسم:</strong> {guests.find((guest) => guest.invitation_id === selectedInvitation.id)?.name ?? '—'}</p>
            <p><strong>رقم الدعوة:</strong> {getInvitationNumber(selectedInvitation.id)}</p>
            <img src={selectedInvitation.image_url} alt="دعوة" className="modal-image" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
