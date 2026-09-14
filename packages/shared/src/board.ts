/**
 * Board and compliance (equity-portal plan §6, phase 3).
 *
 * View shapes, plain-word label maps for every enum, and the pure quorum
 * arithmetic — the one calculation the client is allowed to do, because it is
 * exactly what s.174 defines and the API also computes it the same way on
 * `callMeeting`/`recordAttendance`, so this is a display convenience, never
 * the source of truth.
 */

// ---------------------------------------------------------------------------
// Enums and their labels.
// ---------------------------------------------------------------------------

export const BOARD_MEMBER_ROLES = [
  'director',
  'independent_director',
  'nominee_director',
  'observer',
  'company_secretary',
] as const;
export type BoardMemberRole = (typeof BOARD_MEMBER_ROLES)[number];

export const BOARD_MEMBER_ROLE_LABELS: Record<BoardMemberRole, string> = {
  director: 'Director',
  independent_director: 'Independent director',
  nominee_director: 'Nominee director',
  observer: 'Observer',
  company_secretary: 'Company secretary',
};

/** Roles that hold an actual board seat and count toward quorum and voting. */
export const VOTING_BOARD_ROLES: BoardMemberRole[] = ['director', 'independent_director', 'nominee_director'];

export const BOARD_MEMBER_STATUSES = ['active', 'ceased'] as const;
export type BoardMemberStatus = (typeof BOARD_MEMBER_STATUSES)[number];

export const MEETING_KINDS = ['board', 'agm', 'egm', 'committee'] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];

export const MEETING_KIND_LABELS: Record<MeetingKind, string> = {
  board: 'Board meeting',
  agm: 'Annual general meeting',
  egm: 'Extraordinary general meeting',
  committee: 'Committee meeting',
};

export const MEETING_MODES = ['physical', 'vc', 'hybrid'] as const;
export type MeetingMode = (typeof MEETING_MODES)[number];

export const MEETING_MODE_LABELS: Record<MeetingMode, string> = {
  physical: 'In person',
  vc: 'Video conference',
  hybrid: 'Hybrid',
};

export const MEETING_STATUSES = [
  'called',
  'minutes_draft',
  'minutes_circulated',
  'held',
  'minutes_entered',
  'minutes_signed',
  'cancelled',
] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  called: 'Called',
  held: 'Held',
  minutes_draft: 'Minutes drafted',
  minutes_circulated: 'Minutes circulated',
  minutes_entered: 'Minutes entered',
  minutes_signed: 'Minutes signed',
  cancelled: 'Cancelled',
};

export const RESOLUTION_KINDS = ['board', 'shareholder_ordinary', 'shareholder_special'] as const;
export type ResolutionKind = (typeof RESOLUTION_KINDS)[number];

export const RESOLUTION_KIND_LABELS: Record<ResolutionKind, string> = {
  board: 'Board resolution',
  shareholder_ordinary: 'Shareholder resolution (ordinary)',
  shareholder_special: 'Shareholder resolution (special)',
};

export const RESOLUTION_SUBJECTS = [
  'allotment',
  'transfer',
  'esop_scheme',
  'borrowing',
  'investment',
  'loan_or_guarantee',
  'financial_statements',
  'board_report',
  'diversification',
  'merger_or_acquisition',
  'buyback_authorisation',
  'calls_on_shares',
  'appointment',
  'related_party',
  'general',
  'other',
] as const;
export type ResolutionSubject = (typeof RESOLUTION_SUBJECTS)[number];

export const RESOLUTION_SUBJECT_LABELS: Record<ResolutionSubject, string> = {
  allotment: 'Allotment of shares',
  transfer: 'Transfer of shares',
  esop_scheme: 'ESOP scheme',
  borrowing: 'Borrowing',
  investment: 'Investment',
  loan_or_guarantee: 'Loan or guarantee',
  financial_statements: 'Financial statements',
  board_report: "Board's report",
  diversification: 'Diversification of business',
  merger_or_acquisition: 'Merger or acquisition',
  buyback_authorisation: 'Buy-back authorisation',
  calls_on_shares: 'Calls on shares',
  appointment: 'Appointment',
  related_party: 'Related-party transaction',
  general: 'General business',
  other: 'Other',
};

/**
 * s.179(3) read with Rule 8 of the Meetings of Board and its Powers Rules: a
 * resolution on one of these subjects may be passed only at a meeting, never
 * by circulation. `proposeResolution` derives `requiresMeeting` from this
 * list; it is never accepted as input.
 */
export const RESOLUTION_SUBJECTS_REQUIRING_MEETING: ResolutionSubject[] = [
  'allotment',
  'borrowing',
  'investment',
  'loan_or_guarantee',
  'financial_statements',
  'board_report',
  'diversification',
  'merger_or_acquisition',
  'buyback_authorisation',
  'calls_on_shares',
];

export const RESOLUTION_PASSED_BY = ['meeting', 'circulation'] as const;
export type ResolutionPassedBy = (typeof RESOLUTION_PASSED_BY)[number];

export const RESOLUTION_OUTCOMES = [
  'draft',
  'open',
  'passed',
  'failed',
  'withdrawn',
  'meeting_demanded',
] as const;
export type ResolutionOutcome = (typeof RESOLUTION_OUTCOMES)[number];

