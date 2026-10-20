import { Button, Checkbox, IconButton, Input } from '../ui/primitives.jsx';
import { DsIcon, Icon } from '../ui/Icon.jsx';
import { Select } from '../ui/Select.jsx';
import { ExpressionInput } from './ExpressionInput.jsx';

/** Operators that take no right-hand value, so the field is hidden for them. */
const NO_RIGHT_SIDE = ['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'];

/**
 * Parameter form, generated from each node's `params` descriptors so adding a
 * node type does not mean writing a bespoke form.
 *
 * Labels are sentence case on purpose. The design system's `.label-*` classes
 * uppercase their text, which is right for a micro-label and wrong for a form
 * where the label IS the documentation — "Field to split out" in capitals reads
 * as shouting and loses its word shapes.
 */
export function ParamField({ descriptor, value, onChange, exprContext }) {
  const id = `param-${descriptor.name}`;
  const label = (
    <label className="ca-field-label body-xsmall" htmlFor={id}>
      {descriptor.label}
    </label>
  );

  const hint = descriptor.hint
    ? <p className="ca-field-hint body-xxsmall">{descriptor.hint}</p>
    : null;

  switch (descriptor.type) {
    case 'boolean':
      return (
        <div className="ca-field">
          <Checkbox
            label={descriptor.label}
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            size="xsmall"
          />
          {hint}
        </div>
      );

    case 'options':
      return (
        <div className="ca-field">
          {label}
          <Select
            value={value ?? descriptor.options[0]}
            options={descriptor.options}
            onChange={onChange}
          />
          {hint}
        </div>
      );

    case 'number':
      return (
        <div className="ca-field">
          {label}
          <Input
            id={id}
            type="number"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          />
          {hint}
        </div>
      );

    case 'conditions':
      return (
        <fieldset className="ca-field ca-fieldset">
          <legend className="ca-field-label body-xsmall">{descriptor.label}</legend>
          <ConditionList
            conditions={value || []}
            operators={descriptor.operators}
            onChange={onChange}
            exprContext={exprContext}
          />
          {hint}
        </fieldset>
      );

    case 'rules':
      return (
        <fieldset className="ca-field ca-fieldset">
          <legend className="ca-field-label body-xsmall">{descriptor.label}</legend>
          <RuleList
            rules={value || []}
            operators={descriptor.operators}
            onChange={onChange}
            exprContext={exprContext}
          />
          {hint}
        </fieldset>
      );

    case 'sortFields':
      return (
        <fieldset className="ca-field ca-fieldset">
          <legend className="ca-field-label body-xsmall">{descriptor.label}</legend>
          <SortFieldList rows={value || []} onChange={onChange} />
          {hint}
        </fieldset>
      );

    case 'fields':
      return (
        <fieldset className="ca-field ca-fieldset">
          <legend className="ca-field-label body-xsmall">{descriptor.label}</legend>
          <KeyValueList rows={value || []} onChange={onChange} exprContext={exprContext} />
          {hint}
        </fieldset>
      );

    case 'fieldNames':
      return (
        <fieldset className="ca-field ca-fieldset">
          <legend className="ca-field-label body-xsmall">{descriptor.label}</legend>
          <StringList values={value || []} onChange={onChange} placeholder="field name" />
          {hint}
        </fieldset>
      );

    case 'aggregations':
      return (
        <fieldset className="ca-field ca-fieldset">
          <legend className="ca-field-label body-xsmall">{descriptor.label}</legend>
          <AggregationList rows={value || []} onChange={onChange} />
          {hint}
        </fieldset>
      );

    case 'string':
    default:
      return (
        <div className="ca-field">
          {label}
          <ExpressionInput
            id={id}
            value={value}
            onChange={onChange}
            placeholder={descriptor.placeholder}
            multiline={descriptor.multiline}
            {...exprContext}
          />
          {hint}
        </div>
      );
  }
}

/** Remove-row button: a trash icon, named for screen readers. */
function RemoveButton({ label, onClick }) {
  return (
    <IconButton label={label} onClick={onClick} size="small" tone="danger" className="ca-row-remove">
      <DsIcon name="trash" />
    </IconButton>
  );
}

