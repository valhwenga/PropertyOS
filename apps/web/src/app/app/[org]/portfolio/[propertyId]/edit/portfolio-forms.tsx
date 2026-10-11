'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import {
  addUnitAction, archivePropertyAction, reinstatePropertyAction, reinstateUnitAction,
  retireUnitAction, updatePropertyAction, updateUnitAction,
} from './actions';

/**
 * Correcting the portfolio, and taking something out of use.
 *
 * Kept off the property summary page on purpose: retiring a unit and renaming
 * one look alike on a screen and are not alike at all, and a form bolted onto a
 * summary hides which is which. Each of these says what it will and will not
 * do before it does it.
 */

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title }: { state: Outcome | null; title: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

/**
 * `idPrefix` is not decoration.
 *
 * Two forms on this page both have a field called `code`, and deriving the
 * element id from the name alone gave them the same id. A label then binds to
 * whichever came first, so clicking "Unit code" put the cursor in the
 * property's Code box — the field was unreachable by its own label, for a
 * screen reader as much as for a test.
 */
function Field({
  name, label, type = 'text', defaultValue, required, placeholder, hint, idPrefix = '',
}: {
  name: string; label: string; type?: string; defaultValue?: string | null;
  required?: boolean; placeholder?: string; hint?: string; idPrefix?: string;
}) {
  const id = `${idPrefix}${name}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink-700">{label}</label>
      <input
        id={id} name={name} type={type} defaultValue={defaultValue ?? ''}
        required={required} placeholder={placeholder}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      />
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

function Select({
  name, label, options, defaultValue, hint, idPrefix = '',
}: {
  name: string; label: string; options: { value: string; label: string }[];
  defaultValue?: string | null; hint?: string; idPrefix?: string;
}) {
  const id = `${idPrefix}${name}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink-700">{label}</label>
      <select
        id={id} name={name} defaultValue={defaultValue ?? ''} required
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

const PROPERTY_TYPES = [
  { value: 'house', label: 'House' },
  { value: 'cottage', label: 'Cottage' },
  { value: 'apartment', label: 'Apartment' },
  { value: 'apartment_block', label: 'Apartment block' },
  { value: 'townhouse', label: 'Townhouse' },
  { value: 'other', label: 'Other' },
];

const RENTABLE_TYPES = [
  { value: 'whole_property', label: 'The whole property' },
  { value: 'apartment', label: 'Apartment' },
  { value: 'cottage', label: 'Cottage' },
  { value: 'room', label: 'Room' },
  { value: 'other', label: 'Other' },
];

export function EditPropertyForm({
  org, propertyId, property,
}: {
  org: string; propertyId: string;
  property: {
    name: string; code: string; propertyType: string; addressLine1: string;
    addressLine2: string | null; suburb: string | null; city: string;
    province: string | null; postalCode: string | null;
  };
}) {
  const [state, action, pending] = useActionState(updatePropertyAction, null);

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="propertyId" value={propertyId} />
        <h2 className="text-sm font-semibold text-ink-900">Property details</h2>
        <p className="text-sm text-ink-500">
          Correcting these does not change anything already issued. A lease agreement records
          the address it was generated with, and a charge records the lease it was raised
          against, so fixing a street name today does not restate a document somebody signed
          last year.
        </p>
        <Problem state={state} title="Not saved" />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="name" label="Name" required defaultValue={property.name} />
          <Field
            name="code" label="Code" required defaultValue={property.code}
            hint="Appears on documents, so no two properties can share one."
          />
          <Select
            name="propertyType" label="Type" options={PROPERTY_TYPES}
            defaultValue={property.propertyType}
          />
          <Field name="addressLine1" label="Address" required defaultValue={property.addressLine1} />
          <Field name="addressLine2" label="Address, second line" defaultValue={property.addressLine2} />
          <Field name="suburb" label="Suburb" defaultValue={property.suburb} />
          <Field name="city" label="City" required defaultValue={property.city} />
          <Field name="province" label="Province" defaultValue={property.province} />
          <Field name="postalCode" label="Postal code" defaultValue={property.postalCode} />
        </div>

        <Field
          name="reason" label="Why it is being corrected"
          placeholder="The deed says Avenue; the original capture said Street."
          hint="Optional, and worth writing: the audit trail carries the before and after either way."
        />

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save the property'}
        </Button>
      </form>
    </Card>
  );
}

export function EditUnitForm({
  org, propertyId, unitId, unit, currencyCode,
}: {
  org: string; propertyId: string; unitId: string; currencyCode: string;
  unit: {
    code: string; description: string | null; rentableType: string;
    bedrooms: string; bathrooms: string; floor: string | null; floorAreaSqm: string;
    advertisedRentMajor: string;
  };
}) {
  const [state, action, pending] = useActionState(updateUnitAction, null);

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="propertyId" value={propertyId} />
        <input type="hidden" name="unitId" value={unitId} />
        <h2 className="text-sm font-semibold text-ink-900">Unit details</h2>
        <Problem state={state} title="Not saved" />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="code" label="Unit code" required defaultValue={unit.code} />
          <Select
            name="rentableType" label="What is let" options={RENTABLE_TYPES}
            defaultValue={unit.rentableType}
          />
          <Field name="bedrooms" label="Bedrooms" type="number" defaultValue={unit.bedrooms} />
          <Field name="bathrooms" label="Bathrooms" defaultValue={unit.bathrooms} />
          <Field name="floor" label="Floor" defaultValue={unit.floor} />
          <Field
            name="floorAreaSqm" label="Floor area, m²" defaultValue={unit.floorAreaSqm}
          />
          <Field
            name="advertisedRent" label={`Advertised rent (${currencyCode})`}
            defaultValue={unit.advertisedRentMajor}
            hint="A marketing figure. What a resident owes is the rent on their lease, and that is changed by a renewal — never from here."
          />
          <Field name="description" label="Description" defaultValue={unit.description} />
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save the unit'}
        </Button>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------------- out of use */

export function RetireUnitForm({
  org, propertyId, unitId, unitCode, occupiedBy,
}: {
  org: string; propertyId: string; unitId: string; unitCode: string;
  /** The live lease standing in the way, if there is one. */
  occupiedBy: { reference: string; status: string } | null;
}) {
  const [state, action, pending] = useActionState(retireUnitAction, null);
  const [open, setOpen] = useState(false);

  if (occupiedBy) {
    return (
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-ink-900">Taking it out of use</h2>
        <p className="mt-1 text-sm text-ink-700">
          Unit {unitCode} cannot be retired: lease <strong>{occupiedBy.reference}</strong> is
          still {occupiedBy.status.replace(/_/g, ' ')} on it. End or cancel the lease first —
          retiring a unit somebody is living in, or that somebody is still drafting a lease
          for, would hide the arrangement rather than end it.
        </p>
      </Card>
    );
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Not retired" />
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Retire this unit
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="unitId" value={unitId} />
      <Problem state={state} title="Not retired" />
      <p className="text-sm text-ink-700">
        Retiring is <strong>not deleting</strong>. The unit, its past leases, its charges and
        its inspections all stay exactly where they are and nothing in the ledger moves — it
        simply stops being offered for new leases. It can be put back.
      </p>
      <Field
        name="reason" label="Why it is being retired" required
        placeholder="Taken off the market pending roof repairs."
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Retire the unit'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function ReinstateUnitForm({
  org, propertyId, unitId, propertyArchived,
}: {
  org: string; propertyId: string; unitId: string; propertyArchived: boolean;
}) {
  const [state, action, pending] = useActionState(reinstateUnitAction, null);

  if (propertyArchived) {
    return (
      <Card className="p-4">
        <p className="text-sm text-ink-700">
          This unit is retired and the property itself is archived. Reinstate the property
          first, otherwise the unit would be the only live thing inside something nobody is
          managing.
        </p>
      </Card>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="unitId" value={unitId} />
      <Problem state={state} title="Not reinstated" />
      <p className="text-sm text-ink-700">
        This unit is retired. Putting it back makes it available for new leases again.
      </p>
      <Field
        name="reason" label="Why it is coming back" required
        placeholder="Roof repaired, back on the market."
      />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? 'Saving…' : 'Put the unit back'}
      </Button>
    </form>
  );
}

export function ArchivePropertyForm({
  org, propertyId, propertyName, activeUnitCount, occupiedUnitCount,
}: {
  org: string; propertyId: string; propertyName: string;
  activeUnitCount: number; occupiedUnitCount: number;
}) {
  const [state, action, pending] = useActionState(archivePropertyAction, null);
  const [open, setOpen] = useState(false);

  if (activeUnitCount > 0) {
    return (
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-ink-900">Archiving the property</h2>
        <p className="mt-1 text-sm text-ink-700">
          {propertyName} still has {activeUnitCount}{' '}
          active {activeUnitCount === 1 ? 'unit' : 'units'}
          {occupiedUnitCount > 0
            ? `, ${occupiedUnitCount} of them with a live lease`
            : ''}. Retire each unit first: archiving the property would retire them all in one
          move without anybody seeing which were still let.
        </p>
      </Card>
    );
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Not archived" />
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Archive this property
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="propertyId" value={propertyId} />
      <Problem state={state} title="Not archived" />
      <p className="text-sm text-ink-700">
        Every unit here is retired, so archiving takes the property itself out of use. Nothing
        is deleted and nothing in the ledger moves; the reports still show its history.
      </p>
      <Field
        name="reason" label="Why it is being archived" required
        placeholder="Sold to a third party on 30 June 2026."
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Archive the property'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function ReinstatePropertyForm({
  org, propertyId,
}: {
  org: string; propertyId: string;
}) {
  const [state, action, pending] = useActionState(reinstatePropertyAction, null);

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="propertyId" value={propertyId} />
      <Problem state={state} title="Not reinstated" />
      <p className="text-sm text-ink-700">
        This property is archived. Putting it back does <strong>not</strong> bring its units
        back: each was retired for its own reason, and reviving them in bulk would be the same
        mistake in the other direction. Reinstate the ones you want individually.
      </p>
      <Field
        name="reason" label="Why it is coming back" required
        placeholder="The sale fell through."
      />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? 'Saving…' : 'Put the property back'}
      </Button>
    </form>
  );
}

