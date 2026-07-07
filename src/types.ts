export type EventRecord = {
  id: string;
  name: string;
  description: string;
  slug: string;
  created_at: string;
  invitation_count: number;
  assigned_count: number;
};

export type InvitationRecord = {
  id: string;
  event_id: string;
  image_url: string;
  assigned: boolean;
  assigned_to_guest: string | null;
  assigned_at: string | null;
  created_at: string;
  invitation_number?: number;
};

export type GuestRecord = {
  id: string;
  event_id: string;
  name: string | null;
  phone: string | null;
  invitation_id: string | null;
  attendance_status?: string | null;
  created_at: string;
};
