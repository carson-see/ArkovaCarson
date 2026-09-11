/**
 * Platform-admin selected-organization invitations (UAT-22).
 *
 * Browser RPC `invite_member` is deliberately scoped to an ORG_ADMIN's own
 * profile org, so it cannot serve a platform admin operating in a selected
 * customer org. This worker path uses the service-role client after an
 * explicit platform-admin check and treats the client UUID as the invitation
 * primary key. The existing PK is the durable, cross-instance idempotency
 * claim; a 23505 replay must match the committed trusted row exactly.
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { sendEmail } from '../email/sender.js';
import { buildInvitationEmail } from '../email/templates.js';
import { buildInviteAcceptUrl } from '../lib/urls.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';

const CreateInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['INDIVIDUAL', 'ORG_ADMIN']),
  idempotency_key: z.string().uuid(),
});

interface InvitationRow {
  id: string;
  email: string;
  role: 'INDIVIDUAL' | 'ORG_ADMIN';
  org_id: string;
  invited_by: string;
  status: string;
  token: string | null;
  expires_at: string;
}

const INVITATION_COLUMNS = 'id, email, role, org_id, invited_by, status, token, expires_at';

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}

function isExactReplay(
  row: InvitationRow,
  input: z.infer<typeof CreateInvitationSchema>,
  actorId: string,
  orgId: string,
): boolean {
  return row.id === input.idempotency_key
    && row.email.toLowerCase() === input.email
    && row.role === input.role
    && row.org_id === orgId
    && row.invited_by === actorId
    && row.status === 'pending'
    && new Date(row.expires_at).getTime() > Date.now()
    && z.string().uuid().safeParse(row.token).success;
}

export async function handleAdminCreateInvitation(
  actorId: string,
  orgId: string,
  req: Request,
  res: Response,
): Promise<void> {
  if (!(await isPlatformAdmin(actorId))) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const parsed = CreateInvitationSchema.safeParse(req.body ?? {});
  if (!parsed.success || !z.string().uuid().safeParse(orgId).success) {
    res.status(400).json({ error: 'A valid email, role, organization, and submission key are required.' });
    return;
  }
  const input = parsed.data;

  const { data: org, error: orgError } = await db
    .from('organizations')
    .select('id, display_name')
    .eq('id', orgId)
    .maybeSingle();
  if (orgError) {
    logger.error({ orgId }, 'Admin invitation: organization lookup failed');
    res.status(500).json({ error: 'Failed to create the invitation.' });
    return;
  }
  if (!org) {
    res.status(404).json({ error: 'Organization not found.' });
    return;
  }

  const { data: actor, error: actorError } = await db
    .from('profiles')
    .select('full_name')
    .eq('id', actorId)
    .maybeSingle();
  if (actorError) {
    logger.warn({ actorId }, 'Admin invitation: inviter name lookup failed');
  }

  // Match the tenant RPC's already-member guard. A profile's legacy primary
  // org and the multi-org membership table are both authoritative signals.
  const { data: inviteeProfile, error: inviteeError } = await db
    .from('profiles')
    .select('id, org_id')
    .eq('email', input.email)
    .maybeSingle();
  if (inviteeError) {
    logger.error({ orgId }, 'Admin invitation: existing-account lookup failed');
    res.status(500).json({ error: 'Failed to create the invitation.' });
    return;
  }
  const existingProfile = inviteeProfile as { id?: string; org_id?: string | null } | null;
  let alreadyMember = existingProfile?.org_id === orgId;
  if (!alreadyMember && existingProfile?.id) {
    const { data: membership, error: membershipError } = await db
      .from('org_members')
      .select('id')
      .eq('user_id', existingProfile.id)
      .eq('org_id', orgId)
      .maybeSingle();
    if (membershipError) {
      logger.error({ orgId }, 'Admin invitation: existing-membership lookup failed');
      res.status(500).json({ error: 'Failed to create the invitation.' });
      return;
    }
    alreadyMember = Boolean(membership);
  }
  if (alreadyMember) {
    res.status(409).json({
      code: 'already_member',
      error: 'This person is already a member of the organization.',
    });
    return;
  }

  const token = randomUUID();
  const { data: inserted, error: insertError } = await db
    .from('invitations')
    .insert({
      id: input.idempotency_key,
      email: input.email,
      role: input.role,
      org_id: orgId,
      invited_by: actorId,
      status: 'pending',
      token,
    })
    .select(INVITATION_COLUMNS)
    .single();

  let invitation = inserted as InvitationRow | null;
  let replayed = false;
  if (insertError) {
    if (!isDuplicateKey(insertError)) {
      logger.error({ orgId, code: (insertError as { code?: string }).code }, 'Admin invitation: insert failed');
      res.status(500).json({ error: 'Failed to create the invitation.' });
      return;
    }

    const { data: existing, error: existingError } = await db
      .from('invitations')
      .select(INVITATION_COLUMNS)
      .eq('id', input.idempotency_key)
      .maybeSingle();
    if (existingError || !existing) {
      logger.error({ orgId }, 'Admin invitation: idempotency replay lookup failed');
      res.status(500).json({ error: 'Failed to verify the existing invitation.' });
      return;
    }
    invitation = existing as InvitationRow;
    replayed = true;
  }

  if (!invitation || !isExactReplay(invitation, input, actorId, orgId)) {
    res.status(409).json({ error: 'This submission key belongs to a different or expired invitation.' });
    return;
  }

  if (!replayed) {
    const { error: auditError } = await db.from('audit_events').insert({
      event_type: 'MEMBER_INVITED',
      event_category: 'ORGANIZATION',
      actor_id: actorId,
      org_id: orgId,
      target_type: 'invitation',
      target_id: invitation.id,
      details: JSON.stringify({ role: invitation.role }),
    });
    if (auditError) logger.warn({ actorId, orgId }, 'Admin invitation: audit emit failed');
  }

  const organizationName = (org as { display_name?: string | null }).display_name ?? 'the organization';
  const inviterName = actorError
    ? undefined
    : ((actor as { full_name?: string | null } | null)?.full_name ?? undefined);
  const inviteUrl = buildInviteAcceptUrl(invitation.token!);
  const message = buildInvitationEmail({
    recipientEmail: invitation.email,
    organizationName,
    inviterName,
    role: invitation.role,
    inviteUrl,
  });
  const sendResult = await sendEmail({
    to: invitation.email,
    ...message,
    emailType: 'invitation',
    actorId,
    orgId,
    idempotencyKey: `invitation/${invitation.id}`,
  });
  if (!sendResult.success) {
    logger.warn({ actorId, orgId, invitationId: invitation.id }, 'Admin invitation: email delivery failed');
    res.status(502).json({
      sent: false,
      created: true,
      code: 'email_delivery_failed',
      error: 'Invitation was created, but the email could not be sent.',
    });
    return;
  }

  logger.info({ actorId, orgId, invitationId: invitation.id, replayed }, 'Admin invitation email sent');
  res.status(replayed ? 200 : 201).json({ sent: true, invitationId: invitation.id, replayed });
}
