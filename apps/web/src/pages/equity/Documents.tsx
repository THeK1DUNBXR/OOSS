/**
 * Entity documents — resolutions, valuation reports, agreements and filings
 * published to shareholders, the board, or kept with the company secretary.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ENTITY_DOCUMENT_AUDIENCES,
  ENTITY_DOCUMENT_KINDS,
  type EntityDocumentAudience,
  type EntityDocumentKind,
  type EntityDocumentView,
} from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { words } from '../../lib/words.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui.js';
import { CreateModal, NewButton, Row, SelectInput, TextInput } from '../../components/forms.js';

const AUDIENCE_LABELS: Record<EntityDocumentAudience, string> = {
  shareholders: 'Shareholders',
  board: 'Board',
  secretary: 'Company secretary',
};

function NewDocument({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<EntityDocumentKind>('resolution');
  const [audience, setAudience] = useState<EntityDocumentAudience>('shareholders');
  const [fileRef, setFileRef] = useState('');

  return (
    <CreateModal
      open={open}
      title="Publish a document"
      submitLabel="Publish it"
      onClose={onClose}
      invalidate={[['equity-documents']]}
      onSubmit={() => api.post('/equity/documents', { title, kind, audience, fileRef })}
    >
      <TextInput label="Title" required autoFocus value={title} onChange={setTitle} />
      <Row>
        <SelectInput
          label="Kind"
          required
          value={kind}
          onChange={(v) => setKind(v as EntityDocumentKind)}
          options={ENTITY_DOCUMENT_KINDS.map((k) => ({ value: k, label: words(k) }))}
        />
        <SelectInput
          label="Audience"
          required
          value={audience}
          onChange={(v) => setAudience(v as EntityDocumentAudience)}
          options={ENTITY_DOCUMENT_AUDIENCES.map((a) => ({ value: a, label: AUDIENCE_LABELS[a] }))}
        />
      </Row>
      <TextInput label="File reference" required value={fileRef} onChange={setFileRef} placeholder="A URL or a filing reference" />
    </CreateModal>
  );
}

export function Documents() {
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['equity-documents'],
    queryFn: () => api.get<{ items: EntityDocumentView[] }>('/equity/documents'),
  });

  if (error) return <ErrorBox error={error} />;
  const rows = data?.items ?? [];
  const byAudience = (a: EntityDocumentAudience) => rows.filter((d) => d.audience === a);

  return (
    <div>
      <NewDocument open={creating} onClose={() => setCreating(false)} />
      <PageHeader
        title="Entity documents"
        subtitle="Resolutions, valuation reports, agreements and filings."
        actions={can('entity_documents:C') && <NewButton label="Publish document" onClick={() => setCreating(true)} />}
      />

      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState message="Nothing has been published yet." />
        </Card>
      ) : (
        <div className="space-y-4">
          {ENTITY_DOCUMENT_AUDIENCES.map((audience) => {
            const items = byAudience(audience);
            if (items.length === 0) return null;
            return (
              <Card key={audience} title={AUDIENCE_LABELS[audience]} bodyClassName="p-0">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Kind</th>
                      <th>Published</th>
                      <th>File</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((d) => (
                      <tr key={d.id}>
                        <td className="text-ink-100">{d.title}</td>
                        <td>
                          <span className="chip border-ink-700 text-ink-400">{words(d.kind)}</span>
                        </td>
                        <td className="text-2xs text-ink-400">{date(d.createdAt)}</td>
                        <td className="text-2xs">
                          {/^https?:\/\//.test(d.fileRef) ? (
                            <a href={d.fileRef} target="_blank" rel="noreferrer" className="text-accent-soft hover:underline">
                              Open
                            </a>
                          ) : (
                            <span className="mono text-ink-500">{d.fileRef}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