/** A full-width "+ Add …" button under a list of rows. */
function AddButton({ children, onClick }) {
  return (
    <Button variant="secondary" size="xsmall" className="ca-add-row" onClick={onClick}>
      <Icon name="plus" size={14} />
      <span>{children}</span>
    </Button>
  );
}

function ConditionList({ conditions, operators, onChange, exprContext }) {
  const update = (index, patch) => onChange(conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)));

  return (
    <>
      {conditions.map((condition, index) => (
        // Index keys are safe here: rows are only appended or removed wholesale.
        // eslint-disable-next-line react/no-array-index-key
        <div className="ca-row-card" key={index}>
          <div className="ca-row-card-head">
            <span className="ca-row-card-title body-xxsmall">{`Condition ${index + 1}`}</span>
            <RemoveButton
              label={`Remove condition ${index + 1}`}
              onClick={() => onChange(conditions.filter((_, i) => i !== index))}
            />
          </div>

          <ExpressionInput
            value={condition.left}
            onChange={(v) => update(index, { left: v })}
            placeholder="={{ $json.field }}"
            ariaLabel={`Condition ${index + 1} value`}
            {...exprContext}
          />

          <div className="ca-row-split">
            <div className="ca-row-split-op">
              <Select
                value={condition.op}
                options={operators}
                onChange={(op) => update(index, { op })}
              />
            </div>
            {NO_RIGHT_SIDE.includes(condition.op) ? null : (
              <div className="ca-row-split-value">
                <ExpressionInput
                  value={condition.right}
                  onChange={(v) => update(index, { right: coerce(v) })}
                  placeholder="value"
                  ariaLabel={`Condition ${index + 1} compare to`}
                  {...exprContext}
                />
              </div>
            )}
          </div>
        </div>
      ))}

      <AddButton
        onClick={() => onChange([...conditions, { left: '={{ $json.field }}', op: 'equals', right: '' }])}
      >
        Add condition
      </AddButton>
    </>
  );
}

/**
 * Switch's routing rules: a condition plus the name of the output it routes to.
 *
 * The output name is the thing that makes Switch worth using over a chain of
 * Ifs, so it sits at the top of each rule rather than tucked underneath — the
 * canvas shows it as a port label, and the candidate should see the connection
 * between what they type here and what appears on the node.
 */
function RuleList({ rules, operators, onChange, exprContext }) {
  const update = (index, patch) => onChange(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <>
      {rules.map((rule, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div className="ca-row-card" key={index}>
          <div className="ca-row-card-head">
            <span className="ca-row-card-title body-xxsmall">{`Rule ${index + 1}`}</span>
            <RemoveButton
              label={`Remove rule ${index + 1}`}
              onClick={() => onChange(rules.filter((_, i) => i !== index))}
            />
          </div>

          <div className="ca-row-inline">
            <span className="ca-row-inline-label body-xxsmall">Output</span>
            <Input
              value={rule.output || ''}
              onChange={(e) => update(index, { output: e.target.value })}
              placeholder="output name, e.g. EU"
              aria-label={`Rule ${index + 1} output name`}
            />
          </div>

          <ExpressionInput
            value={rule.left}
            onChange={(v) => update(index, { left: v })}
            placeholder="={{ $json.field }}"
            ariaLabel={`Rule ${index + 1} value`}
            {...exprContext}
          />

          <div className="ca-row-split">
            <div className="ca-row-split-op">
              <Select
                value={rule.op || 'equals'}
                options={operators}
                onChange={(op) => update(index, { op })}
              />
            </div>
            {NO_RIGHT_SIDE.includes(rule.op) ? null : (
              <div className="ca-row-split-value">
                <ExpressionInput
                  value={rule.right}
                  onChange={(v) => update(index, { right: coerce(v) })}
                  placeholder="value"
                  ariaLabel={`Rule ${index + 1} compare to`}
                  {...exprContext}
                />
              </div>
            )}
          </div>
        </div>
      ))}

      <AddButton
        onClick={() => onChange([...rules, { output: '', left: '={{ $json.field }}', op: 'equals', right: '' }])}
      >
        Add rule
      </AddButton>
    </>
  );
}

