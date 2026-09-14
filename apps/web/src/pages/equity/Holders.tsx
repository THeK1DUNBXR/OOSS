/**
 * Holders — who is on the register, and their own page.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  HOLDER_KIND_LABELS,
  INVESTMENT_BASIS_LABELS,
  RESIDENCY_LABELS,
  type CapTableView,
  type CertificateView,
  type HolderKind,
  type HolderView,
  type HoldingsView,
  type InvestmentBasis,
  type Residency,
} from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Field, Loading, Modal, PageHeader } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextInput, messageOf } from '../../components/forms.js';

interface Named {
  id: string;
  name: string;
}

function useOrganizations(enabled: boolean) {
  return useQuery({
    queryKey: ['organizations', 'holder-picker'],
    queryFn: () => api.get<{ items: Named[] }>('/crm/organizations?pageSize=200'),
    enabled,
  });
}

function NewHolder({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<HolderKind>('person');
  const [fullName, setFullName] = useState('');
  const [personEmail, setPersonEmail] = useState('');
  const [personPhone, setPersonPhone] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [heldByTenantId, setHeldByTenantId] = useState('');
  const [residency, setResidency] = useState<Residency>('resident');
  const [investmentBasis, setInvestmentBasis] = useState<InvestmentBasis | ''>('');
  const [panNumber, setPanNumber] = useState('');
  const [nomineeName, setNomineeName] = useState('');

  // MGT-1 fields (Rule 3) — recorded when known, left blank otherwise.
  const [address, setAddress] = useState('');
  const [occupation, setOccupation] = useState('');
  const [nationality, setNationality] = useState('');
  const [guardianOrSpouseName, setGuardianOrSpouseName] = useState('');

  // Rule 9B: the holder's own demat account.
  const [dpId, setDpId] = useState('');
  const [clientId, setClientId] = useState('');

  const organizations = useOrganizations(open && kind === 'organization');

  return (
    <CreateModal
      open={open}
      title="Add a holder"
      submitLabel="Add them"
      onClose={onClose}
      invalidate={[['equity-holders']]}
      onSubmit={() =>
        api.post('/equity/holders', {
          kind,
          ...(kind === 'person' ? { person: { fullName, email: personEmail || null, phone: personPhone || null } } : {}),
          ...(kind === 'organization' ? { organizationId } : {}),
          ...(kind === 'entity' ? { heldByTenantId } : {}),
          residency,
          investmentBasis: residency === 'non_resident' ? investmentBasis || null : null,
          panNumber: panNumber || null,
          nominee: nomineeName ? { name: nomineeName } : null,
          address: address || null,
          occupation: occupation || null,
          nationality: nationality || null,
          guardianOrSpouseName: guardianOrSpouseName || null,
          dematAccount: dpId || clientId ? { dpId: dpId || null, clientId: clientId || null } : null,
        })
      }
    >
      <SelectInput
        label="Kind"
        required
        value={kind}
        onChange={(v) => setKind(v as HolderKind)}
        options={[
          { value: 'person', label: HOLDER_KIND_LABELS.person },
          { value: 'organization', label: HOLDER_KIND_LABELS.organization },
          { value: 'entity', label: HOLDER_KIND_LABELS.entity },
        ]}
      />

      {kind === 'person' && (
        <>
          <TextInput label="Full name" required autoFocus value={fullName} onChange={setFullName} />
          <Row>
            <TextInput label="Email" type="email" value={personEmail} onChange={setPersonEmail} />
            <TextInput label="Phone" type="tel" value={personPhone} onChange={setPersonPhone} />
          </Row>
          <p className="text-2xs text-ink-500">
            Matched against somebody already on file where the name, email or phone agree.
          </p>
        </>
      )}
      {kind === 'organization' && (
        <SelectInput
          label="Organisation"
          required
          value={organizationId}
          onChange={setOrganizationId}
          placeholder="Choose an organisation"
          options={(organizations.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))}
        />
      )}
      {kind === 'entity' && (
        <TextInput
          label="Tenant id"
          required
          value={heldByTenantId}
          onChange={setHeldByTenantId}
          hint="the group entity holding these shares — a subsidiary may not hold its own holding company's shares"
        />
      )}

      <Row>
        <SelectInput
          label="Residency"
          required
          value={residency}
          onChange={(v) => setResidency(v as Residency)}
          options={[
            { value: 'resident', label: RESIDENCY_LABELS.resident },
            { value: 'non_resident', label: RESIDENCY_LABELS.non_resident },
          ]}
        />
        {residency === 'non_resident' && (
          <SelectInput
            label="Investment basis"
            required
            value={investmentBasis}
            onChange={(v) => setInvestmentBasis(v as InvestmentBasis)}
            placeholder="Choose a basis"
            options={[
              { value: 'repatriable', label: INVESTMENT_BASIS_LABELS.repatriable },
              { value: 'non_repatriable', label: INVESTMENT_BASIS_LABELS.non_repatriable },
            ]}
          />
        )}
      </Row>
      <p className="text-2xs text-ink-500">
        Decides the FEMA filing calendar (FC-GPR/FC-TRS/FLA) for every allotment and transfer to them.
      </p>
      <Row>
        <TextInput label="PAN" value={panNumber} onChange={(v) => setPanNumber(v.toUpperCase())} />
        <TextInput label="Nominee" value={nomineeName} onChange={setNomineeName} placeholder="Optional" />
      </Row>

      <fieldset className="rounded-lg border border-ink-800 p-3">
        <legend className="px-1 text-2xs uppercase tracking-wide text-ink-500">MGT-1 fields</legend>
        <div className="flex flex-col gap-3">
          <TextInput label="Address" value={address} onChange={setAddress} placeholder="Optional" />
          <Row>
            <TextInput label="Occupation" value={occupation} onChange={setOccupation} placeholder="Optional" />
            <TextInput label="Nationality" value={nationality} onChange={setNationality} placeholder="Optional" />
          </Row>
          <TextInput label="Father / spouse name" value={guardianOrSpouseName} onChange={setGuardianOrSpouseName} placeholder="Optional" />
        </div>
      </fieldset>

      <fieldset className="rounded-lg border border-ink-800 p-3">
        <legend className="px-1 text-2xs uppercase tracking-wide text-ink-500">Demat account (Rule 9B)</legend>
        <Row>
          <TextInput label="DP ID" value={dpId} onChange={setDpId} placeholder="Optional" />
          <TextInput label="Client ID" value={clientId} onChange={setClientId} placeholder="Optional" />
        </Row>
        <p className="mt-2 text-2xs text-ink-500">
          Every share this holder holds is treated as dematerialised once this is set.
        </p>
      </fieldset>
    </CreateModal>
  );
}

export function Holders() {
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-holders'],
    queryFn: () => api.get<{ items: HolderView[] }>('/equity/holders'),
  });
  const { data: capTable } = useQuery({
    queryKey: ['equity-cap-table'],
    queryFn: () => api.get<CapTableView>('/equity/cap-table'),
  });

  if (error) return <ErrorBox error={error} />;

  const rows = data?.items ?? [];

  return (
    <div>
      <NewHolder open={creating} onClose={() => setCreating(false)} />
      <PageHeader
        title="Holders"
        subtitle="Everybody on the register."
        actions={can('holders:C') && <NewButton label="Add a holder" onClick={() => setCreating(true)} />}
      />

      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState message="No holder is on file yet." hint="Add a holder before proposing the first allotment." />
        </Card>
      ) : (
        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Folio</th>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Residency</th>
                  <th>Classes held</th>
                  <th className="text-right">Fully diluted %</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => {
                  const classesHeld = [...new Set(capTable?.rows.filter((r) => r.holderId === h.id).map((r) => r.shareClassName))];
                  const total = capTable?.holderTotals.find((t) => t.holderId === h.id);
                  return (
                    <tr key={h.id}>
                      <td className="mono text-2xs">{h.folioNumber}</td>
                      <td>
                        <Link to={`/equity/holders/${h.id}`} className="text-ink-100 hover:text-accent-soft">
                          {h.displayName}
                        </Link>
                      </td>
                      <td className="text-ink-300">{HOLDER_KIND_LABELS[h.kind]}</td>
                      <td className="text-ink-300">{RESIDENCY_LABELS[h.residency]}</td>
                      <td className="text-2xs text-ink-400">{classesHeld.length ? classesHeld.join(', ') : '—'}</td>
                      <td className="text-right tabular-nums">{total ? `${total.fullyDilutedPct.toFixed(2)}%` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function CreateSignIn({ holder, onClose }: { holder: HolderView; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<{ email: string; password: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ email: string; password: string | null; created: boolean }>('/auth/sign-ins', {
      personId: holder.personId,
      roleSlug: 'shareholder',
      email,
    }),
    onSuccess: (res) => setResult(res),
    onError: (e) => setError(messageOf(e)),
  });

  if (result) {
    return (
      <Modal open title="Sign-in created" onClose={onClose} footer={<button className="btn-primary" onClick={onClose}>Done</button>}>
        <p className="text-sm text-ink-200">
          Email <span className="mono">{result.email}</span>
        </p>
        {result.password ? (
          <>
            <div className="mt-3 flex items-center gap-2 rounded-md border border-ink-800 bg-ink-950 px-3 py-2">
              <span className="mono flex-1 text-sm text-ink-100">{result.password}</span>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => navigator.clipboard?.writeText(result.password ?? '')}
              >
                Copy
              </button>
            </div>
            <p className="mt-2 text-2xs font-semibold text-band-watch">
              This password is shown once. Hand it over directly.
            </p>
          </>
        ) : (
          <p className="mt-2 text-2xs text-ink-500">No new password was issued — this sign-in already exists.</p>
        )}
      </Modal>
    );
  }

  return (
    <CreateModal
      open
      title={`Create a sign-in for ${holder.displayName}`}
      submitLabel="Create it"
      onClose={onClose}
      onSubmit={() => create.mutateAsync()}
    >
      {error && <p className="text-sm text-band-critical">{error}</p>}
      <TextInput label="Email" type="email" required autoFocus value={email} onChange={setEmail} />
      <p className="text-2xs text-ink-500">
        No invite and no one-time code — the password is generated and shown once, right here.
      </p>
    </CreateModal>
  );
}

export function HolderDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const [creatingSignIn, setCreatingSignIn] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-holder', id],
    queryFn: () => api.get<HolderView>(`/equity/holders/${id}`),
    enabled: Boolean(id),
  });
  const { data: holdings } = useQuery({
    queryKey: ['equity-holdings', id],
    queryFn: () => api.get<HoldingsView>(`/equity/holdings/${id}`),
    enabled: Boolean(id),
  });
  const { data: certificates } = useQuery({
    queryKey: ['equity-certificates'],
    queryFn: () => api.get<{ items: CertificateView[] }>('/equity/certificates'),
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <Loading />;

  const ownCertificates = (certificates?.items ?? []).filter((c) => c.holderId === data.id);

  return (
    <div>
      {creatingSignIn && <CreateSignIn holder={data} onClose={() => setCreatingSignIn(false)} />}
      <PageHeader
        title={data.displayName}
        subtitle={`Folio ${data.folioNumber}`}
        actions={
          data.kind === 'person' &&
          data.personId &&
          can('holders:C') && <NewButton label="Create sign-in" onClick={() => setCreatingSignIn(true)} />
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Details">
          <dl>
            <Field label="Kind">{HOLDER_KIND_LABELS[data.kind]}</Field>
            <Field label="Residency">{RESIDENCY_LABELS[data.residency]}</Field>
            <Field label="Investment basis">
              {data.investmentBasis ? INVESTMENT_BASIS_LABELS[data.investmentBasis] : '—'}
            </Field>
            <Field label="Status">{data.status === 'active' ? 'Active' : 'Ceased'}</Field>
            <Field label="Address">{data.address || 'Not recorded'}</Field>
            <Field label="Occupation">{data.occupation || 'Not recorded'}</Field>
            <Field label="Nationality">{data.nationality || 'Not recorded'}</Field>
            <Field label="Father / spouse name">{data.guardianOrSpouseName || 'Not recorded'}</Field>
            <Field label="Demat account">
              {data.dematAccount ? 'On record' : 'Not recorded — holds physically'}
            </Field>
          </dl>
        </Card>

        <Card title="Holdings by class">
          {!holdings || holdings.rows.length === 0 ? (
            <EmptyState message="No effective holding yet." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Class</th>
                  <th className="text-right">Count</th>
                  <th>Certificates</th>
                </tr>
              </thead>
              <tbody>
                {holdings.rows.map((r) => (
                  <tr key={r.shareClassId}>
                    <td>{r.shareClassName}</td>
                    <td className="text-right tabular-nums">{r.count.toLocaleString('en-IN')}</td>
                    <td className="mono text-2xs text-ink-400">{r.certificateNumbers.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Certificates" className="lg:col-span-2">
          {ownCertificates.length === 0 ? (
            <EmptyState message="No certificate issued yet." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Status</th>
                  <th>Issued</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ownCertificates.map((c) => (
                  <tr key={c.id}>
                    <td className="mono text-2xs">{c.certificateNumber}</td>
                    <td className="text-ink-300">{c.status}</td>
                    <td className="text-2xs text-ink-400">{date(c.issuedOn)}</td>
                    <td>
                      <Link to={`/equity/certificates/${c.id}/document`} className="btn-ghost">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
