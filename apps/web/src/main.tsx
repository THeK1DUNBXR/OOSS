import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { SessionProvider, useSession } from './lib/session.js';
import { useSurface } from './lib/surface.js';
import { Shell } from './components/Shell.js';
import { Loading } from './components/ui.js';
import { Login } from './pages/Login.js';
import { PortalShell } from './portal/PortalShell.js';
import { Holdings } from './portal/pages/Holdings.js';
import { Certificates } from './portal/pages/Certificates.js';
import { Documents } from './portal/pages/Documents.js';
import { Board } from './portal/pages/Board.js';
import { Entities as PortalEntities } from './portal/pages/Entities.js';
import { Options as PortalOptions } from './portal/pages/Options.js';
import { CapTable } from './pages/equity/CapTable.js';
import { Register } from './pages/equity/Register.js';
import { Holders, HolderDetail } from './pages/equity/Holders.js';
import { ShareClasses } from './pages/equity/ShareClasses.js';
import { Valuations } from './pages/equity/Valuations.js';
import { Documents as EquityDocuments } from './pages/equity/Documents.js';
import { CertificateDocument } from './pages/equity/CertificateDocument.js';
import { Group } from './pages/equity/Group.js';
import { GroupEntity } from './pages/equity/GroupEntity.js';
import { Rounds } from './pages/equity/Rounds.js';
import { Scenarios } from './pages/equity/Scenarios.js';
import { Esop } from './pages/equity/Esop.js';
import { Filings } from './pages/equity/Filings.js';
import { Sh4Sheet } from './pages/equity/Sh4Sheet.js';
import { MyOptions } from './pages/MyOptions.js';
import { CommandCenter } from './pages/CommandCenter.js';
import { Workspace, Exceptions } from './pages/Workspace.js';
import { Pipeline } from './pages/Pipeline.js';
import { Leads, LeadDetail } from './pages/Leads.js';
import { Opportunities, OpportunityDetail, Forecast } from './pages/Opportunities.js';
import { Institutions, Organizations, BodyDetail } from './pages/Parties.js';
import { Students, StudentDetail } from './pages/Students.js';
import { People, PersonDetail, Interactions } from './pages/People.js';
import { Offerings, Quotes, Proposals, Agreements, Approvals, WinLoss } from './pages/Commercial.js';
import { Invoices, Payments, Receivables } from './pages/Finance.js';
import { InvoiceDocument } from './pages/InvoiceDocument.js';
import { NewInvoice } from './pages/kaizenInvoice/NewInvoice.js';
import { InvoiceHistory } from './pages/kaizenInvoice/InvoiceHistory.js';
import { ReceiptDocument, Receipts } from './pages/ReceiptDocument.js';
import { FinalInvoiceDocument, FinalInvoices } from './pages/FinalInvoiceDocument.js';
import { CompanyDetails, GstReturns } from './pages/GstReturns.js';
import { Cohorts, Enrollments, Projects } from './pages/Education.js';
import { Courses } from './pages/Courses.js';
import { LearnerQueue, StudentTimeline } from './pages/StudentTimeline.js';
import { PipelineAdmin, TerritoryAdmin, Governance, Agents, Events, Jobs, Audit, PlatformModel } from './pages/Admin.js';
import { Decisions } from './pages/Decisions.js';
import { Employees, EmployeeDetail, Leave, Attendance, Payroll, Hiring, Skills } from './pages/PeopleOps.js';
import { Executive } from './pages/Executive.js';
import ImportPage from './pages/Import.js';
import Start from './pages/Start.js';
import { Ledger, Payables, Budget, Assets } from './pages/Books.js';
import { Board as EquityBoard } from './pages/board/Board.js';
import { MeetingDetail } from './pages/board/MeetingDetail.js';
import { Resolutions, ResolutionDetail } from './pages/board/Resolutions.js';
import { Compliance as EquityCompliance } from './pages/board/Compliance.js';
import { ComplianceCalendar } from './pages/compliance/Calendar.js';
import { ComplianceGst } from './pages/compliance/Gst.js';
import { ComplianceTax } from './pages/compliance/Tax.js';
import { ComplianceBooks } from './pages/compliance/Books.js';
import { CompliancePayroll } from './pages/compliance/Payroll.js';
import { ComplianceLabour } from './pages/compliance/Labour.js';
import { CompliancePrivacy } from './pages/compliance/Privacy.js';
import { ComplianceCorporate } from './pages/compliance/Corporate.js';
import { OrgChart } from './pages/hcm/OrgChart.js';
import { Directory } from './pages/hcm/Directory.js';
import { Employee360 } from './pages/hcm/Employee360.js';
import { Time as HcmTime } from './pages/hcm/Time.js';
import { LeavePolicies } from './pages/hcm/LeavePolicies.js';
import { LeaveCalendar } from './pages/hcm/LeaveCalendar.js';
import { Recruiting } from './pages/hcm/Recruiting.js';
import { Performance as HcmPerformance } from './pages/hcm/Performance.js';
import { Learning as HcmLearning } from './pages/hcm/Learning.js';
import { Compensation } from './pages/hcm/Compensation.js';
import { PayrollOps } from './pages/hcm/PayrollOps.js';
import { Engagement } from './pages/hcm/Engagement.js';
import { Separations } from './pages/hcm/Separations.js';
import { Assets as HcmAssets } from './pages/hcm/Assets.js';
import { Analytics as HcmAnalytics } from './pages/hcm/Analytics.js';
import { Approvals as HcmApprovals } from './pages/hcm/Approvals.js';
import { Home as MeHome } from './pages/me/Home.js';
import { Leave as MeLeave } from './pages/me/Leave.js';
import { Attendance as MeAttendance } from './pages/me/Attendance.js';
import { Payslips as MePayslips } from './pages/me/Payslips.js';
import { Performance as MePerformance } from './pages/me/Performance.js';
import { Learning as MeLearning } from './pages/me/Learning.js';
import { Money as MeMoney } from './pages/me/Money.js';
import { Requests as MeRequests } from './pages/me/Requests.js';
import { Exit as MeExit } from './pages/me/Exit.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
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
  const { user, loading } = useSession();
  const surface = useSurface(user);

  if (loading) return <Loading label="Resolving your session" />;
  if (!user) return <Login />;
  if (surface === 'portal') return <PortalRouted />;

  return (
    <Routes>
      <Route element={<Shell />}>
        {/* The landing surface follows the archetype the role resolves to. */}
        <Route path="/" element={<Navigate to={user.archetype === 'command' ? '/command' : '/workspace'} replace />} />

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

        <Route path="/admin/pipelines" element={<PipelineAdmin />} />
        <Route path="/admin/territories" element={<TerritoryAdmin />} />
        <Route path="/admin/governance" element={<Governance />} />
        <Route path="/admin/agents" element={<Agents />} />
        <Route path="/admin/agents/actions/:id" element={<Agents />} />
        <Route path="/admin/events" element={<Events />} />
        <Route path="/admin/jobs" element={<Jobs />} />
        <Route path="/admin/audit" element={<Audit />} />
        <Route path="/admin/platform" element={<PlatformModel />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <Routed />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
