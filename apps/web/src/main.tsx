import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
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
import { Accounts, AccountDetail } from './pages/Accounts.js';
import { People, PersonDetail, Interactions } from './pages/People.js';
import { Offerings, Quotes, Proposals, Agreements, Approvals, WinLoss } from './pages/Commercial.js';
import { Invoices, Payments, Receivables } from './pages/Finance.js';
import { Cohorts, Enrollments, Projects } from './pages/Education.js';
import { PipelineAdmin, TerritoryAdmin, Governance, Agents, Events, Jobs, Audit, PlatformModel } from './pages/Admin.js';
import { Decisions } from './pages/Decisions.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

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
        <Route path="/crm/accounts" element={<Accounts />} />
        <Route path="/crm/accounts/:id" element={<AccountDetail />} />
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

        <Route path="/finance/invoices" element={<Invoices />} />
        <Route path="/finance/invoices/:id" element={<Invoices />} />
        <Route path="/finance/payments" element={<Payments />} />
        <Route path="/finance/payments/:id" element={<Payments />} />
        <Route path="/finance/receivables" element={<Receivables />} />

        <Route path="/education/cohorts" element={<Cohorts />} />
        <Route path="/education/enrollments" element={<Enrollments />} />
        <Route path="/education/enrollments/:id" element={<Enrollments />} />
        <Route path="/delivery/projects" element={<Projects />} />
        <Route path="/delivery/projects/:id" element={<Projects />} />

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
