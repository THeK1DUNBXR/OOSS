import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { SessionProvider, useSession } from './lib/session.js';
import { Shell } from './components/Shell.js';
import { Loading } from './components/ui.js';
import { Login } from './pages/Login.js';
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
import { ComplianceCalendar } from './pages/compliance/Calendar.js';
import { ComplianceGst } from './pages/compliance/Gst.js';
import { ComplianceTax } from './pages/compliance/Tax.js';
import { ComplianceBooks } from './pages/compliance/Books.js';
import { CompliancePayroll } from './pages/compliance/Payroll.js';
import { ComplianceLabour } from './pages/compliance/Labour.js';
import { CompliancePrivacy } from './pages/compliance/Privacy.js';
import { ComplianceCorporate } from './pages/compliance/Corporate.js';

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

function Routed() {
  const { user, loading } = useSession();

  if (loading) return <Loading label="Resolving your session" />;
  if (!user) return <Login />;

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

        <Route path="/people/employees" element={<Employees />} />
        <Route path="/people/employees/:id" element={<EmployeeDetail />} />
        <Route path="/people/leave" element={<Leave />} />
        <Route path="/people/attendance" element={<Attendance />} />
        <Route path="/people/payroll" element={<Payroll />} />
        <Route path="/people/hiring" element={<Hiring />} />
        <Route path="/people/skills" element={<Skills />} />

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
