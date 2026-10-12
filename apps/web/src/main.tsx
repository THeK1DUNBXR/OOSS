import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { shouldRetryQuery } from './lib/api.js';
import { SessionProvider, useSession } from './lib/session.js';
import { useSurface } from './lib/surface.js';
import { Shell } from './components/Shell.js';
import { Loading } from './components/ui.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ChangePassword } from './pages/ChangePassword.js';
const Login = lazy(() => import('./pages/Login.js').then((m) => ({ default: m.Login })));
import { PortalShell } from './portal/PortalShell.js';
const Holdings = lazy(() => import('./portal/pages/Holdings.js').then((m) => ({ default: m.Holdings })));
const Certificates = lazy(() => import('./portal/pages/Certificates.js').then((m) => ({ default: m.Certificates })));
const Documents = lazy(() => import('./portal/pages/Documents.js').then((m) => ({ default: m.Documents })));
const Board = lazy(() => import('./portal/pages/Board.js').then((m) => ({ default: m.Board })));
const PortalEntities = lazy(() => import('./portal/pages/Entities.js').then((m) => ({ default: m.Entities })));
const PortalOptions = lazy(() => import('./portal/pages/Options.js').then((m) => ({ default: m.Options })));
const CapTable = lazy(() => import('./pages/equity/CapTable.js').then((m) => ({ default: m.CapTable })));
const Register = lazy(() => import('./pages/equity/Register.js').then((m) => ({ default: m.Register })));
const Holders = lazy(() => import('./pages/equity/Holders.js').then((m) => ({ default: m.Holders })));
const HolderDetail = lazy(() => import('./pages/equity/Holders.js').then((m) => ({ default: m.HolderDetail })));
const ShareClasses = lazy(() => import('./pages/equity/ShareClasses.js').then((m) => ({ default: m.ShareClasses })));
const Valuations = lazy(() => import('./pages/equity/Valuations.js').then((m) => ({ default: m.Valuations })));
const EquityDocuments = lazy(() => import('./pages/equity/Documents.js').then((m) => ({ default: m.Documents })));
const CertificateDocument = lazy(() =>
  import('./pages/equity/CertificateDocument.js').then((m) => ({ default: m.CertificateDocument })),
);
const Group = lazy(() => import('./pages/equity/Group.js').then((m) => ({ default: m.Group })));
const GroupEntity = lazy(() => import('./pages/equity/GroupEntity.js').then((m) => ({ default: m.GroupEntity })));
const Rounds = lazy(() => import('./pages/equity/Rounds.js').then((m) => ({ default: m.Rounds })));
const Scenarios = lazy(() => import('./pages/equity/Scenarios.js').then((m) => ({ default: m.Scenarios })));
const Esop = lazy(() => import('./pages/equity/Esop.js').then((m) => ({ default: m.Esop })));
const Filings = lazy(() => import('./pages/equity/Filings.js').then((m) => ({ default: m.Filings })));
const Sh4Sheet = lazy(() => import('./pages/equity/Sh4Sheet.js').then((m) => ({ default: m.Sh4Sheet })));
const MyOptions = lazy(() => import('./pages/MyOptions.js').then((m) => ({ default: m.MyOptions })));
const CommandCenter = lazy(() => import('./pages/CommandCenter.js').then((m) => ({ default: m.CommandCenter })));
const Workspace = lazy(() => import('./pages/Workspace.js').then((m) => ({ default: m.Workspace })));
const Exceptions = lazy(() => import('./pages/Workspace.js').then((m) => ({ default: m.Exceptions })));
const Pipeline = lazy(() => import('./pages/Pipeline.js').then((m) => ({ default: m.Pipeline })));
const Leads = lazy(() => import('./pages/Leads.js').then((m) => ({ default: m.Leads })));
const LeadDetail = lazy(() => import('./pages/Leads.js').then((m) => ({ default: m.LeadDetail })));
const Opportunities = lazy(() => import('./pages/Opportunities.js').then((m) => ({ default: m.Opportunities })));
const OpportunityDetail = lazy(() =>
  import('./pages/Opportunities.js').then((m) => ({ default: m.OpportunityDetail })),
);
const Forecast = lazy(() => import('./pages/Opportunities.js').then((m) => ({ default: m.Forecast })));
const Institutions = lazy(() => import('./pages/Parties.js').then((m) => ({ default: m.Institutions })));
const Organizations = lazy(() => import('./pages/Parties.js').then((m) => ({ default: m.Organizations })));
const BodyDetail = lazy(() => import('./pages/Parties.js').then((m) => ({ default: m.BodyDetail })));
const Students = lazy(() => import('./pages/Students.js').then((m) => ({ default: m.Students })));
const StudentDetail = lazy(() => import('./pages/Students.js').then((m) => ({ default: m.StudentDetail })));
const People = lazy(() => import('./pages/People.js').then((m) => ({ default: m.People })));
const PersonDetail = lazy(() => import('./pages/People.js').then((m) => ({ default: m.PersonDetail })));
const Interactions = lazy(() => import('./pages/People.js').then((m) => ({ default: m.Interactions })));
const Offerings = lazy(() => import('./pages/Commercial.js').then((m) => ({ default: m.Offerings })));
const Quotes = lazy(() => import('./pages/Commercial.js').then((m) => ({ default: m.Quotes })));
const Proposals = lazy(() => import('./pages/Commercial.js').then((m) => ({ default: m.Proposals })));
const Agreements = lazy(() => import('./pages/Commercial.js').then((m) => ({ default: m.Agreements })));
const Approvals = lazy(() => import('./pages/Commercial.js').then((m) => ({ default: m.Approvals })));
const WinLoss = lazy(() => import('./pages/Commercial.js').then((m) => ({ default: m.WinLoss })));
const Invoices = lazy(() => import('./pages/Finance.js').then((m) => ({ default: m.Invoices })));
const Payments = lazy(() => import('./pages/Finance.js').then((m) => ({ default: m.Payments })));
const Receivables = lazy(() => import('./pages/Finance.js').then((m) => ({ default: m.Receivables })));
const InvoiceDocument = lazy(() => import('./pages/InvoiceDocument.js').then((m) => ({ default: m.InvoiceDocument })));
const NewInvoice = lazy(() => import('./pages/kaizenInvoice/NewInvoice.js').then((m) => ({ default: m.NewInvoice })));
const InvoiceHistory = lazy(() =>
  import('./pages/kaizenInvoice/InvoiceHistory.js').then((m) => ({ default: m.InvoiceHistory })),
);
const ReceiptDocument = lazy(() => import('./pages/ReceiptDocument.js').then((m) => ({ default: m.ReceiptDocument })));
const Receipts = lazy(() => import('./pages/ReceiptDocument.js').then((m) => ({ default: m.Receipts })));
const FinalInvoiceDocument = lazy(() =>
  import('./pages/FinalInvoiceDocument.js').then((m) => ({ default: m.FinalInvoiceDocument })),
);
const FinalInvoices = lazy(() => import('./pages/FinalInvoiceDocument.js').then((m) => ({ default: m.FinalInvoices })));
const CompanyDetails = lazy(() => import('./pages/GstReturns.js').then((m) => ({ default: m.CompanyDetails })));
const GstReturns = lazy(() => import('./pages/GstReturns.js').then((m) => ({ default: m.GstReturns })));
const Cohorts = lazy(() => import('./pages/Education.js').then((m) => ({ default: m.Cohorts })));
const Enrollments = lazy(() => import('./pages/Education.js').then((m) => ({ default: m.Enrollments })));
const Projects = lazy(() => import('./pages/Education.js').then((m) => ({ default: m.Projects })));
const Courses = lazy(() => import('./pages/Courses.js').then((m) => ({ default: m.Courses })));
const LearnerQueue = lazy(() => import('./pages/StudentTimeline.js').then((m) => ({ default: m.LearnerQueue })));
const StudentTimeline = lazy(() => import('./pages/StudentTimeline.js').then((m) => ({ default: m.StudentTimeline })));
const PipelineAdmin = lazy(() => import('./pages/Admin.js').then((m) => ({ default: m.PipelineAdmin })));
const TerritoryAdmin = lazy(() => import('./pages/Admin.js').then((m) => ({ default: m.TerritoryAdmin })));
const Governance = lazy(() => import('./pages/Admin.js').then((m) => ({ default: m.Governance })));
const Agents = lazy(() => import('./pages/Admin.js').then((m) => ({ default: m.Agents })));
const Events = lazy(() => import('./pages/Admin.js').then((m) => ({ default: m.Events })));
const Jobs = lazy(() => import('./pages/Admin.js').then((m) => ({ default: m.Jobs })));
const Audit = lazy(() => import('./pages/Admin.js').then((m) => ({ default: m.Audit })));
const PlatformModel = lazy(() => import('./pages/Admin.js').then((m) => ({ default: m.PlatformModel })));
const Decisions = lazy(() => import('./pages/Decisions.js').then((m) => ({ default: m.Decisions })));
const Employees = lazy(() => import('./pages/PeopleOps.js').then((m) => ({ default: m.Employees })));
const EmployeeDetail = lazy(() => import('./pages/PeopleOps.js').then((m) => ({ default: m.EmployeeDetail })));
const Leave = lazy(() => import('./pages/PeopleOps.js').then((m) => ({ default: m.Leave })));
const Attendance = lazy(() => import('./pages/PeopleOps.js').then((m) => ({ default: m.Attendance })));
const Payroll = lazy(() => import('./pages/PeopleOps.js').then((m) => ({ default: m.Payroll })));
const Hiring = lazy(() => import('./pages/PeopleOps.js').then((m) => ({ default: m.Hiring })));
const Skills = lazy(() => import('./pages/PeopleOps.js').then((m) => ({ default: m.Skills })));
const Executive = lazy(() => import('./pages/Executive.js').then((m) => ({ default: m.Executive })));
import ImportPage from './pages/Import.js';
import Start from './pages/Start.js';
const Ledger = lazy(() => import('./pages/Books.js').then((m) => ({ default: m.Ledger })));
const Payables = lazy(() => import('./pages/Books.js').then((m) => ({ default: m.Payables })));
const Budget = lazy(() => import('./pages/Books.js').then((m) => ({ default: m.Budget })));
const Assets = lazy(() => import('./pages/Books.js').then((m) => ({ default: m.Assets })));
const EquityBoard = lazy(() => import('./pages/board/Board.js').then((m) => ({ default: m.Board })));
const MeetingDetail = lazy(() => import('./pages/board/MeetingDetail.js').then((m) => ({ default: m.MeetingDetail })));
const Resolutions = lazy(() => import('./pages/board/Resolutions.js').then((m) => ({ default: m.Resolutions })));
const ResolutionDetail = lazy(() =>
  import('./pages/board/Resolutions.js').then((m) => ({ default: m.ResolutionDetail })),
);
const EquityCompliance = lazy(() => import('./pages/board/Compliance.js').then((m) => ({ default: m.Compliance })));
const ComplianceCalendar = lazy(() =>
  import('./pages/compliance/Calendar.js').then((m) => ({ default: m.ComplianceCalendar })),
);
const ComplianceGst = lazy(() => import('./pages/compliance/Gst.js').then((m) => ({ default: m.ComplianceGst })));
const ComplianceTax = lazy(() => import('./pages/compliance/Tax.js').then((m) => ({ default: m.ComplianceTax })));
const ComplianceBooks = lazy(() => import('./pages/compliance/Books.js').then((m) => ({ default: m.ComplianceBooks })));
const CompliancePayroll = lazy(() =>
  import('./pages/compliance/Payroll.js').then((m) => ({ default: m.CompliancePayroll })),
);
const ComplianceLabour = lazy(() =>
  import('./pages/compliance/Labour.js').then((m) => ({ default: m.ComplianceLabour })),
);
const CompliancePrivacy = lazy(() =>
  import('./pages/compliance/Privacy.js').then((m) => ({ default: m.CompliancePrivacy })),
);
const ComplianceCorporate = lazy(() =>
  import('./pages/compliance/Corporate.js').then((m) => ({ default: m.ComplianceCorporate })),
);
// Technology (docs/plan/cio.md), one file per workstream.
const ItOverview = lazy(() => import('./pages/it/Overview.js').then((m) => ({ default: m.ItOverview })));
const ItAssets = lazy(() => import('./pages/it/Assets.js').then((m) => ({ default: m.ItAssets })));
const ItAssetDetail = lazy(() => import('./pages/it/Assets.js').then((m) => ({ default: m.ItAssetDetail })));
const ItApplications = lazy(() => import('./pages/it/Software.js').then((m) => ({ default: m.ItApplications })));
const ItApplicationDetail = lazy(() =>
  import('./pages/it/Software.js').then((m) => ({ default: m.ItApplicationDetail })),
);
const ItLicences = lazy(() => import('./pages/it/Software.js').then((m) => ({ default: m.ItLicences })));
const ItLicenceDetail = lazy(() => import('./pages/it/Software.js').then((m) => ({ default: m.ItLicenceDetail })));
const ItVendors = lazy(() => import('./pages/it/Vendors.js').then((m) => ({ default: m.ItVendors })));
const ItVendorDetail = lazy(() => import('./pages/it/Vendors.js').then((m) => ({ default: m.ItVendorDetail })));
const ItVendorContracts = lazy(() => import('./pages/it/Vendors.js').then((m) => ({ default: m.ItVendorContracts })));
const ItVendorContractDetail = lazy(() =>
  import('./pages/it/Vendors.js').then((m) => ({ default: m.ItVendorContractDetail })),
);
const ItTickets = lazy(() => import('./pages/it/ServiceDesk.js').then((m) => ({ default: m.ItTickets })));
const ItTicketDetail = lazy(() => import('./pages/it/ServiceDesk.js').then((m) => ({ default: m.ItTicketDetail })));
const ItKnowledge = lazy(() => import('./pages/it/ServiceDesk.js').then((m) => ({ default: m.ItKnowledge })));
const ItKnowledgeDetail = lazy(() =>
  import('./pages/it/ServiceDesk.js').then((m) => ({ default: m.ItKnowledgeDetail })),
);
const MyIt = lazy(() => import('./pages/it/ServiceDesk.js').then((m) => ({ default: m.MyIt })));
const ItIncidents = lazy(() => import('./pages/it/Itsm.js').then((m) => ({ default: m.ItIncidents })));
const ItIncidentDetail = lazy(() => import('./pages/it/Itsm.js').then((m) => ({ default: m.ItIncidentDetail })));
const ItProblems = lazy(() => import('./pages/it/Itsm.js').then((m) => ({ default: m.ItProblems })));
const ItProblemDetail = lazy(() => import('./pages/it/Itsm.js').then((m) => ({ default: m.ItProblemDetail })));
const ItChanges = lazy(() => import('./pages/it/Itsm.js').then((m) => ({ default: m.ItChanges })));
const ItChangeDetail = lazy(() => import('./pages/it/Itsm.js').then((m) => ({ default: m.ItChangeDetail })));
const ItRisks = lazy(() => import('./pages/it/Governance.js').then((m) => ({ default: m.ItRisks })));
const ItRiskDetail = lazy(() => import('./pages/it/Governance.js').then((m) => ({ default: m.ItRiskDetail })));
const ItPolicies = lazy(() => import('./pages/it/Governance.js').then((m) => ({ default: m.ItPolicies })));
const ItPolicyDetail = lazy(() => import('./pages/it/Governance.js').then((m) => ({ default: m.ItPolicyDetail })));
const ItControls = lazy(() => import('./pages/it/Governance.js').then((m) => ({ default: m.ItControls })));
const ItAccessReviews = lazy(() => import('./pages/it/Governance.js').then((m) => ({ default: m.ItAccessReviews })));
const ItAccessReviewDetail = lazy(() =>
  import('./pages/it/Governance.js').then((m) => ({ default: m.ItAccessReviewDetail })),
);
const ItFindings = lazy(() => import('./pages/it/Governance.js').then((m) => ({ default: m.ItFindings })));
const ItPortfolio = lazy(() => import('./pages/it/Portfolio.js').then((m) => ({ default: m.ItPortfolio })));
const ItInitiativeDetail = lazy(() =>
  import('./pages/it/Portfolio.js').then((m) => ({ default: m.ItInitiativeDetail })),
);
const ItRoadmap = lazy(() => import('./pages/it/Portfolio.js').then((m) => ({ default: m.ItRoadmap })));
const ItBudget = lazy(() => import('./pages/it/Portfolio.js').then((m) => ({ default: m.ItBudget })));
const ItTechDebt = lazy(() => import('./pages/it/Portfolio.js').then((m) => ({ default: m.ItTechDebt })));
const ItContinuity = lazy(() => import('./pages/it/Continuity.js').then((m) => ({ default: m.ItContinuity })));
const ItAvailability = lazy(() => import('./pages/it/Continuity.js').then((m) => ({ default: m.ItAvailability })));
const ItMaintenance = lazy(() => import('./pages/it/Continuity.js').then((m) => ({ default: m.ItMaintenance })));
const CeoCockpit = lazy(() => import('./pages/ceo/Cockpit.js').then((m) => ({ default: m.Cockpit })));
const CeoKpiLibrary = lazy(() => import('./pages/ceo/KpiLibrary.js').then((m) => ({ default: m.KpiLibrary })));
const CeoStrategy = lazy(() => import('./pages/ceo/Strategy.js').then((m) => ({ default: m.Strategy })));
const CeoOkrs = lazy(() => import('./pages/ceo/Okrs.js').then((m) => ({ default: m.Okrs })));
const CeoInitiatives = lazy(() => import('./pages/ceo/Initiatives.js').then((m) => ({ default: m.Initiatives })));
const CeoRhythm = lazy(() => import('./pages/ceo/Rhythm.js').then((m) => ({ default: m.Rhythm })));
const CeoDoa = lazy(() => import('./pages/ceo/Doa.js').then((m) => ({ default: m.Doa })));
const CeoApprovals = lazy(() => import('./pages/ceo/Approvals.js').then((m) => ({ default: m.Approvals })));
const CeoBoardPack = lazy(() => import('./pages/ceo/BoardPack.js').then((m) => ({ default: m.BoardPack })));
const CeoInvestorUpdates = lazy(() =>
  import('./pages/ceo/InvestorUpdates.js').then((m) => ({ default: m.InvestorUpdates })),
);
const CeoStakeholders = lazy(() => import('./pages/ceo/Stakeholders.js').then((m) => ({ default: m.Stakeholders })));
const CeoRisk = lazy(() => import('./pages/ceo/Risk.js').then((m) => ({ default: m.Risk })));
const CeoPolicies = lazy(() => import('./pages/ceo/Policies.js').then((m) => ({ default: m.Policies })));
const CeoGovernance = lazy(() => import('./pages/ceo/Governance.js').then((m) => ({ default: m.Governance })));
const CeoFinancialPlan = lazy(() => import('./pages/ceo/FinancialPlan.js').then((m) => ({ default: m.FinancialPlan })));
const CeoHeadcount = lazy(() => import('./pages/ceo/Headcount.js').then((m) => ({ default: m.Headcount })));
const CeoLeadership = lazy(() => import('./pages/ceo/Leadership.js').then((m) => ({ default: m.Leadership })));
const CeoOneOnOnes = lazy(() => import('./pages/ceo/OneOnOnes.js').then((m) => ({ default: m.OneOnOnes })));
const CeoSuccession = lazy(() => import('./pages/ceo/Succession.js').then((m) => ({ default: m.Succession })));
const CeoTimeAudit = lazy(() => import('./pages/ceo/TimeAudit.js').then((m) => ({ default: m.TimeAudit })));
const MarketingShell = lazy(() =>
  import('./pages/marketing/MarketingShell.js').then((m) => ({ default: m.MarketingShell })),
);
const MarketingOverview = lazy(() =>
  import('./pages/marketing/MarketingOverview.js').then((m) => ({ default: m.MarketingOverview })),
);
const MarketingCampaigns = lazy(() => import('./pages/marketing/Campaigns.js').then((m) => ({ default: m.Campaigns })));
const MarketingCampaignDetail = lazy(() =>
  import('./pages/marketing/CampaignDetail.js').then((m) => ({ default: m.CampaignDetail })),
);
const MarketingCalendar = lazy(() => import('./pages/marketing/Calendar.js').then((m) => ({ default: m.Calendar })));
const MarketingBudget = lazy(() => import('./pages/marketing/Budget.js').then((m) => ({ default: m.Budget })));
const MarketingPlans = lazy(() => import('./pages/marketing/Plans.js').then((m) => ({ default: m.Plans })));
const MarketingAnalytics = lazy(() => import('./pages/marketing/Analytics.js').then((m) => ({ default: m.Analytics })));
const MarketingSettings = lazy(() =>
  import('./pages/marketing/MarketingSettings.js').then((m) => ({ default: m.MarketingSettings })),
);
const MarketingForms = lazy(() => import('./pages/marketing/Forms.js').then((m) => ({ default: m.Forms })));
const MarketingEvents = lazy(() =>
  import('./pages/marketing/MarketingEvents.js').then((m) => ({ default: m.MarketingEvents })),
);
const MarketingEventDetail = lazy(() =>
  import('./pages/marketing/MarketingEvents.js').then((m) => ({ default: m.MarketingEventDetail })),
);
const MarketingAssets = lazy(() => import('./pages/marketing/Assets.js').then((m) => ({ default: m.Assets })));
const MarketingSocial = lazy(() => import('./pages/marketing/Social.js').then((m) => ({ default: m.Social })));
const MarketingReferrals = lazy(() => import('./pages/marketing/Referrals.js').then((m) => ({ default: m.Referrals })));
const MarketingAudiences = lazy(() => import('./pages/marketing/Audiences.js').then((m) => ({ default: m.Audiences })));
const MarketingConsent = lazy(() => import('./pages/marketing/Consent.js').then((m) => ({ default: m.Consent })));
const MarketingTemplates = lazy(() => import('./pages/marketing/Templates.js').then((m) => ({ default: m.Templates })));
const MarketingSends = lazy(() => import('./pages/marketing/Sends.js').then((m) => ({ default: m.Sends })));
const MarketingSendDetail = lazy(() => import('./pages/marketing/Sends.js').then((m) => ({ default: m.SendDetail })));
const MarketingJourneys = lazy(() => import('./pages/marketing/Journeys.js').then((m) => ({ default: m.Journeys })));
const OrgChart = lazy(() => import('./pages/hcm/OrgChart.js').then((m) => ({ default: m.OrgChart })));
const Directory = lazy(() => import('./pages/hcm/Directory.js').then((m) => ({ default: m.Directory })));
const Employee360 = lazy(() => import('./pages/hcm/Employee360.js').then((m) => ({ default: m.Employee360 })));
const HcmTime = lazy(() => import('./pages/hcm/Time.js').then((m) => ({ default: m.Time })));
const LeavePolicies = lazy(() => import('./pages/hcm/LeavePolicies.js').then((m) => ({ default: m.LeavePolicies })));
const LeaveCalendar = lazy(() => import('./pages/hcm/LeaveCalendar.js').then((m) => ({ default: m.LeaveCalendar })));
const Recruiting = lazy(() => import('./pages/hcm/Recruiting.js').then((m) => ({ default: m.Recruiting })));
const HcmPerformance = lazy(() => import('./pages/hcm/Performance.js').then((m) => ({ default: m.Performance })));
const HcmLearning = lazy(() => import('./pages/hcm/Learning.js').then((m) => ({ default: m.Learning })));
const Compensation = lazy(() => import('./pages/hcm/Compensation.js').then((m) => ({ default: m.Compensation })));
const PayrollOps = lazy(() => import('./pages/hcm/PayrollOps.js').then((m) => ({ default: m.PayrollOps })));
const Engagement = lazy(() => import('./pages/hcm/Engagement.js').then((m) => ({ default: m.Engagement })));
const Separations = lazy(() => import('./pages/hcm/Separations.js').then((m) => ({ default: m.Separations })));
const HcmAssets = lazy(() => import('./pages/hcm/Assets.js').then((m) => ({ default: m.Assets })));
const HcmAnalytics = lazy(() => import('./pages/hcm/Analytics.js').then((m) => ({ default: m.Analytics })));
const HcmApprovals = lazy(() => import('./pages/hcm/Approvals.js').then((m) => ({ default: m.Approvals })));
const MeHome = lazy(() => import('./pages/me/Home.js').then((m) => ({ default: m.Home })));
const MeLeave = lazy(() => import('./pages/me/Leave.js').then((m) => ({ default: m.Leave })));
const MeAttendance = lazy(() => import('./pages/me/Attendance.js').then((m) => ({ default: m.Attendance })));
const MePayslips = lazy(() => import('./pages/me/Payslips.js').then((m) => ({ default: m.Payslips })));
const MePerformance = lazy(() => import('./pages/me/Performance.js').then((m) => ({ default: m.Performance })));
const MeLearning = lazy(() => import('./pages/me/Learning.js').then((m) => ({ default: m.Learning })));
const MeMoney = lazy(() => import('./pages/me/Money.js').then((m) => ({ default: m.Money })));
const MeRequests = lazy(() => import('./pages/me/Requests.js').then((m) => ({ default: m.Requests })));
const MeExit = lazy(() => import('./pages/me/Exit.js').then((m) => ({ default: m.Exit })));

