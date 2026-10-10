import React, { useState } from 'react';
import { adminApi, CurrentUser, saveTokens } from '../api/client';

export function AuthPanel({ user, onSignedIn, onClose }: { user: CurrentUser | null; onSignedIn: (user: CurrentUser | null) => void; onClose: () => void }) {
  const [register, setRegister] = useState(false);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganization] = useState('');
  const [email, setEmail] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpAuthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      if (user && setup) {
        await adminApi.activateMfa(setup.secret, code); await adminApi.logout(); onSignedIn(null);
        setSetup(null); setNotice('MFA enabled. Sign in again with your authenticator.'); return;
      }
      if (register) {
        await adminApi.register({ organizationName, email, username: identifier, password });
        setRegister(false); setPassword(''); setNotice('Workspace created. Sign in to enroll your first device.'); return;
      }
      const result = mfaToken ? await adminApi.verifyMfa(mfaToken, code) : await adminApi.login(identifier, password);
      if (result.mfaRequired) { setMfaToken(result.mfaToken); setPassword(''); return; }
      saveTokens(result, remember); onSignedIn(await adminApi.me()); onClose();
    } catch (error) { setError(error instanceof Error ? error.message : 'Authentication failed.'); }
    finally { setBusy(false); }
  }
  return <section className="auth-panel glass-panel" aria-label="Workspace account">
    <button type="button" className="auth-close" onClick={onClose} aria-label="Close account panel">×</button>
    <h2>{user ? 'Your account' : register ? 'Create a workspace' : mfaToken ? 'Verify your identity' : 'Sign in to your workspace'}</h2>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {user && !setup ? <>
      <p>{user.email}</p><p>{user.organization.name}</p>
      <p>Multi-factor authentication: {user.mfaEnabled ? 'Enabled' : 'Not enabled'}</p>
      {!user.mfaEnabled && <button disabled={busy} onClick={async () => { setBusy(true); try { setSetup(await adminApi.setupMfa()); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>Set up authenticator</button>}
      <button onClick={async () => { await adminApi.logout(); onSignedIn(null); onClose(); }}>Sign out</button>
    </> : <form onSubmit={submit}>
      {setup ? <><p>Add this secret to your authenticator app, then enter its code.</p><code>{setup.secret}</code></> : !mfaToken && <>
        {register && <><label>Workspace name<input required maxLength={128} value={organizationName} onChange={e => setOrganization(e.target.value)} /></label><label>Email<input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label></>}
        <label>{register ? 'Username' : 'Email or username'}<input required autoComplete="username" maxLength={254} value={identifier} onChange={e => setIdentifier(e.target.value)} /></label>
        <label>Password<input required type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 12 : 1} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} /></label>
        {!register && <label className="auth-remember"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Keep me signed in on this computer</label>}
      </>}
      {(mfaToken || setup) && <label>Authenticator code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value)} /></label>}
      <button type="submit" disabled={busy}>{busy ? 'Please wait…' : setup ? 'Enable MFA' : register ? 'Create workspace' : mfaToken ? 'Verify' : 'Sign in'}</button>
      {!mfaToken && !setup && <button type="button" onClick={() => { setRegister(!register); setError(''); }}>{register ? 'Use an existing workspace' : 'Create a new workspace'}</button>}
      {mfaToken && <button type="button" onClick={() => { setMfaToken(''); setCode(''); }}>Start again</button>}
    </form>}
  </section>;
}