function SortFieldList({ rows, onChange }) {
  const update = (index, patch) => onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <>
      {rows.map((row, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div className="ca-row" key={index}>
          <Input
            className="ca-row-grow"
            value={row.field || ''}
            onChange={(e) => update(index, { field: e.target.value })}
            placeholder="field name"
            aria-label={`Sort field ${index + 1}`}
          />
          <div className="ca-row-fixed">
            <Select
              value={row.order || 'ascending'}
              options={['ascending', 'descending']}
              onChange={(order) => update(index, { order })}
            />
          </div>
          <RemoveButton
            label={`Remove sort field ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      <AddButton onClick={() => onChange([...rows, { field: '', order: 'ascending' }])}>
        Add sort field
      </AddButton>
    </>
  );
}

function KeyValueList({ rows, onChange, exprContext }) {
  const update = (index, patch) => onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <>
      {rows.map((row, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div className="ca-row-card" key={index}>
          <div className="ca-row">
            <Input
              className="ca-row-grow"
              value={row.name || ''}
              onChange={(e) => update(index, { name: e.target.value })}
              placeholder="name"
              aria-label={`Field ${index + 1} name`}
            />
            <RemoveButton
              label={`Remove field ${index + 1}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            />
          </div>
          <ExpressionInput
            value={row.value}
            onChange={(v) => update(index, { value: coerce(v) })}
            placeholder="value or ={{ expression }}"
            ariaLabel={`Field ${index + 1} value`}
            {...exprContext}
          />
        </div>
      ))}
      <AddButton onClick={() => onChange([...rows, { name: '', value: '' }])}>
        Add field
      </AddButton>
    </>
  );
}

function StringList({ values, onChange, placeholder }) {
  return (
    <>
      {values.map((value, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div className="ca-row" key={index}>
          <Input
            className="ca-row-grow"
            value={value}
            onChange={(e) => onChange(values.map((v, i) => (i === index ? e.target.value : v)))}
            placeholder={placeholder}
            aria-label={`${placeholder} ${index + 1}`}
          />
          <RemoveButton
            label={`Remove ${placeholder} ${index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      <AddButton onClick={() => onChange([...values, ''])}>Add field</AddButton>
    </>
  );
}

const AGGREGATION_OPS = ['count', 'sum', 'avg', 'min', 'max', 'concat'];

function AggregationList({ rows, onChange }) {
  const update = (index, patch) => onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  return (
    <>
      {rows.map((row, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div className="ca-row-card" key={index}>
          <div className="ca-row-card-head">
            <span className="ca-row-card-title body-xxsmall">{`Output ${index + 1}`}</span>
            <RemoveButton
              label={`Remove output ${index + 1}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            />
          </div>
          <div className="ca-row">
            <div className="ca-row-fixed">
              <Select
                value={row.op || 'count'}
                options={AGGREGATION_OPS}
                onChange={(op) => update(index, { op })}
              />
            </div>
            <Input
              className="ca-row-grow"
              value={row.field || ''}
              onChange={(e) => update(index, { field: e.target.value })}
              placeholder={row.op === 'count' ? 'no field needed' : 'field to aggregate'}
              disabled={row.op === 'count'}
              aria-label={`Output ${index + 1} source field`}
            />
          </div>
          <div className="ca-row-inline">
            <span className="ca-row-inline-label body-xxsmall">Save as</span>
            <Input
              value={row.as || ''}
              onChange={(e) => update(index, { as: e.target.value })}
              placeholder="output field name"
              aria-label={`Output ${index + 1} name`}
            />
          </div>
        </div>
      ))}
      <AddButton onClick={() => onChange([...rows, { as: '', op: 'count' }])}>
        Add output
      </AddButton>
    </>
  );
}

/** Keep numbers as numbers so comparison operators behave as candidates expect. */
function coerce(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('=')) return value;
  const trimmed = value.trim();
  if (trimmed !== '' && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return value;
}
