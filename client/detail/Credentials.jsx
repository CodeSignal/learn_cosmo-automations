import { useState } from 'react';
import { Button, IconButton, Input } from '../ui/primitives.jsx';
import { DsIcon, Icon } from '../ui/Icon.jsx';
import { Select } from '../ui/Select.jsx';
import { Modal } from '../ui/Modal.jsx';

/**
 * The credentials dialog.
 *
 * Candidates create their own credentials here rather than picking a ready-made
 * one out of a dropdown. Picking the only item in a list tests nothing; creating
 * a credential tests three things they will need on the job — which type a node
 * wants, that the secret goes in a specific named field, and what a 401 means
 * when they get it wrong.
 *
 * The secret is masked by default, with a reveal, because someone demoing this on
 * a projector should not have to think about it — and because masking makes it
 * obvious the value is a secret rather than a label.
 */
export function CredentialsModal({
  open, onClose, credentialTypes, credentials, onAdd, onUpdate, onRemove, initialType,
}) {
  return (
    <Modal open={open} onClose={onClose} title="Credentials" size="medium" layout="form">
      <CredentialsPanel
        credentialTypes={credentialTypes}
        credentials={credentials}
        onAdd={onAdd}
        onUpdate={onUpdate}
        onRemove={onRemove}
        initialType={initialType}
      />
    </Modal>
  );
}

function CredentialsPanel({
  credentialTypes, credentials, onAdd, onUpdate, onRemove, initialType,
}) {
  const [openId, setOpenId] = useState(null);
  const [newType, setNewType] = useState(initialType || (credentialTypes[0] || {}).name || '');

  if (!credentialTypes.length) {
    return (
      <div className="ca-credentials">
        <p className="ca-credentials-intro body-small">
          This task declares no credential types, so nothing here needs one.
        </p>
      </div>
    );
  }

  const typeOf = (name) => credentialTypes.find((t) => t.name === name);

  const create = () => {
    const type = typeOf(newType);
    const created = onAdd({
      type: newType,
      name: type ? type.label : newType,
      fields: Object.fromEntries((type ? type.fields : []).map((f) => [f.name, ''])),
    });
    if (created) setOpenId(created);
  };

  return (
    <div className="ca-credentials">
      <p className="ca-credentials-intro body-xsmall">
        A node can only use a credential of the type it asks for. Values are held
        with your workflow and sent to the service — never shown in the report.
      </p>

      <div className="ca-credentials-section" aria-label="Your credentials">
        {credentials.length === 0 ? (
          <div className="ca-credentials-empty body-xsmall">
            <Icon name="key" />
            <span>No credentials yet. Create the one the task needs below.</span>
          </div>
        ) : (
          <ul className="ca-credentials-list">
            {credentials.map((credential) => {
              const type = typeOf(credential.type);
              const expanded = openId === credential.id;
              const missing = type && (type.fields || [])
                .some((f) => !String(credential.fields?.[f.name] ?? '').trim());
              return (
                <li className={`ca-credential${expanded ? ' is-open' : ''}`} key={credential.id}>
                  <div className="ca-credential-row">
                    <span className="ca-credential-icon" aria-hidden="true"><Icon name="key" /></span>
                    <span className="ca-credential-text">
                      <span className="ca-credential-name body-small">{credential.name}</span>
                      <span className="ca-credential-type body-xxsmall">
                        {type ? type.label : credential.type}
                        {missing ? ' · not filled in yet' : ''}
                      </span>
                    </span>
                    <Button
                      variant="secondary"
                      size="xsmall"
                      onClick={() => setOpenId(expanded ? null : credential.id)}
                      aria-expanded={expanded}
                    >
                      {expanded ? 'Done' : 'Edit'}
                    </Button>
                    <IconButton
                      label={`Delete ${credential.name}`}
                      tone="danger"
                      onClick={() => onRemove(credential.id)}
                    >
                      <DsIcon name="trash" />
                    </IconButton>
                  </div>

                  {expanded ? (
                    <CredentialFields
                      credential={credential}
                      type={type}
                      onUpdate={(patch) => onUpdate(credential.id, patch)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="ca-credentials-create" aria-label="Create a credential">
        <span className="ca-field-label body-xsmall">Create a credential</span>
        <div className="ca-row">
          <div className="ca-row-grow">
            <Select
              value={newType}
              options={credentialTypes.map((t) => ({ value: t.name, label: t.label || t.name }))}
              onChange={setNewType}
            />
          </div>
          <Button variant="primary" size="small" onClick={create}>
            <Icon name="plus" size={14} />
            <span>Create</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

function CredentialFields({ credential, type, onUpdate }) {
  const [revealed, setRevealed] = useState({});

  if (!type) {
    return (
      <p className="ca-field-hint body-xxsmall">
        This task no longer declares a &ldquo;{credential.type}&rdquo; credential type.
      </p>
    );
  }

  const setField = (name, value) => onUpdate({ fields: { ...credential.fields, [name]: value } });

  return (
    <div className="ca-credential-form">
      <div className="ca-field">
        <label className="ca-field-label body-xsmall" htmlFor={`cred-${credential.id}-name`}>Name</label>
        <Input
          id={`cred-${credential.id}-name`}
          value={credential.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
        />
      </div>

      {(type.fields || []).map((field) => {
        const id = `cred-${credential.id}-${field.name}`;
        const secret = field.type === 'password';
        return (
          <div className="ca-field" key={field.name}>
            <label className="ca-field-label body-xsmall" htmlFor={id}>{field.label || field.name}</label>
            <div className="ca-row">
              <Input
                id={id}
                className="ca-row-grow"
                mono={secret}
                type={secret && !revealed[field.name] ? 'password' : 'text'}
                value={credential.fields[field.name] ?? ''}
                onChange={(e) => setField(field.name, e.target.value)}
                placeholder={field.placeholder}
                autoComplete="off"
                spellCheck={false}
              />
              {secret ? (
                <IconButton
                  label={revealed[field.name] ? 'Hide value' : 'Show value'}
                  onClick={() => setRevealed((r) => ({ ...r, [field.name]: !r[field.name] }))}
                >
                  <Icon name={revealed[field.name] ? 'eye-off' : 'eye'} />
                </IconButton>
              ) : null}
            </div>
            {field.hint ? <p className="ca-field-hint body-xxsmall">{field.hint}</p> : null}
          </div>
        );
      })}

      {type.docs ? <p className="ca-field-hint body-xxsmall">{type.docs}</p> : null}
    </div>
  );
}