const queryClient = new QueryClient({
  defaultOptions: {
    // 401s are never retried; see shouldRetryQuery for why.
    queries: { retry: shouldRetryQuery, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

/**
 * An old `/crm/accounts/:id` link. The record is the same row, so it resolves to
 * whichever of the two screens now owns it rather than guessing.
 */
function LegacyAccountLink() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/crm/organizations/${id}`} replace />;
}

/**
 * The portal's own `<Routes>` block — no ERP sidebar or ERP routes reach a
 * portal surface at all, in either direction (plan §3.1). Every path here
 * mirrors a `portal_*` node in `NAV_REGISTRY`; a node the server did not
 * return for this role still resolves the route (so a bookmark does not
 * 404), and `PortalShell` renders the "not given a view" empty state instead
 * of the page when its section list is empty.
 */
function PortalRouted() {
  const { nav } = useSession();
  const landing = nav.find((n) => n.group === 'portal')?.path ?? '/portal/holdings';

  return (
    <Routes>
      <Route element={<PortalShell />}>
        <Route path="/" element={<Navigate to={landing} replace />} />
        <Route path="/portal/holdings" element={<Holdings />} />
        <Route path="/portal/certificates" element={<Certificates />} />
        <Route path="/portal/documents" element={<Documents />} />
        {/* The same sheet the ERP register opens, routed here too so a
            shareholder printing their own certificate stays inside the
            portal's own shell. */}
        <Route path="/equity/certificates/:id/document" element={<CertificateDocument />} />
        <Route path="/equity/group/:sourceTenantId" element={<GroupEntity />} />
        <Route path="/portal/board" element={<Board />} />
        <Route path="/portal/entities" element={<PortalEntities />} />
        <Route path="/portal/options" element={<PortalOptions />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function Routed() {
  const { user, loading, passwordChangeRequired } = useSession();
  const surface = useSurface(user);

  if (loading) return <Loading label="Resolving your session" />;
  // Before the shell and before sign-in: a recovered one-time password opens
  // nothing else, and the token it holds is kept for the change to use.
  if (passwordChangeRequired) return <ChangePassword />;
  if (!user)
    return (
      <Suspense fallback={<Loading label="Opening sign-in" />}>
        <Login />
      </Suspense>
    );
  if (surface === 'portal') return <PortalRouted />;

  return (
    <Suspense fallback={<Loading label="Preparing the workspace" />}>
      <Routes>
        <Route element={<Shell />}>
          {/* The landing surface follows the archetype the role resolves to. */}
          <Route
            path="/"
            element={<Navigate to={user.archetype === 'command' ? '/command' : '/workspace'} replace />}
          />

          <Route path="/command" element={<CommandCenter />} />
          <Route path="/command/decisions" element={<Decisions />} />
          <Route path="/command/health/:domainCode" element={<CommandCenter />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/exceptions" element={<Exceptions />} />
          <Route path="/exceptions/:id" element={<Exceptions />} />

          <Route path="/crm/pipeline" element={<Pipeline />} />
          <Route path="/crm/leads" element={<Leads />} />
          <Route path="/crm/leads/:id" element={<LeadDetail />} />
          <Route path="/crm/opportunities" element={<Opportunities />} />
          <Route path="/crm/opportunities/:id" element={<OpportunityDetail />} />
          <Route path="/crm/forecast" element={<Forecast />} />
          {/* Three party types, three routes. `/crm/accounts` is kept pointing at
            organisations because links to it exist in the wild — bookmarks,
            notification drill paths — and a dead link teaches nobody anything. */}
          <Route path="/crm/students" element={<Students />} />
          <Route path="/crm/students/:id" element={<StudentDetail />} />
          <Route path="/crm/institutions" element={<Institutions />} />
          <Route path="/crm/institutions/:id" element={<BodyDetail kind="institution" />} />
          <Route path="/crm/organizations" element={<Organizations />} />
          <Route path="/crm/organizations/:id" element={<BodyDetail kind="organization" />} />
          <Route path="/crm/accounts" element={<Navigate to="/crm/organizations" replace />} />
          <Route path="/crm/accounts/:id" element={<LegacyAccountLink />} />
          <Route path="/crm/people" element={<People />} />
          <Route path="/crm/people/:id" element={<PersonDetail />} />
          <Route path="/crm/interactions" element={<Interactions />} />

          <Route path="/commercial/offerings" element={<Offerings />} />
          <Route path="/commercial/quotes" element={<Quotes />} />
          <Route path="/commercial/quotes/:id" element={<Quotes />} />
          <Route path="/commercial/proposals" element={<Proposals />} />
          <Route path="/commercial/proposals/:id" element={<Proposals />} />
          <Route path="/commercial/agreements" element={<Agreements />} />
          <Route path="/commercial/mous/:id" element={<Agreements />} />
          <Route path="/commercial/contracts/:id" element={<Agreements />} />
          <Route path="/commercial/partner-agreements/:id" element={<Agreements />} />
          <Route path="/commercial/approvals" element={<Approvals />} />
          <Route path="/approvals/:id" element={<Approvals />} />
          <Route path="/commercial/win-loss" element={<WinLoss />} />
          <Route path="/commercial/win-loss/:id" element={<WinLoss />} />

          <Route path="/equity/cap-table" element={<CapTable />} />
          <Route path="/equity/register" element={<Register />} />
          <Route path="/equity/holders" element={<Holders />} />
          <Route path="/equity/holders/:id" element={<HolderDetail />} />
          <Route path="/equity/share-classes" element={<ShareClasses />} />
          <Route path="/equity/valuations" element={<Valuations />} />
          <Route path="/equity/documents" element={<EquityDocuments />} />
          <Route path="/equity/group" element={<Group />} />
          <Route path="/equity/group/:sourceTenantId" element={<GroupEntity />} />
          <Route path="/equity/certificates/:id/document" element={<CertificateDocument />} />
          <Route path="/equity/rounds" element={<Rounds />} />
          <Route path="/equity/scenarios" element={<Scenarios />} />
          <Route path="/equity/esop" element={<Esop />} />
          <Route path="/equity/filings" element={<Filings />} />
          <Route path="/equity/filings/sh-4/:transactionId" element={<Sh4Sheet />} />
          <Route path="/me/options" element={<MyOptions />} />

          <Route path="/business" element={<Executive />} />
          <Route path="/data/import" element={<ImportPage />} />
          <Route path="/start" element={<Start />} />

          <Route path="/finance/ledger" element={<Ledger />} />
          <Route path="/finance/payables" element={<Payables />} />
          <Route path="/finance/budget" element={<Budget />} />
          <Route path="/finance/assets" element={<Assets />} />
          <Route path="/finance/invoices" element={<Invoices />} />
          <Route path="/finance/invoices/new" element={<NewInvoice />} />
          <Route path="/finance/invoices/history" element={<InvoiceHistory />} />
          {/* The document route sits above the detail route: a printable invoice is
            a different surface from the list, not a modal over it. */}
          <Route path="/finance/invoices/:id/document" element={<InvoiceDocument />} />
          <Route path="/finance/invoices/:id" element={<Invoices />} />
          <Route path="/finance/receipts" element={<Receipts />} />
          <Route path="/finance/receipts/:id" element={<ReceiptDocument />} />
          <Route path="/finance/final-invoices" element={<FinalInvoices />} />
          <Route path="/finance/final-invoices/:id" element={<FinalInvoiceDocument />} />
          <Route path="/finance/payments" element={<Payments />} />
          <Route path="/finance/payments/:id" element={<Payments />} />
          <Route path="/finance/receivables" element={<Receivables />} />
          <Route path="/finance/gst" element={<GstReturns />} />
          <Route path="/finance/company" element={<CompanyDetails />} />

          <Route path="/equity/board" element={<EquityBoard />} />
          <Route path="/equity/board/meetings/:id" element={<MeetingDetail />} />
          <Route path="/equity/resolutions" element={<Resolutions />} />
          <Route path="/equity/resolutions/:id" element={<ResolutionDetail />} />
          <Route path="/equity/compliance" element={<EquityCompliance />} />

          <Route path="/people/employees" element={<Employees />} />
          <Route path="/people/employees/:id" element={<EmployeeDetail />} />
          <Route path="/people/leave" element={<Leave />} />
          <Route path="/people/attendance" element={<Attendance />} />
          <Route path="/people/payroll" element={<Payroll />} />
          <Route path="/people/hiring" element={<Hiring />} />
          <Route path="/people/skills" element={<Skills />} />
          <Route path="/people/employees/:id/360" element={<Employee360 />} />

          <Route path="/people/org-chart" element={<OrgChart />} />
          <Route path="/people/directory" element={<Directory />} />
          <Route path="/people/time" element={<HcmTime />} />
          <Route path="/people/leave-policies" element={<LeavePolicies />} />
          <Route path="/people/leave-calendar" element={<LeaveCalendar />} />
          <Route path="/people/recruiting" element={<Recruiting />} />
          <Route path="/people/performance" element={<HcmPerformance />} />
          <Route path="/people/learning" element={<HcmLearning />} />
          <Route path="/people/compensation" element={<Compensation />} />
          <Route path="/people/payroll-ops" element={<PayrollOps />} />
          <Route path="/people/engagement" element={<Engagement />} />
          <Route path="/people/separations" element={<Separations />} />
          <Route path="/people/assets" element={<HcmAssets />} />
          <Route path="/people/analytics" element={<HcmAnalytics />} />
          <Route path="/people/approvals" element={<HcmApprovals />} />

          <Route path="/me/home" element={<MeHome />} />
          <Route path="/me/leave" element={<MeLeave />} />
          <Route path="/me/attendance" element={<MeAttendance />} />
          <Route path="/me/payslips" element={<MePayslips />} />
          <Route path="/me/performance" element={<MePerformance />} />
          <Route path="/me/learning" element={<MeLearning />} />
          <Route path="/me/money" element={<MeMoney />} />
          <Route path="/me/requests" element={<MeRequests />} />
          <Route path="/me/exit" element={<MeExit />} />

          <Route path="/education/courses" element={<Courses />} />
          <Route path="/education/cohorts" element={<Cohorts />} />
          <Route path="/education/enrollments" element={<Enrollments />} />
          <Route path="/education/enrollments/:id" element={<StudentTimeline />} />
          <Route path="/education/queries" element={<LearnerQueue />} />
          <Route path="/delivery/projects" element={<Projects />} />
          <Route path="/delivery/projects/:id" element={<Projects />} />

          <Route path="/compliance/calendar" element={<ComplianceCalendar />} />
          <Route path="/compliance/calendar/:id" element={<ComplianceCalendar />} />
          <Route path="/compliance/gst" element={<ComplianceGst />} />
          <Route path="/compliance/gst/:id" element={<ComplianceGst />} />
          <Route path="/compliance/tax" element={<ComplianceTax />} />
          <Route path="/compliance/tax/:id" element={<ComplianceTax />} />
          <Route path="/compliance/books" element={<ComplianceBooks />} />
          <Route path="/compliance/books/:id" element={<ComplianceBooks />} />
          <Route path="/compliance/payroll" element={<CompliancePayroll />} />
          <Route path="/compliance/payroll/:id" element={<CompliancePayroll />} />
          <Route path="/compliance/labour" element={<ComplianceLabour />} />
          <Route path="/compliance/labour/:id" element={<ComplianceLabour />} />
          <Route path="/compliance/privacy" element={<CompliancePrivacy />} />
          <Route path="/compliance/privacy/:id" element={<CompliancePrivacy />} />
          <Route path="/compliance/corporate" element={<ComplianceCorporate />} />
          <Route path="/compliance/corporate/:id" element={<ComplianceCorporate />} />

          {/* Technology (docs/plan/cio.md) */}
          <Route path="/it" element={<ItOverview />} />
          <Route path="/it/my" element={<MyIt />} />
          <Route path="/it/assets" element={<ItAssets />} />
          <Route path="/it/assets/:id" element={<ItAssetDetail />} />
          <Route path="/it/applications" element={<ItApplications />} />
          <Route path="/it/applications/:id" element={<ItApplicationDetail />} />
          <Route path="/it/licences" element={<ItLicences />} />
          <Route path="/it/licences/:id" element={<ItLicenceDetail />} />
          <Route path="/it/vendors" element={<ItVendors />} />
          <Route path="/it/vendors/:id" element={<ItVendorDetail />} />
          <Route path="/it/contracts" element={<ItVendorContracts />} />
          <Route path="/it/contracts/:id" element={<ItVendorContractDetail />} />
          <Route path="/it/tickets" element={<ItTickets />} />
          <Route path="/it/tickets/:id" element={<ItTicketDetail />} />
          <Route path="/it/knowledge" element={<ItKnowledge />} />
          <Route path="/it/knowledge/:id" element={<ItKnowledgeDetail />} />
          <Route path="/it/incidents" element={<ItIncidents />} />
          <Route path="/it/incidents/:id" element={<ItIncidentDetail />} />
          <Route path="/it/problems" element={<ItProblems />} />
          <Route path="/it/problems/:id" element={<ItProblemDetail />} />
          <Route path="/it/changes" element={<ItChanges />} />
          <Route path="/it/changes/:id" element={<ItChangeDetail />} />
          <Route path="/it/risks" element={<ItRisks />} />
          <Route path="/it/risks/:id" element={<ItRiskDetail />} />
          <Route path="/it/policies" element={<ItPolicies />} />
          <Route path="/it/policies/:id" element={<ItPolicyDetail />} />
          <Route path="/it/controls" element={<ItControls />} />
          <Route path="/it/access-reviews" element={<ItAccessReviews />} />
          <Route path="/it/access-reviews/:id" element={<ItAccessReviewDetail />} />
          <Route path="/it/findings" element={<ItFindings />} />
          <Route path="/it/portfolio" element={<ItPortfolio />} />
          <Route path="/it/portfolio/:id" element={<ItInitiativeDetail />} />
          <Route path="/it/roadmap" element={<ItRoadmap />} />
          <Route path="/it/budget" element={<ItBudget />} />
          <Route path="/it/tech-debt" element={<ItTechDebt />} />
          <Route path="/it/continuity" element={<ItContinuity />} />
          <Route path="/it/availability" element={<ItAvailability />} />
          <Route path="/it/maintenance" element={<ItMaintenance />} />

          <Route path="/admin/pipelines" element={<PipelineAdmin />} />
          <Route path="/admin/territories" element={<TerritoryAdmin />} />
          <Route path="/admin/governance" element={<Governance />} />
          <Route path="/admin/agents" element={<Agents />} />
          <Route path="/admin/agents/actions/:id" element={<Agents />} />
          <Route path="/admin/events" element={<Events />} />
          <Route path="/admin/jobs" element={<Jobs />} />
          <Route path="/admin/audit" element={<Audit />} />
          <Route path="/admin/platform" element={<PlatformModel />} />

          {/* ---- Chairman's Office (docs/plan/ceo-office.md §6, Phase 0) ---- */}
          <Route path="/ceo/cockpit" element={<CeoCockpit />} />
          <Route path="/ceo/kpi-library" element={<CeoKpiLibrary />} />
          <Route path="/ceo/strategy" element={<CeoStrategy />} />
          <Route path="/ceo/okrs" element={<CeoOkrs />} />
          <Route path="/ceo/initiatives" element={<CeoInitiatives />} />
          <Route path="/ceo/initiatives/:id" element={<CeoInitiatives />} />
          <Route path="/ceo/meetings" element={<CeoRhythm />} />
          <Route path="/ceo/meetings/:id" element={<CeoRhythm />} />
          <Route path="/ceo/delegation" element={<CeoDoa />} />
          <Route path="/ceo/approvals" element={<CeoApprovals />} />
          <Route path="/ceo/board-pack" element={<CeoBoardPack />} />
          <Route path="/ceo/board-pack/:id/document" element={<CeoBoardPack />} />
          <Route path="/ceo/investor-updates" element={<CeoInvestorUpdates />} />
          <Route path="/ceo/investor-updates/:id/document" element={<CeoInvestorUpdates />} />
          <Route path="/ceo/stakeholders" element={<CeoStakeholders />} />
          <Route path="/ceo/risks" element={<CeoRisk />} />
          <Route path="/ceo/policies" element={<CeoPolicies />} />
          <Route path="/ceo/governance" element={<CeoGovernance />} />
          <Route path="/ceo/financial-plan" element={<CeoFinancialPlan />} />
          <Route path="/ceo/headcount-plan" element={<CeoHeadcount />} />
          <Route path="/ceo/leadership" element={<CeoLeadership />} />
          <Route path="/ceo/one-on-ones" element={<CeoOneOnOnes />} />
          <Route path="/ceo/succession" element={<CeoSuccession />} />
          <Route path="/ceo/time-audit" element={<CeoTimeAudit />} />
          {/* marketing */}
          <Route path="/marketing" element={<MarketingShell />}>
            <Route index element={<MarketingOverview />} />
            <Route path="campaigns" element={<MarketingCampaigns />} />
            <Route path="campaigns/:id" element={<MarketingCampaignDetail />} />
            <Route path="calendar" element={<MarketingCalendar />} />
            <Route path="budget" element={<MarketingBudget />} />
            <Route path="plans" element={<MarketingPlans />} />
            <Route path="analytics" element={<MarketingAnalytics />} />
            <Route path="settings" element={<MarketingSettings />} />
            <Route path="forms" element={<MarketingForms />} />
            <Route path="events" element={<MarketingEvents />} />
            <Route path="events/:id" element={<MarketingEventDetail />} />
            <Route path="assets" element={<MarketingAssets />} />
            <Route path="social" element={<MarketingSocial />} />
            <Route path="referrals" element={<MarketingReferrals />} />
            <Route path="audiences" element={<MarketingAudiences />} />
            <Route path="consent" element={<MarketingConsent />} />
            <Route path="templates" element={<MarketingTemplates />} />
            <Route path="sends" element={<MarketingSends />} />
            <Route path="sends/:id" element={<MarketingSendDetail />} />
            <Route path="journeys" element={<MarketingJourneys />} />
          </Route>
          {/* end marketing */}

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary scope="app">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <SessionProvider>
            <Routed />
          </SessionProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
