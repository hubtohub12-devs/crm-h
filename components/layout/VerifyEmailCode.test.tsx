import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/messages/en.json';

const verifyEmailCode = vi.fn(async (_email: string, code: string) => {
  if (code !== '123456') throw Object.assign(new Error('That code is wrong or has expired.'), { code: 'invalid_code' });
  return { access_token: 't', refresh_token: null, expires_at: null, user_id: 'u', memberships: [] };
});
const resendVerification = vi.fn(async () => {});
vi.mock('@/lib/api/endpoints/auth', () => ({ verifyEmailCode, resendVerification }));
vi.mock('@/components/layout/AuthPage', () => ({
  AuthPage: ({ title, children }: { title: string; children: React.ReactNode }) => <main><h1>{title}</h1>{children}</main>,
  FormMessage: ({ children }: { children: React.ReactNode }) => <p role="alert">{children}</p>,
}));

const { VerifyEmailCode } = await import('./VerifyEmailCode');

function renderIt(justSent: boolean) {
  const onVerified = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <VerifyEmailCode email="nadia@example.com" justSent={justSent} onVerified={onVerified} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return onVerified;
}

describe('VerifyEmailCode', () => {
  it('confirms with the emailed code and signs in', async () => {
    const onVerified = renderIt(true);
    expect(screen.getByText(/We sent a code to nadia@example.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send again in 60s/ })).toBeDisabled();

    const input = screen.getByLabelText('Confirmation code');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
    expect(screen.getByText('Enter the code from the email.')).toBeInTheDocument();
    expect(verifyEmailCode).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '000 000' } });
    expect(input).toHaveValue('000000');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is wrong or has expired.');

    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
    await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
  });

  it('lets an unconfirmed account ask for a new code straight away', async () => {
    renderIt(false);
    fireEvent.click(screen.getByRole('button', { name: 'Send a new code' }));
    await waitFor(() => expect(resendVerification).toHaveBeenCalledWith('nadia@example.com'));
  });
});
