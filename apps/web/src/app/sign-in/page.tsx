import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth';
import { SignInPanel } from './sign-in-panel';

export const metadata = { title: 'Sign in' };

export default async function SignInPage() {
  const viewer = await getViewer();
  if (viewer) redirect('/');

  return <SignInPanel localAuth={process.env.AUTH_PROVIDER !== 'supabase'} />;
}
