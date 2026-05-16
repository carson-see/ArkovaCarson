/**
 * Narrows generated Database types so that audit_events.event_category
 * is AuditEventCategory instead of plain string. Applied at the
 * SupabaseClient generic level in db.ts so every .from('audit_events')
 * .insert() call is automatically type-checked.
 *
 * When database.types.ts is regenerated, this override still applies —
 * it only touches the event_category field and passes everything else
 * through unchanged.
 */
import type { Database } from './database.types.js';
import type { AuditEventCategory } from './audit-event-category.js';

type OrigTables = Database['public']['Tables'];

type NarrowCategory<T, K extends keyof T> = Omit<T, K> & {
  [P in K]: AuditEventCategory;
};

type NarrowCategoryOpt<T, K extends keyof T> = Omit<T, K> & {
  [P in K]?: AuditEventCategory;
};

type AuditEventsOverride = {
  Row: NarrowCategory<OrigTables['audit_events']['Row'], 'event_category'>;
  Insert: NarrowCategory<OrigTables['audit_events']['Insert'], 'event_category'>;
  Update: NarrowCategoryOpt<OrigTables['audit_events']['Update'], 'event_category'>;
  Relationships: OrigTables['audit_events']['Relationships'];
};

type AuditEventsArchiveOverride = {
  Row: NarrowCategory<OrigTables['audit_events_archive']['Row'], 'event_category'>;
  Insert: NarrowCategory<OrigTables['audit_events_archive']['Insert'], 'event_category'>;
  Update: NarrowCategoryOpt<OrigTables['audit_events_archive']['Update'], 'event_category'>;
  Relationships: OrigTables['audit_events_archive']['Relationships'];
};

export type TypeSafeDatabase = Omit<Database, 'public'> & {
  public: Omit<Database['public'], 'Tables'> & {
    Tables: Omit<OrigTables, 'audit_events' | 'audit_events_archive'> & {
      audit_events: AuditEventsOverride;
      audit_events_archive: AuditEventsArchiveOverride;
    };
  };
};