/**
 * Adding a unit to a property that already exists.
 *
 * `createUnit` had no screen: a property kept whatever units it was born with,
 * so an apartment block that gained a flat could never record it.
 */
export function AddUnitForm({
  org, propertyId, currencyCode,
}: {
  org: string; propertyId: string; currencyCode: string;
}) {
  const [state, action, pending] = useActionState(addUnitAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Unit not added" />
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Add a unit
        </Button>
      </div>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="propertyId" value={propertyId} />
        <h2 className="text-sm font-semibold text-ink-900">Add a unit</h2>
        <p className="text-sm text-ink-500">
          A new rentable unit in this property. Unit codes are unique within a property, and the
          advertised rent is a marketing figure — a lease sets what a resident actually owes.
        </p>
        <Problem state={state} title="Unit not added" />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field idPrefix="add-unit-" name="code" label="Unit code" required placeholder="B2" />
          <Select idPrefix="add-unit-" name="rentableType" label="What is let" options={RENTABLE_TYPES}
            defaultValue="apartment" />
          <Field idPrefix="add-unit-" name="bedrooms" label="Bedrooms" type="number" />
          <Field idPrefix="add-unit-" name="bathrooms" label="Bathrooms" />
          <Field
            idPrefix="add-unit-" name="advertisedRent"
            label={`Advertised rent (${currencyCode})`} placeholder="6500.00"
          />
          <Field idPrefix="add-unit-" name="description" label="Description" />
        </div>

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Adding…' : 'Add the unit'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