export const RESOLUTION_OUTCOME_LABELS: Record<ResolutionOutcome, string> = {
  draft: 'Draft',
  open: 'Open for voting',
  passed: 'Passed',
  failed: 'Failed',
  withdrawn: 'Withdrawn',
  meeting_demanded: 'Meeting demanded',
};

export const VOTE_CHOICES = ['for', 'against', 'abstain'] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];

export const VOTE_CHOICE_LABELS: Record<VoteChoice, string> = {
  for: 'For',
  against: 'Against',
  abstain: 'Abstain',
};

export const BOARD_PACK_ITEM_KINDS = [
  'notice',
  'agenda',
  'paper',
  'financial_summary',
  'minutes',
  'resolution',
  'other',
] as const;
export type BoardPackItemKind = (typeof BOARD_PACK_ITEM_KINDS)[number];

export const BOARD_PACK_ITEM_KIND_LABELS: Record<BoardPackItemKind, string> = {
  notice: 'Notice',
  agenda: 'Agenda',
  paper: 'Paper',
  financial_summary: 'Financial summary',
  minutes: 'Minutes',
  resolution: 'Resolution',
  other: 'Other',
};

export const COMPLIANCE_ITEM_STATUSES = ['open', 'done', 'waived'] as const;
export type ComplianceItemStatus = (typeof COMPLIANCE_ITEM_STATUSES)[number];

export const COMPLIANCE_ITEM_STATUS_LABELS: Record<ComplianceItemStatus, string> = {
  open: 'Open',
  done: 'Done',
  waived: 'Waived',
};

// ---------------------------------------------------------------------------
// Pure arithmetic (mirrored server-side; the client never computes anything
// this file does not already state).
// ---------------------------------------------------------------------------

/** s.174: two, or a third of the total membership, whichever is greater. */
export function quorumFor(activeDirectors: number): number {
  return Math.max(2, Math.ceil(activeDirectors / 3));
}

/** s.175: a third of the members may demand the matter go to a meeting instead. */
export function meetingDemandThreshold(activeDirectors: number): number {
  return Math.ceil(activeDirectors / 3);
}

// ---------------------------------------------------------------------------
// View types returned by the API.
// ---------------------------------------------------------------------------

export interface BoardMemberView {
  id: string;
  recordCode: string;
  personId: string;
  personName: string;
  role: BoardMemberRole;
  din: string | null;
  appointedOn: string;
  ceasedOn: string | null;
  interestsDeclaredOn: string | null;
  interestsDeclaredThisYear: boolean;
  interests: Array<{ entity: string; nature: string; since?: string }>;
  nominatedByHolderRef: string | null;
  status: BoardMemberStatus;
}

export interface BoardMeetingAttendee {
  boardMemberId: string;
  present: boolean;
  via?: MeetingMode;
}

export interface BoardMeetingAgendaItem {
  n: number;
  title: string;
  notes?: string;
  resolutionId?: string;
}

export interface BoardMeetingView {
  id: string;
  recordCode: string;
  kind: MeetingKind;
  title: string;
  noticeSentOn: string | null;
  scheduledFor: string;
  heldOn: string | null;
  mode: MeetingMode;
  venue: string | null;
  quorumRequired: number;
  attendees: BoardMeetingAttendee[];
  quorumMet: boolean | null;
  presentCount: number;
  agenda: BoardMeetingAgendaItem[];
  status: MeetingStatus;
  minutesDraftedOn: string | null;
  minutesCirculatedOn: string | null;
  minutesEnteredOn: string | null;
  minutesSignedOn: string | null;
  minutesText: string | null;
  minutesDocumentRef: string | null;
  chairedByBoardMemberId: string | null;
}

export interface ResolutionView {
  id: string;
  recordCode: string;
  kind: ResolutionKind;
  subject: ResolutionSubject;
  title: string;
  text: string;
  passedBy: ResolutionPassedBy | null;
  meetingId: string | null;
  requiresMeeting: boolean;
  circulatedOn: string | null;
  dispatchProofRef: string | null;
  votingClosesOn: string | null;
  outcome: ResolutionOutcome;
  passedOn: string | null;
  mgt14Srn: string | null;
  mgt14FiledOn: string | null;
  signedDocumentRef: string | null;
  subjectRef: string | null;
  proposedByPartyId: string;
  votes: VoteView[];
}

export interface VoteView {
  id: string;
  boardMemberId: string | null;
  holderRef: string | null;
  choice: VoteChoice;
  castAt: string;
  abstainedAsInterested: boolean;
  demandsMeeting: boolean;
}

export interface ComplianceItemView {
  id: string;
  recordCode: string;
  kind: string;
  title: string;
  basis: string;
  dueOn: string;
  status: ComplianceItemStatus;
  resolvedOn: string | null;
  filedRef: string | null;
  relatedType: string;
  relatedId: string;
  raisedByJob: boolean;
  overdue: boolean;
}

export interface BoardPackItemView {
  id: string;
  meetingId: string;
  title: string;
  kind: BoardPackItemKind;
  fileRef: string;
  addedByPartyId: string;
  order: number;
}

export interface BoardPackView {
  meeting: BoardMeetingView;
  items: BoardPackItemView[];
  resolutions: ResolutionView[];
}
