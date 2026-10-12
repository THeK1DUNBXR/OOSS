import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { BandChip, Metric, Withheld } from './ui.js';
import { NOT_MEASURED, withheldWord } from '../lib/words.js';

// The future flags match the app's BrowserRouter setup and silence React
// Router's v7 migration warnings, which would otherwise bury real test output.
function renderInRouter(ui: React.ReactElement) {
  return render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter>);
}

describe('Metric', () => {
  it('is a link to its drill target when it has one', () => {
    renderInRouter(<Metric label="Open invoices" value={3} drillTo="/finance/invoices" />);

    const link = screen.getByRole('link', { name: /open invoices/i });
    expect(link).toHaveAttribute('href', '/finance/invoices');
    expect(link).toHaveTextContent('3');
  });

  it('shows the reason it has no drill target, and is not a link', () => {
    renderInRouter(
      <Metric
        label="Attendance"
        value={12}
        noActionReason="Computed from today's snapshot; there is no per-record view yet"
      />,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText("Computed from today's snapshot; there is no per-record view yet")).toBeInTheDocument();
  });

  it('keeps not measured, zero and withheld as three different things on screen', () => {
    renderInRouter(
      <>
        <Metric label="Zero" value={0} noActionReason="A counted zero" />
        <Metric label="Unmeasured" value={<BandChip band={null} />} noActionReason="No snapshot yet" />
        <Metric label="Hidden" value={<Withheld reason="no_permission" />} noActionReason="Access is checked" />
      </>,
    );

    const valueOf = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement;

    expect(valueOf('Zero')).toHaveTextContent(/^0$/);
    expect(valueOf('Unmeasured')).toHaveTextContent(NOT_MEASURED);
    expect(valueOf('Unmeasured')).not.toHaveTextContent(/^0$/);
    expect(valueOf('Hidden')).toHaveTextContent(withheldWord('no_permission'));
    expect(valueOf('Hidden')).not.toHaveTextContent(/^0$/);
  });
});
