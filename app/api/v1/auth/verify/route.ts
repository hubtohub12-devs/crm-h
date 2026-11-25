import { verifyEmail } from '@/server/identity/routes';
import { logged } from '@/server/observability/request-log';

export const POST = logged(verifyEmail);
export const dynamic = 'force-dynamic';
