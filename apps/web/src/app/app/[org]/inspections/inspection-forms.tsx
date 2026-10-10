'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import {
  createInspectionAction, createTemplateVersionAction, finaliseInspectionAction,
  recordFindingsAction, reviseInspectionAction,
} from './actions';

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title = 'Not saved' }: { state: Outcome | null; title?: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

export interface UnitChoice {
  unitId: string; label: string; leaseId: string | null; residentName: string | null;
}
export interface TemplateChoice { id: string; label: string }

const CONDITIONS = [
  { value: 'not_applicable', label: 'Not checked' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' },
  { value: 'damaged', label: 'Damaged' },
];

/**
 * Fair wear and tear is not damage.
 *
 * The labels say what each choice means for a deposit, because that is the only
 * reason the distinction exists and getting it wrong is how a deduction becomes
 * indefensible.
 */
const DAMAGE_TYPES = [
  { value: 'fair_wear_and_tear', label: 'Fair wear and tear — not deductible' },
  { value: 'damage', label: 'Damage — may support a deduction' },
  { value: 'missing', label: 'Missing — may support a deduction' },
];

function Select({
  name, label, options, defaultValue, blank, required, hint,
}: {
  name: string; label: string; options: { value: string; label: string }[];
  defaultValue?: string | null; blank?: string; required?: boolean; hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-ink-700">{label}</label>
      <select
        id={name} name={name} defaultValue={defaultValue ?? ''} required={required}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      >
        {blank ? <option value="">{blank}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

function Field({
  name, label, type = 'text', defaultValue, required, placeholder, hint,
}: {
  name: string; label: string; type?: string; defaultValue?: string | null;
  required?: boolean; placeholder?: string; hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-ink-700">{label}</label>
      <input
        id={name} name={name} type={type} defaultValue={defaultValue ?? ''}
        required={required} placeholder={placeholder}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      />
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------- scheduling */

export function CreateInspectionForm({
  org, units, templates, today,
}: {
  org: string; units: UnitChoice[]; templates: TemplateChoice[]; today: string;
}) {
  const [state, action] = useActionState(createInspectionAction, null);
  const [open, setOpen] = useState(false);
  const [unitId, setUnitId] = useState('');
  const unit = units.find((u) => u.unitId === unitId);

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Could not start the inspection" />
        <Button type="button" variant="primary" onClick={() => setOpen(true)}>
          Start an inspection
        </Button>
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-sm text-ink-700">
          There is no checklist to inspect against yet. Publish one first — an inspection
          records the checklist version it was performed against, so it cannot be started
          without one.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="leaseId" value={unit?.leaseId ?? ''} />
        <h2 className="text-sm font-semibold text-ink-900">Start an inspection</h2>
        <Problem state={state} title="Could not start the inspection" />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="unitId" className="block text-sm font-medium text-ink-700">Unit</label>
            <select
              id="unitId" name="unitId" required value={unitId}
              onChange={(e) => setUnitId(e.target.value)}
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            >
              <option value="">Choose a unit</option>
              {units.map((u) => (
                <option key={u.unitId} value={u.unitId}>{u.label}</option>
              ))}
            </select>
            <p className="text-xs text-ink-500">
              {unit?.leaseId
                ? `Attached to the current lease${unit.residentName ? ` — ${unit.residentName}` : ''}.`
                : unitId
                  ? 'No current lease on this unit, so the inspection stands on its own.'
                  : 'The current lease, if there is one, is attached automatically.'}
            </p>
          </div>
          <Select
            name="inspectionType" label="Type" required defaultValue="routine"
            options={[
              { value: 'move_in', label: 'Move in' },
              { value: 'move_out', label: 'Move out' },
              { value: 'routine', label: 'Routine' },
              { value: 'other', label: 'Other' },
            ]}
          />
          <Select
            name="templateId" label="Checklist" required
            options={templates.map((t) => ({ value: t.id, label: t.label }))}
            hint="The version chosen is recorded on the inspection and never changes afterwards."
          />
          <Field
            name="scheduledFor" label="Scheduled for" type="date" defaultValue={today}
          />
        </div>

        <p className="text-sm text-ink-500">
          Every item starts unchecked. Nothing is assumed to be in good order until an
          inspector says so.
        </p>

        <div className="flex gap-2">
          <Button type="submit" variant="primary">Create the checklist</Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

/* ---------------------------------------------------------------- findings */

/** One checklist row: condition, and the kind of damage when it is damaged. */
function ItemRow({
  item,
}: {
  item: { id: string; room: string; item: string; condition: string;
    damageType: string | null; note: string | null };
}) {
  const [condition, setCondition] = useState(item.condition);
  const needsDamageType = condition === 'damaged';

  return (
    <div className="grid gap-3 border-t border-ink-100 py-3 sm:grid-cols-[1fr_auto]">
      <div>
        <p className="text-sm font-medium text-ink-900">{item.item}</p>
        <p className="text-xs uppercase tracking-wide text-ink-400">{item.room}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
        <label className="sr-only" htmlFor={`condition:${item.id}`}>
          Condition of {item.item} in the {item.room}
        </label>
        <select
          id={`condition:${item.id}`} name={`condition:${item.id}`} value={condition}
          onChange={(e) => setCondition(e.target.value)}
          className="rounded-lg border border-ink-200 px-2 py-1.5 text-sm"
        >
          {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>

        <label className="sr-only" htmlFor={`damage:${item.id}`}>
          Kind of damage to {item.item} in the {item.room}
        </label>
        <select
          id={`damage:${item.id}`} name={`damage:${item.id}`}
          defaultValue={item.damageType ?? ''}
          required={needsDamageType}
          className="rounded-lg border border-ink-200 px-2 py-1.5 text-sm"
        >
          <option value="">
            {needsDamageType ? 'Which kind? (required)' : 'Not applicable'}
          </option>
          {DAMAGE_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>

        <label className="sr-only" htmlFor={`note:${item.id}`}>
          Note on {item.item} in the {item.room}
        </label>
        <input
          id={`note:${item.id}`} name={`note:${item.id}`} defaultValue={item.note ?? ''}
          placeholder="Note"
          className="rounded-lg border border-ink-200 px-2 py-1.5 text-sm"
        />
      </div>
    </div>
  );
}

export function FindingsForm({
  org, inspectionId, items,
}: {
  org: string; inspectionId: string;
  items: Array<{ id: string; room: string; item: string; condition: string;
    damageType: string | null; note: string | null }>;
}) {
  const [state, action, pending] = useActionState(recordFindingsAction, null);

  return (
    <Card className="p-5">
      <form action={action} className="space-y-1">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="inspectionId" value={inspectionId} />
        <h2 className="text-sm font-semibold text-ink-900">Findings</h2>
        <p className="pb-2 text-sm text-ink-500">
          Fair wear and tear is not damage. Only damage or a missing item can support a
          deposit deduction, and a deduction still needs evidence of its own.
        </p>
        <Problem state={state} title="Findings not saved" />
        {state?.ok ? (
          <p className="text-sm font-semibold text-positive-600">Findings saved.</p>
        ) : null}

        {items.map((i) => <ItemRow key={i.id} item={i} />)}

        <div className="border-t border-ink-100 pt-4">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save findings'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* -------------------------------------------------------------- finalising */

export function FinaliseInspectionForm({
  org, inspectionId, today, unchecked,
}: {
  org: string; inspectionId: string; today: string; unchecked: number;
}) {
  const [state, action, pending] = useActionState(finaliseInspectionAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Could not finalise" />
        <Button type="button" variant="primary" onClick={() => setOpen(true)}>
          Finalise this inspection
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-spike-300 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="inspectionId" value={inspectionId} />
      <Problem state={state} title="Could not finalise" />
      <p className="text-sm text-ink-700">
        Finalising closes the findings to editing. A correction afterwards creates a new
        version with a reason, and this one stays readable as it was submitted.
      </p>
      {unchecked > 0 ? (
        <p className="text-sm text-caution-700">
          {unchecked === 1 ? '1 item is' : `${unchecked} items are`} still unchecked. They will
          be finalised as not checked — which is what the record will say.
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="performedOn" label="Date performed" type="date" defaultValue={today} required />
        <Field name="attendees" label="Who was present" placeholder="T Mokoena, N Dlamini" />
        <Field
          name="keysHandedOver" label="Keys handed over"
          placeholder="2 front door, 1 gate remote"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Finalising…' : 'Finalise'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function ReviseInspectionForm({
  org, inspectionId,
}: {
  org: string; inspectionId: string;
}) {
  const [state, action, pending] = useActionState(reviseInspectionAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Could not revise" />
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Correct this inspection
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="inspectionId" value={inspectionId} />
      <Problem state={state} title="Could not revise" />
      <p className="text-sm text-ink-700">
        This creates a new draft carrying these findings forward, and marks this one
        superseded. Nothing here is altered or removed — a later dispute can still see
        exactly what was submitted and when.
      </p>
      <Field
        name="reason" label="Why it is being corrected" required
        placeholder="Resident produced the move-in photographs of the screen."
        hint="Recorded on both versions."
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Creating…' : 'Create the correction'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/* --------------------------------------------------------------- templates */

export function PublishTemplateForm({ org }: { org: string }) {
  const [state, action, pending] = useActionState(createTemplateVersionAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Could not publish the checklist" />
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Publish a checklist
        </Button>
      </div>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <h2 className="text-sm font-semibold text-ink-900">Publish a checklist</h2>
        <Problem state={state} title="Could not publish the checklist" />
        {state?.ok ? (
          <p className="text-sm font-semibold text-positive-600">Checklist published.</p>
        ) : null}
        <p className="text-sm text-ink-500">
          Using a name that already exists publishes the next version of it. Checklists are
          never edited in place: inspections already performed keep the version they were
          performed against.
        </p>
        <Field name="name" label="Name" required placeholder="Standard move-out" />
        <div className="space-y-1.5">
          <label htmlFor="items" className="block text-sm font-medium text-ink-700">
            Items, one per line
          </label>
          <textarea
            id="items" name="items" required rows={8}
            defaultValue={'Kitchen: Oven\nKitchen: Worktop\nLounge: Carpet\nBathroom: Shower screen'}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 font-mono text-sm"
          />
          <p className="text-xs text-ink-500">Room, a colon, then the item.</p>
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Publishing…' : 'Publish'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
