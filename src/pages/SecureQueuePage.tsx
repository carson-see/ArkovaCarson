/**
 * Secure Queue Page (QUEUE-01 / SCRUM-2894 — L2-A1)
 *
 * The `consumer_secure_queue` surface from queueContract.ts's QUEUE_SURFACES
 * — the individual/consumer-facing list of documents waiting to be secured.
 * Distinct from `/organization/queue` (org_duplicate_review, PENDING_RESOLUTION
 * collisions) and `/organization/review-queue` (org_approvals). Solo users see
 * ONLY the personal tab; org admins additionally see every PENDING item across
 * their org (read + remove where RLS allows — see useSecureQueue.ts).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, FileText, Inbox, Loader2, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useSecureQueue, type SecureQueueItem } from '@/hooks/useSecureQueue';
import { useOrgMembers } from '@/hooks/useOrgMembers';
import { ROUTES } from '@/lib/routes';
import { SECURE_QUEUE_LABELS, SECURE_QUEUE_PAGE_LABELS, CREDENTIAL_TYPE_LABELS, SECURE_DIALOG_LABELS } from '@/lib/copy';
import { toast } from 'sonner';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

interface QueueItemRowProps {
  item: SecureQueueItem;
  ownerLabel?: string | null;
  onRemove: (item: SecureQueueItem) => void;
  removeDisabled?: boolean;
  removeDisabledReason?: string;
}

function QueueItemRow({ item, ownerLabel, onRemove, removeDisabled, removeDisabledReason }: Readonly<QueueItemRowProps>) {
  const typeLabel = item.credentialType
    ? CREDENTIAL_TYPE_LABELS[item.credentialType as keyof typeof CREDENTIAL_TYPE_LABELS] ?? item.credentialType
    : null;

  const removeButton = (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 px-2 text-muted-foreground hover:text-destructive"
      aria-label={SECURE_QUEUE_PAGE_LABELS.REMOVE_BUTTON_ARIA}
      data-testid={`remove-queue-item-${item.id}`}
      disabled={removeDisabled}
      onClick={() => onRemove(item)}
    >
      <Trash2 className="h-4 w-4" />
    </Button>
  );

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <FileText className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium">{item.filename}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span>{formatFileSize(item.fileSize)}</span>
              <span>&middot;</span>
              <span>{formatDate(item.createdAt)}</span>
              {ownerLabel && (
                <>
                  <span>&middot;</span>
                  <span>{SECURE_QUEUE_PAGE_LABELS.OWNER_LABEL} {ownerLabel}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {typeLabel && <Badge variant="outline">{typeLabel}</Badge>}
          {removeDisabled ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>{removeButton}</span>
              </TooltipTrigger>
              <TooltipContent>{removeDisabledReason}</TooltipContent>
            </Tooltip>
          ) : (
            removeButton
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface QueueListProps {
  items: SecureQueueItem[];
  loading: boolean;
  ownerLabels?: Map<string, string>;
  onRemove: (item: SecureQueueItem) => void;
  disableRemoveForOthers?: boolean;
}

function QueueList({ items, loading, ownerLabels, onRemove, disableRemoveForOthers }: Readonly<QueueListProps>) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 px-4">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted mb-6">
            <Inbox className="h-10 w-10 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold text-center">{SECURE_QUEUE_LABELS.EMPTY_TITLE}</h3>
          <p className="mt-2 text-sm text-muted-foreground text-center max-w-sm">
            {SECURE_QUEUE_LABELS.EMPTY_DESC}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="secure-queue-list">
      {items.map((item) => (
        <QueueItemRow
          key={item.id}
          item={item}
          ownerLabel={ownerLabels?.get(item.ownerUserId)}
          onRemove={onRemove}
          removeDisabled={!item.isOwn && !!disableRemoveForOthers}
          removeDisabledReason={SECURE_QUEUE_PAGE_LABELS.ADMIN_REMOVE_UNAVAILABLE}
        />
      ))}
    </div>
  );
}

export function SecureQueuePage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const isOrgAdmin = profile?.role === 'ORG_ADMIN' && !!profile.org_id;

  const personalQueue = useSecureQueue('own');
  const orgQueue = useSecureQueue(isOrgAdmin ? 'org' : 'own');
  const { members } = useOrgMembers(isOrgAdmin ? profile?.org_id : null);
  const ownerLabels = new Map(members.map((m) => [m.id, m.fullName || m.email]));

  const [activeTab, setActiveTab] = useState<'personal' | 'org'>('personal');
  const [pendingRemoval, setPendingRemoval] = useState<SecureQueueItem | null>(null);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const requestRemove = (item: SecureQueueItem) => setPendingRemoval(item);

  const confirmRemove = async () => {
    if (!pendingRemoval) return;
    const queue = activeTab === 'org' ? orgQueue : personalQueue;
    try {
      await queue.removeItem(pendingRemoval.id);
      toast.success(SECURE_QUEUE_PAGE_LABELS.REMOVE_TOAST);
    } catch {
      toast.error(SECURE_QUEUE_PAGE_LABELS.REMOVE_FAILED);
    } finally {
      setPendingRemoval(null);
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <Clock className="h-6 w-6 text-primary" />
              {SECURE_QUEUE_LABELS.PAGE_TITLE}
            </h1>
            <p className="text-muted-foreground mt-1">{SECURE_QUEUE_LABELS.PAGE_SUBTITLE}</p>
            <p className="text-xs text-muted-foreground mt-1">{SECURE_QUEUE_PAGE_LABELS.BATCH_EXPLAINER}</p>
          </div>
        </div>

        {isOrgAdmin ? (
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'personal' | 'org')}>
            <TabsList>
              <TabsTrigger value="personal" data-testid="secure-queue-tab-personal">
                {SECURE_QUEUE_PAGE_LABELS.PERSONAL_TAB_LABEL}
              </TabsTrigger>
              <TabsTrigger value="org" data-testid="secure-queue-tab-org">
                {SECURE_QUEUE_PAGE_LABELS.ORG_TAB_LABEL}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="personal" className="mt-4">
              <QueueList
                items={personalQueue.items}
                loading={personalQueue.loading}
                onRemove={requestRemove}
              />
            </TabsContent>
            <TabsContent value="org" className="mt-4">
              <p className="mb-3 text-sm text-muted-foreground">{SECURE_QUEUE_PAGE_LABELS.ORG_QUEUE_SUBTITLE}</p>
              <QueueList
                items={orgQueue.items}
                loading={orgQueue.loading}
                ownerLabels={ownerLabels}
                onRemove={requestRemove}
                disableRemoveForOthers
              />
            </TabsContent>
          </Tabs>
        ) : (
          <QueueList
            items={personalQueue.items}
            loading={personalQueue.loading}
            onRemove={requestRemove}
          />
        )}

        <AlertDialog open={!!pendingRemoval} onOpenChange={(open) => !open && setPendingRemoval(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{SECURE_QUEUE_PAGE_LABELS.REMOVE_CONFIRM_TITLE}</AlertDialogTitle>
              <AlertDialogDescription>{SECURE_QUEUE_PAGE_LABELS.REMOVE_CONFIRM_BODY}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{SECURE_DIALOG_LABELS.CANCEL}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void confirmRemove()} data-testid="confirm-remove-queue-item">
                {SECURE_QUEUE_PAGE_LABELS.REMOVE_ACTION}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </AppShell>
    </TooltipProvider>
  );
}

export default SecureQueuePage;
