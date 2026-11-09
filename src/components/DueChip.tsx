import { formatDate, relativeDue, urgencyOf, type Inspection } from '../lib/inspections.ts';

export function DueChip({ inspection, compact = false }: { inspection: Inspection; compact?: boolean }) {
  const urgency = urgencyOf(inspection);
  const title = inspection.scheduled
    ? `Scheduled${inspection.scheduledDate ? ' for ' + formatDate(inspection.scheduledDate) : ''} · due ${formatDate(inspection.due)}`
    : relativeDue(inspection.due);
  return (
    <span className={`chip u-${urgency}`} title={title}>
      {inspection.scheduled && (
        <span className="chip-check" aria-label="scheduled">
          ✓
        </span>
      )}
      {formatDate(inspection.due, compact ? 'short' : 'long')}
    </span>
  );
}
