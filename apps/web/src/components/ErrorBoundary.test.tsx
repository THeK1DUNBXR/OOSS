import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary.js';

// Toggled by each test. A component that throws while the flag is set and
// renders normally once it is cleared, so "Try again" can be shown to recover.
let explode = true;

function Screen() {
  if (explode) throw new Error('render exploded');
  return <p>Invoice list</p>;
}

describe('ErrorBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    explode = true;
    // React logs every caught render error; the boundary's own log line is what matters here.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('renders its children when nothing throws', () => {
    explode = false;
    render(
      <ErrorBoundary scope="route">
        <Screen />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Invoice list')).toBeInTheDocument();
  });

  it('renders the route fallback with a reference id when a screen throws', () => {
    render(
      <ErrorBoundary scope="route">
        <Screen />
      </ErrorBoundary>,
    );

    expect(screen.getByText('This screen could not be shown.')).toBeInTheDocument();
    expect(screen.getByText(/^Reference: [A-Z0-9]{1,8}$/)).toBeInTheDocument();
    expect(screen.queryByText('Invoice list')).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/^\[[A-Z0-9]+\] route render error$/),
      expect.any(Error),
      expect.anything(),
    );
  });

  it('renders the app-level fallback, with a reload action, for the whole-app scope', () => {
    render(
      <ErrorBoundary scope="app">
        <Screen />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('clears the error and renders the children again on Try again', async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary scope="route">
        <Screen />
      </ErrorBoundary>,
    );

    explode = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('Invoice list')).toBeInTheDocument();
    expect(screen.queryByText('This screen could not be shown.')).toBeNull();
  });
});
