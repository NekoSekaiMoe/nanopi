import { useState } from 'preact/hooks';
import { pairWithCode } from '../api';
import { useT } from '../settings';

/**
 * Pairing page: `nanopi webui` prints a short one-time code instead of a long
 * token URL; entering it here exchanges the code (POST /extra/pair) for the
 * session bearer token. Builds without the extra module print the token URL,
 * which the SPA still accepts via ?token=.
 */
export function AuthRequired() {
  const t = useT();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await pairWithCode(code.trim());
      window.location.reload();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setBusy(false);
    }
  }

  return (
    <div class="auth-required">
      <div class="auth-required-card">
        <h1>{t('auth.required.title')}</h1>
        <p>{t('auth.required.body')}</p>
        <form class="auth-pair-form" onSubmit={submit}>
          <input
            class="auth-pair-input"
            type="text"
            value={code}
            placeholder={t('auth.pair.input')}
            autocomplete="off"
            autocapitalize="characters"
            spellcheck={false}
            maxlength={16}
            onInput={(e) => setCode((e.target as HTMLInputElement).value)}
            disabled={busy}
          />
          <button class="btn btn-primary" type="submit" disabled={busy || !code.trim()}>
            {busy ? t('auth.pair.submitting') : t('auth.pair.submit')}
          </button>
        </form>
        {error && <p class="auth-pair-error">{t('auth.pair.failed', { error })}</p>}
        <p class="auth-required-hint">{t('auth.required.hint')}</p>
      </div>
    </div>
  );
}
