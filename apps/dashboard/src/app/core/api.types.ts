/** Response shapes from the API. Kept narrow — only what the UI renders. */

export type LeadStatus = 'new' | 'contacted' | 'completed' | 'cancelled';
export type CallOutcome =
  | 'lead_created'
  | 'callback_created'
  | 'faq_answered'
  | 'abandoned'
  | 'error';

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Lead {
  id: string;
  businessId: string;
  callId: string | null;
  customerName: string;
  customerPhone: string;
  service: string;
  location: string;
  destination: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleType: string | null;
  vehicleCondition: string | null;
  vehicleMovable: boolean | null;
  additionalNotes: string | null;
  /** 'high' for urgent or unsafe situations. */
  priority?: 'normal' | 'high';
  status: LeadStatus;
  createdAt: string;
}

export interface Call {
  id: string;
  fromNumber: string;
  toNumber: string;
  status: string;
  outcome: CallOutcome | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  finalState: string | null;
}

export interface TranscriptTurn {
  id: string;
  turnIndex: number;
  speaker: 'ai' | 'customer' | 'system';
  text: string;
  createdAt: string;
}

export interface CallEvent {
  id: string;
  type: string;
  sequence: number;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface CallbackRequest {
  id: string;
  callId: string | null;
  customerName: string | null;
  customerPhone: string;
  reason: string;
  transcriptSnapshot: string | null;
  status: 'open' | 'resolved';
  createdAt: string;
}

export interface CallDetail {
  call: Call;
  transcript: TranscriptTurn[];
  events: CallEvent[];
  lead: Lead | null;
  callbackRequests: CallbackRequest[];
  extractedInformation: Record<string, unknown>;
}

export interface NotificationRecord {
  id: string;
  channel: string;
  target: string;
  leadId: string | null;
  status: 'pending' | 'sent' | 'failed' | 'dead';
  attempts: number;
  lastError: string | null;
  payload: string;
  sentAt: string | null;
  createdAt: string;
}

export interface Overview {
  since: string;
  callsReceived: number;
  aiAnsweredCalls: number;
  leadsCaptured: number;
  openCallbackRequests: number;
  recentCalls: Call[];
  recentLeads: Lead[];
}

export interface BusinessHours {
  day: number;
  open: string;
  close: string;
  closed: boolean;
}

export interface BusinessProfile {
  business: {
    id: string;
    name: string;
    phone: string | null;
    website: string | null;
    address: string | null;
    timezone: string;
    serviceAreas: string[];
    businessHours: BusinessHours[];
    pricingInfo: string | null;
    emergencyContact: string | null;
    whatsappNumber: string | null;
    defaultRegionPrefix: string | null;
  };
  settings: {
    greeting: string | null;
    tone: 'professional' | 'friendly' | 'calm';
    businessInstructions: string | null;
    faq: Array<{ question: string; answer: string }>;
    fallbackBehavior: 'callback' | 'emergency_contact';
    language: string;
    maxCallSeconds: number;
  } | null;
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    isActive: boolean;
    sortOrder: number;
  }>;
  phoneNumbers: Array<{ id: string; e164: string; provider: string }>;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  businessId: string;
  user: { id: string; email: string; name: string; role: string };
}
