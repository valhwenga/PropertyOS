import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth';

export default async function Home() {
  const viewer = await getViewer();
  if (!viewer) redirect('/sign-in');
  // Residents with no operator membership go straight to their portal.
  if (viewer.organisations.length === 0 && viewer.residentLeases.length > 0) redirect('/portal');
  redirect('/app');
}
